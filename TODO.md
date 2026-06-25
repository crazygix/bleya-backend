# TODO - Backend

> **AI INSTRUCTIONS:** This file tracks pending work for the Bleya backend.
> - When the user asks "what's left to do?" or similar, read this file and summarize open items.
> - **Do NOT start, implement, or modify any item below without explicit approval from the user.**
> - When an item is completed, remove it from this file.
> - A matching `TODO.md` exists in the mobile repo.

---

## Open

### 1. Human-readable errors
Audit all errors returned by the backend that can surface to the end user and ensure they are human-readable.
- Review all API error responses reaching the client
- Replace technical/stacktrace-style messages with user-friendly copy
- Standardize error payload shape (code + user-safe message)
- Ensure internal errors are logged but never leaked to the client

### 2. Legal / policies before go-live
Backend-side requirements to support legal compliance.
- [x] Account deletion endpoint — `DELETE /v1/users/me` (hard-delete cascade across all collections, R2 image purge, refresh cookie cleared). Required by Apple App Store and Google Play.
- [x] Data export endpoint — `GET /v1/users/me/export` (GDPR right to access; returns JSON).
- [x] PII audit — documented in `services/accountService.ts` (account, messages, rooms, DM participants, blocks, notifications, passkeys, identities, auth challenges, push tokens, profile image in R2).
- [ ] Terms-acceptance tracking (if required) — not implemented.
- [ ] Privacy Policy retention guarantees — confirm copy matches actual data lifecycles, document any backups/log retention.
- [ ] Confirm DM "other participant" display when their counterpart deletes — currently renders as `Unknown User` (the deleted side is left orphaned in `room.participants`). Decide if a "Deleted user" label is preferable.

#### Age assurance — DECISION (no DOB screen)
Posture: minimum age 15, NO in-app age/DOB screen, no DOB stored.
- Baseline signal: Apple/Google account minimum age (13–16 by region).
- Store rating: 17+ on both stores (stranger DMs + location = mature).
- State 15+ minimum in Terms/Privacy Policy.
- Under-age handled reactively: reporting (`POST /v1/reports`) + deletion (`DELETE /v1/users/me`) — both built.
- Future strengthening (still no DOB screen): adopt OS age-range APIs (Apple Declared Age Range / Android age signals).
- [ ] Open (non-code): set 17+ rating in consoles; add 15+ clause to privacy policy; legal/DPO sign-off (esp. UK Online Safety Act).
- Residual risk: weakest assurance tier — accepted for launch per current risk appetite.

#### UGC safety — built
- [x] Reporting endpoint `POST /v1/reports` (reason + optional user/room/message target) — backend done; mobile "Report" action still needed.
- [x] Block/unblock + account deletion already exist.

### 3. README cleanup
Go through all `README.md` files in the repo and make them short and readable.
- Keep only a straight explanation of what the project is and how to run it
- Remove debugging notes, troubleshooting dumps, outdated sections, and other noise
- Ensure consistent structure and tone

### 4. Dead code cleanup
Remove unused / dead code and anything that causes confusion.
- Unused files, classes, functions, variables, imports
- Commented-out code blocks left behind
- Obsolete feature flags, leftover experiments, stale TODOs
- Duplicate or redundant implementations
- Deliverable: list of candidates for removal before deleting (no edits until approved)

### 5. Moderation / admin backend — turn-on checklist
The moderation + admin API is implemented and compiles (affected tests pass in isolation) but is
OFF and not yet smoke-tested. Code: `routes/admin.ts`, `services/moderationService.ts`,
`services/auditService.ts`, `services/appleAuthService.ts`, `services/imageModerationService.ts`,
`utils/contentFilter.ts`, `utils/enforcement.ts`, `models/ModerationAction.ts`.
- [ ] Set `ADMIN_API_KEY` (long random) in Railway + local `.env` — admin is fail-closed/off until set.
- [ ] (Optional) Set `ADMIN_DASHBOARD_ORIGIN` for the future web panel's CORS.
- [ ] Smoke-test via curl/Postman with header `x-admin-key: <key>` (SKIPPED for now):
  `GET /v1/admin/ping`; list + PATCH `/v1/admin/reports`; DELETE + restore `/v1/admin/messages/:id`;
  ban/suspend/unban `/v1/admin/users/:id/*`; `GET /v1/admin/audit`.
- [ ] Populate `CONTENT_BLOCKLIST` (slurs etc.) before launch — the built-in list is only a starter.
- [ ] Apple revocation: set `APPLE_REVOKE_CLIENT_ID` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` /
  `APPLE_PRIVATE_KEY` in Railway. (Mobile already sends `authorizationCode` — done.) No-ops until set.
- [ ] Image moderation: choose a provider (Sightengine / WebPurify / Hive), implement the TODO in
  `moderateImage()`, set `IMAGE_MODERATION_PROVIDER` / `IMAGE_MODERATION_API_KEY` (+ secret).
- [ ] Commit the backend changes (currently uncommitted on disk).
- Deferred: the admin web GUI itself (see `docs/admin-moderation-plan.md`).

### 6. Release — remaining to submit
Code is essentially done across web/backend/mobile (`dart analyze` + `tsc` clean). What's left is
verification, store-console paperwork, and turning things on. See section 5 for the moderation config
(`ADMIN_API_KEY`, `CONTENT_BLOCKLIST`, `APPLE_*`).

Verify & commit:
- [ ] Commit the **backend** + **mobile** changes (website already pushed).
- [ ] Device smoke test: report (user/message/room), block from profile/message, ban kick-out (shows
  reason, no reconnect loop), live message removal, delete-account + export, tappable Terms/Privacy,
  passkey sign-in.
- [ ] Cut a TestFlight + Play internal build.

Store consoles (mostly non-code):
- [ ] Create the apps in App Store Connect + Google Play Console.
- [ ] Apple: App Privacy "nutrition" labels; age rating (17+); screenshots; description; support URL.
- [ ] Play: Data Safety form; content-rating questionnaire; target audience; screenshots; description;
  web account-deletion URL = https://bleyachat.com/delete-account.
- [ ] Play App Signing: after the Play app exists, copy its App Signing SHA-256 and confirm/replace the
  `C6:40…` fingerprint in the website's `assetlinks.json`.
- [ ] Review notes (both stores): persistent-identity city rooms (not anonymous random chat) + we act
  on reports within ~24h.

Polish (not rejections):
- [ ] iOS launch screen is still default — brand it if desired.
- [ ] App icon is an on-brand "B" placeholder — swap for final art (replace `mobile/assets/icon/app_icon.png`,
  re-run `dart run flutter_launcher_icons`).

Should-do (worldwide / legal):
- [ ] Appoint the GDPR Art. 27 EU/EEA representative and fill the Privacy Policy section.
- [ ] One paid Serbian advokat review of the legal docs.
