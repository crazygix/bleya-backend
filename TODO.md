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
