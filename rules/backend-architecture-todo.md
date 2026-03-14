## Backend Architecture Improvements TODO

This file tracks remaining architecture improvements to be implemented
according to the backend architecture rules.

The original TODO content from the project root is preserved below.

```md
## ✅ Completed

- [x] CORS allowlist configuration (utils/cors.ts)
- [x] Input sanitization utilities (utils/sanitize.ts)
- [x] Socket.IO input sanitization applied
- [x] Architecture rules documentation updated

## 🔲 High Priority

### 1. Service Layer Extraction
**Status:** Not started  
**Files:** `routes/auth.ts`, `routes/users.ts`, `routes/rooms.ts`, `routes/messages.ts`, `server/socket.ts`

Extract business logic from routes to service layer:
- Create `services/authService.ts` for authentication logic
- Create `services/userService.ts` for user profile operations
- Create `services/roomService.ts` for room management
- Create `services/messageService.ts` for message operations
- Refactor routes to be thin controllers (validation → service call → response formatting)
- Refactor Socket.IO handlers to use services

**Reference:** `core/architecture_rules.ts` section 9

### 2. Input Sanitization (HTTP Routes)
**Status:** Partially done (Socket.IO only)  
**Files:** `routes/auth.ts`, `routes/users.ts`, `routes/messages.ts`

Apply sanitization to all user-generated input in HTTP routes:
- Phone numbers: use `sanitizePhoneNumber()`
- Usernames: use `sanitizeUsername()`
- Bio/message text: use `sanitizePlainText()`

**Reference:** `core/architecture_rules.ts` section 10

### 3. Configuration Management
**Status:** Not started  
**File:** `config/index.ts` (to be created)

Create centralized config module:
- Validate all required env vars at startup
- Type-safe configuration object
- Fail fast if required vars missing
- Document in `.env.example`

**Reference:** `core/architecture_rules.ts` section 13

### 4. Structured Logging
**Status:** Not started  
**Files:** `server/server.ts`, `server/socket.ts`, `middleware/errorHandler.ts`

Replace `console.log` with structured logger:
- Install Winston or Pino
- Create `utils/logger.ts`
- Add request ID middleware for tracing
- Remove sensitive data from logs (tokens, passwords, full request bodies)
- Use appropriate log levels

**Reference:** `core/architecture_rules.ts` section 14

## 🔲 Medium Priority

### 5. Data Model Consistency
**Status:** Not started  
**File:** `models/Message.ts`

Fix inconsistent data types:
- Change `Message.userId` from `String` to `mongoose.Schema.Types.ObjectId`
- Create migration script to update existing data
- Update all code that references `Message.userId`

**Reference:** `core/architecture_rules.ts` section 4

### 6. Migration System
**Status:** Not started  
**Files:** `migrations/` (to be created), `server/server.ts`

Move schema/index changes to proper migrations:
- Create migration system (or use library)
- Move index cleanup from `server.ts` to migration script
- Move preset rooms initialization to migration
- Document all schema changes

**Reference:** `core/architecture_rules.ts` section 6.1

### 7. Testing
**Status:** Not started  
**Files:** `__tests__/` or `tests/` (to be created)

Add minimum test coverage:
- Unit tests for service layer functions
- Integration tests for critical API endpoints (auth flows, room creation)
- Test error handling paths

**Reference:** `core/architecture_rules.ts` section 15

## 🔲 Low Priority

### 8. API Versioning
**Status:** Completed  
**Files:** `server/server.ts`, all route files

API versioning:
- Routes are mounted under `/v1/...`
- No legacy aliases are kept before public launch

**Reference:** `core/architecture_rules.ts` section 2

### 9. Socket.IO Rate Limiting
**Status:** Not started  
**File:** `server/socket.ts`

Add rate limiting for Socket.IO events:
- Limit `send_message` events per user
- Limit `join_room` events per user
- Use similar approach as HTTP rate limiting

**Reference:** `core/architecture_rules.ts` section 5.1

---

## Notes

- All TODO comments in code reference specific sections in the architecture rules
- Prioritize High Priority items for better architecture and security
- Medium Priority items improve maintainability and consistency
- Low Priority items are nice-to-haves for future scalability
```
