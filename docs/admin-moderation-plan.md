# Bleya — Moderation Backend & Admin Panel: Implementation Plan

**Status:** Draft plan, not yet started. Review before implementation.
**Last updated:** June 16, 2026

## Goal

Make Bleya able to actually moderate. Today users can *report* and *block*, but there is
no operator-side capability at all — so the Terms of Service ("we may remove content / suspend
or terminate accounts") and Apple App Store Guideline 1.2 (UGC apps must act on objectionable
content within ~24h: remove content + eject the user) are currently aspirational. This plan
builds the missing **act-on** backend and a thin **admin panel** on top of it, and closes two
real GDPR/ZZPL gaps (email-channel data requests; reports retained after account deletion).

Scope priorities, in order: (1) make the ToS claims true, (2) pass Apple 1.2, (3) handle emailed
GDPR/ZZPL requests. The app is worldwide; the company is Serbia-based.

## Current state (verified against code)

- Intake works: blocking ([UserBlock](../models/UserBlock.ts), `/rooms/direct/:id/block`) and
  reporting users/rooms/messages ([Report](../models/Report.ts), [routes/reports.ts](../routes/reports.ts)).
- No admin concept: JWT carries only `userId` ([middleware/auth.ts:26](../middleware/auth.ts#L26));
  no `/admin` router (sub-routes registered at [server/app.ts:24-29](../server/app.ts#L24)).
- Report model is **write-only**: status enum + queue indexes exist
  ([Report.ts:11](../models/Report.ts#L11), `:52-55`) but `reportService` only has `createReport`.
- No single-message removal: message routes are read-only; the only `Message.deleteMany` is in
  the self-account cascade ([accountService.ts:299](../services/accountService.ts#L299)).
- No ban/suspend: `User` has no role/status field; only self-service `DELETE /me`.
- Deletion cascade skips `Report` ([accountService.ts:262+](../services/accountService.ts#L262)),
  leaving reporter/reported IDs dangling after erasure (Art.17 gap).
- Auth: refresh-token hash on the User doc (single session); access tokens are short-TTL and
  deliberately **not** revocable (accepted risk); sockets authed at
  [socket.ts:249](../server/socket.ts#L249), routed by `user:{userId}`.

Good news: read-heavy work is half-built — `exportUserData(userId)` and `deleteUserAccount(userId)`
already exist and take a userId ([accountService.ts:90,262](../services/accountService.ts#L90)),
and the report-queue indexes exist. The genuinely new backend is small.

## Auth approach

**Now (easiest):** a shared admin secret in an env var.
- Add `ADMIN_API_KEY` to config/env.
- New `requireAdmin` middleware (layers after `authenticateUser` or stands alone) compares an
  `x-admin-key` header to `config.adminApiKey` using a constant-time compare; 403 otherwise.
- Usable from Postman/curl immediately and from the web panel later (behind a password screen).
- Audit log records actor as `"admin:env-key"` (no per-person attribution — fine while solo).

**Later (when a 2nd moderator or the web UI lands):** add `role: 'user'|'moderator'|'admin'`
to `User`, and have `requireAdmin` also accept a logged-in user whose role is admin/moderator
(role loaded from DB in the middleware — do **not** re-issue JWTs). Then actions attribute to a
real `userId`. The guard supports **either** mechanism, so this is additive.

## Backend work (build in this order; each step gated by the previous)

### Step 1 — Admin gate
- `config`: add `adminApiKey`.
- `middleware/auth.ts`: add `requireAdmin`.
- New `routes/admin.ts`; register `apiV1Router.use('/admin', adminRoutes)` at
  [server/app.ts:29](../server/app.ts#L29). Base path: `/v1/admin`.
- All admin routes behind `requireAdmin` (+ a dedicated rate limiter).
- `scripts/`: one-off to seed/verify (no-op for env-key; for the later role path, set a user's role).

### Step 2 — Audit log (build early so every later step writes to it)
- New model `models/ModerationAction.ts`: `{ actorId|actorLabel, action, targetType, targetId,
  reportId?, reason, metadata, createdAt }`. Indexes on `targetId` and `createdAt`. Append-only
  (no update/delete routes).
- New `services/auditService.ts`: `recordAction(...)`. Called by every mutation below.
- Endpoint: `GET /v1/admin/audit` (filter by targetId/actorId, paginated).

### Step 3 — Report queue + status workflow
- `models/Report.ts`: add `reviewedBy`, `reviewedAt`, `resolutionNote`.
- `services/reportService.ts`: add `listReports({status,reason,targetType}, cursor)` (uses the
  existing `{status,createdAt}` index), `getReport(id)` (populate reporter + target user/room/message),
  `updateReportStatus(id, status, actor, note)` → also writes audit log.
- Endpoints: `GET /v1/admin/reports`, `GET /v1/admin/reports/:id`, `PATCH /v1/admin/reports/:id`.
- "View content in context" — admin-only message fetch that **bypasses** the membership gate
  (`assertCanAccessMessageRoom`): pull N messages around `report.messageId` (createdAt window in
  the room); for user/room reports, recent messages by that user / in that room. Reuse
  `formatMessage` + `buildUsernameMap`.

### Step 4 — Message soft-delete + restore  ⚠️ highest-risk step
- `models/Message.ts`: add `deletedAt`, `deletedBy`, `deleteReason` (soft, not hard — enables restore).
- **Exclude `deletedAt: null` from EVERY display read path** (miss one and deleted content reappears):
  - [services/roomService.ts:289](../services/roomService.ts#L289) — last-message aggregate (`$match`)
  - [services/roomService.ts:334](../services/roomService.ts#L334) — unread-count aggregate (`$match`)
  - [services/roomService.ts:473](../services/roomService.ts#L473) — room messages `find`
  - [services/roomService.ts:739](../services/roomService.ts#L739) — messages `find`
  - [routes/messages.ts:45](../routes/messages.ts#L45) — thread parent `findById`
  - [routes/messages.ts:51](../routes/messages.ts#L51) — thread replies `find`
  - [routes/messages.ts:79](../routes/messages.ts#L79) — single message `findById`
  - [repositories/messageRepository.ts:49](../repositories/messageRepository.ts#L49) — `findById`
  - [repositories/messageRepository.ts:60](../repositories/messageRepository.ts#L60) — `find`
  - (Leave the account-export read at [accountService.ts:134](../services/accountService.ts#L134) and
    the cascade count at `:303` as-is — export = the user's own data; cascade = deletion logic.)
- Thread integrity: recompute `replyCount` when a parent/reply is removed (reuse cascade logic).
- Emit a Socket.IO `message_removed` event to the room so live clients drop it.
- Endpoints: `DELETE /v1/admin/messages/:id` (soft), `POST /v1/admin/messages/:id/restore`. Both audit-logged.

### Step 5 — User enforcement (suspend / ban)
- `models/User.ts`: add `status: 'active'|'suspended'|'banned'` (default `active`), `suspendedUntil`,
  `enforcementReason`.
- Enforce in **both** gates (or a ban does nothing):
  - HTTP send path: in `messageService.createMessage` (reject banned/suspended).
  - Socket handshake: at [socket.ts:249-268](../server/socket.ts#L249) (reject on connect). **Keep the
    `"Authentication error"` socket error prefix** — mobile token-refresh depends on it.
- On ban: clear `refreshTokenHash`/`refreshTokenExpiresAt` (kills session renewal) and
  `io.in('user:'+id).disconnectSockets(true)` (drops live sockets). Access token stays valid until
  its short TTL expires — consistent with the accepted non-revocable-access-token design.
- Endpoints: `POST /v1/admin/users/:id/ban`, `/unban`, `/suspend` (with `suspendedUntil`). Audit-logged.

### Step 6 — User search + 360 view
- New `services/adminUserService.ts`: search by id (`User.findById`), username
  (case-insensitive regex, reuse `roomService.escapeRegex`), and provider email
  (`UserIdentity` `{email,emailVerified}` index → join to User).
- 360 view: adapt `exportUserData(userId)` to an **admin DTO** (add Mongo ids, ban status,
  PushToken health, reports for/against, block counts; show blocker identity that the user-facing
  export withholds). Read-only.
- Endpoints: `GET /v1/admin/users?q=`, `GET /v1/admin/users/:id`.

### Step 7 — Admin-initiated DSAR + report anonymization
- Wrap existing `exportUserData(userId)` and `deleteUserAccount(userId)` in admin endpoints
  (verify requester identity against a verified `UserIdentity.email` first; audit-log the access):
  `GET /v1/admin/users/:id/export`, `DELETE /v1/admin/users/:id`.
- Report anonymization on deletion: in `deleteUserAccount`, anonymize `reporterUserId`/
  `reportedUserId` on dangling Reports (keep `reason`/`details` for safety/legal) and set a
  `retainUntil` (decision below). A scheduled purge can come later.

## Admin panel (UI) — last, thin layer

- **Three screens** cover the MVP:
  1. **Report queue** → detail (with content-in-context) → action buttons (delete message / ban user
     / dismiss, each with a note).
  2. **User lookup → 360 view** → ban / suspend / export / erase.
  3. **Audit log** (flat list).
- Tech: one small protected internal web app (Vite + React or server-rendered). **Not** a second
  mobile app, **not** a heavy admin framework. Auth = the env key behind a password screen (or the
  role-based login later). Calls `/v1/admin/*`.
- Drive every endpoint with **Postman/curl first** — you are Apple-1.2-defensible with protected
  REST endpoints and no GUI at all, since you are the only operator. Build the GUI after the backend works.

## Feature summary

**MVP (launch / Apple 1.2 / email DSARs):** admin gate, audit log, report queue + status workflow,
content-in-context view, message soft-delete + restore, user suspend/ban (both gates + session kill),
user search + 360, admin export/erase + report anonymization.

**v2:** account termination, bulk actions (spam bursts), repeat-offender/block-velocity signals,
clear/fix abusive profile (admin variant of [userService.updateProfile](../services/userService.ts#L79)),
rectification on request, email-DSR/abuse tracker with SLA clocks, force-logout, ops counts dashboard
(open-report backlog = the 24h SLA view), warn-before-ban (needs a `system` Notification type — enum is
[`['reply']`](../models/Notification.ts#L16) today).

**Later:** room/city management, push announcements/broadcast, push delivery debugging, passkey
list/revoke, automated spam/abuse triage, profanity filter at send, mute tier, law-enforcement request
register, DOB/age capture + underage workflow, audit-log viewer/export, time-to-action metrics.

**Deliberately skip (overkill now):** AI content classification, shadow-banning, full RBAC matrix,
login-as-user impersonation, billing tooling (app is free), message full-text search, hash-chained
audit log, JWT role re-issue, access-token revocation.

## Endpoint reference (MVP)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/admin/reports` | List/filter the moderation queue |
| GET | `/v1/admin/reports/:id` | Report detail + content in context |
| PATCH | `/v1/admin/reports/:id` | Set status (reviewed/actioned/dismissed) + note |
| DELETE | `/v1/admin/messages/:id` | Soft-delete a message |
| POST | `/v1/admin/messages/:id/restore` | Restore a soft-deleted message |
| GET | `/v1/admin/users?q=` | Search users (id/username/email) |
| GET | `/v1/admin/users/:id` | User 360 view |
| POST | `/v1/admin/users/:id/ban` · `/unban` · `/suspend` | Enforcement |
| GET | `/v1/admin/users/:id/export` | Admin Art.15 export |
| DELETE | `/v1/admin/users/:id` | Admin Art.17 erasure |
| GET | `/v1/admin/audit` | Audit log |

## Data-model changes

- **User:** `status`, `suspendedUntil`, `enforcementReason` (+ later: `role`).
- **Message:** `deletedAt`, `deletedBy`, `deleteReason`.
- **Report:** `reviewedBy`, `reviewedAt`, `resolutionNote`, `retainUntil`.
- **Notification (v2):** add `system` to the type enum.
- **New:** `ModerationAction` (audit log).

## Testing

- Postman/curl for each endpoint first.
- Unit/integration tests per changed file. **Run changed files in isolation** — the full suite
  flakes on db-server contention (known issue).
- Soft-delete regression: assert a deleted message disappears from every read path enumerated in Step 4.
- Ban regression: assert a banned user is rejected on both HTTP send and socket connect, and that
  existing sockets are dropped.

## Effort

Backend MVP ~1.5–2.5 weeks (soft-delete read-path sweep and ban-at-both-gates are the fiddly bits;
report status/queue and the export/erase wrappers are fast). Minimal web UI ~3–5 days on top.

## Open decisions

- **Report retention window** after account deletion (e.g. 6–12 months under legitimate interest) —
  set `retainUntil` accordingly; document the lawful basis.
- **Suspend tiers** — temporary (`suspendedUntil`) vs permanent ban only for MVP.
- **Moderator role** — env key only for launch; add `role` when a 2nd person needs access.
- Cross-refs: ties into the pending GDPR Art.27 EU representative and the reports-retention to-do
  in the legal docs.
