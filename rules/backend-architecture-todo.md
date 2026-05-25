## Backend Architecture Improvements TODO

Last reviewed: 2026-05-25

This file tracks architecture work that still remains after the refactors
already landed. It is intended to reflect the current codebase, not the
original pre-refactor checklist.

## Completed

- [x] CORS allowlist configuration (`utils/cors.ts`)
- [x] Centralized config loading and validation (`config/index.ts`, `server/app.ts`, `.env.example`)
- [x] Structured logging with request IDs and body redaction/truncation controls (`utils/logger.ts`, `middleware/httpRequestLogger.ts`, `middleware/errorHandler.ts`)
- [x] Data model consistency for `Message.userId` plus normalization migration (`models/Message.ts`, `migrations/003_normalize_user_references.ts`)
- [x] API versioning under `/v1/...`
- [x] Socket.IO event rate limiting for `join_room` and `send_message` (`server/socket.ts`)
- [x] Baseline automated test suite in `tests/`
- [x] Service-layer extraction for rooms: `routes/rooms.ts` is now a thin controller. Room listing/detail aggregation, member listing, read pointers, the direct-message lifecycle, and block/unblock orchestration live in `services/roomService.ts` and `services/directMessageService.ts`.
- [x] Socket.IO orchestration moved into services: `join_room` business logic (`roomService.buildRoomJoinView`), room summary fanout recipients (`roomService.getRoomSummaryRecipientIds`), and reply-notification event building (`NotificationService.buildReplyNotificationEvents`). `server/socket.ts` now only handles transport.

## Remaining

### High Priority

#### 1. Keep HTTP input handling consistent
**Status:** Mostly complete  
**Files:** `services/authService.ts`, `services/userService.ts`, `services/messageService.ts`, `routes/rooms.ts`

Completed:
- Username inputs are normalized and validated before persistence.
- Bio, message text, and room search query inputs are sanitized.

Remaining:
- Review new free-form inputs as they are added; there is no known large sanitization gap in the current HTTP routes.

**Reference:** `core/architecture_rules.ts` section 10

### Medium Priority

#### 2. Migration workflow
**Status:** Partially complete  
**Files:** `migrations/001_seed_public_rooms.ts`, `migrations/002_drop_legacy_room_name_index.ts`, `migrations/003_normalize_user_references.ts`

Completed:
- One-off migration scripts exist for preset rooms, legacy index cleanup, and user-reference normalization.

Remaining:
- Add a single migration runner or deployment playbook so migrations run in a documented, ordered way.
- Document operational ownership for applying new migrations.

**Reference:** `core/architecture_rules.ts` section 6.1

#### 4. Testing depth
**Status:** Mostly complete  
**Files:** `tests/`

Completed:
- Unit, service, integration, and error-path tests exist and currently pass.

Remaining:
- Add coverage for notifications, cities, profile-image upload, passkey verification endpoints, direct-message block/unblock flows, and Socket.IO behavior.

**Reference:** `core/architecture_rules.ts` section 15

## Notes

- This file intentionally replaces the old "not started" checklist, which no longer matched the codebase.
- Update this note when architecture work changes materially so it stays useful as a source of truth.
