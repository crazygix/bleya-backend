## Bleya Backend - Architecture & System Design Rules

The original backend architecture rule document was authored as a TypeScript file with rich comments and examples.
Its full content is preserved below as code for easy reference.

```ts
/// Bleya Backend - Architecture & System Design Rules
///
/// This document defines the architectural principles, patterns, and conventions
/// that all developers must follow when working on this codebase.
/// Similar to the mobile app's architecture_rules.dart, this serves as the
/// single source of truth for backend architectural decisions.
///
/// ========================================
/// 1. DATE/TIME HANDLING
/// ========================================
///
/// RULE: ALWAYS send dates as timestamps (milliseconds since epoch), NEVER ISO strings
///
/// API Responses:
/// - Always use: `date.getTime()` (returns int milliseconds)
/// - NEVER use: `date.toISOString()` or `date.toString()`
///
/// Examples:
/// ```typescript
/// // ✅ CORRECT
/// res.json({
///   createdAt: user.createdAt.getTime(),
///   updatedAt: user.updatedAt.getTime()
/// });
///
/// // ❌ WRONG
/// res.json({
///   createdAt: user.createdAt.toISOString(),
///   updatedAt: user.updatedAt.toString()
/// });
/// ```
///
/// Note: Logging timestamps (console.log, error logs) can still use ISO strings
/// for readability. This rule applies only to API responses.
///
/// ========================================
/// 2. API RESPONSE FORMAT
/// ========================================
///
/// RULE: Always return consistent JSON structures
///
/// Success Responses:
/// - Use proper HTTP status codes (200, 201, etc.)
/// - Return consistent object shapes
/// - Include all relevant data fields
/// - Define explicit DTOs/interfaces for response types
///
/// Error Responses:
/// - Use standardized error format from `utils/errors.ts`
/// - Include error codes for client-side handling
/// - Provide clear, user-friendly error messages
///
/// API Versioning:
/// - Use versioned endpoints: `/v1/...` (future-proofing)
/// - Before launch, prefer changing the current version cleanly over keeping legacy aliases
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - explicit DTO
/// interface UserResponse {
///   id: string;
///   username: string;
///   createdAt: number;
/// }
/// 
/// res.json({
///   id: user._id.toString(),
///   username: user.username,
///   createdAt: user.createdAt.getTime()
/// } as UserResponse);
///
/// // ❌ WRONG - inconsistent structure
/// res.json(user); // Raw mongoose document
/// ```
///
/// ========================================
/// 3. ERROR HANDLING
/// ========================================
///
/// RULE: Always use asyncHandler and custom error classes
///
/// Structure:
/// - Use `asyncHandler` wrapper for all async route handlers
/// - Throw custom errors from `utils/errors.ts` (NotFoundError, ValidationError, etc.)
/// - Let errorHandler middleware catch and format errors
/// - Always throw AppError subclasses, never return ad-hoc error JSON
///
/// Example:
/// ```typescript
/// // ✅ CORRECT
/// router.get('/:id', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
///   const user = await User.findById(req.params.id);
///   if (!user) {
///     throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
///   }
///   res.json({ id: user._id.toString(), username: user.username });
/// }));
///
/// // ❌ WRONG - manual error handling
/// router.get('/:id', async (req, res) => {
///   try {
///     const user = await User.findById(req.params.id);
///     if (!user) {
///       return res.status(404).json({ error: 'Not found' });
///     }
///     res.json(user);
///   } catch (error) {
///     res.status(500).json({ error: 'Server error' });
///   }
/// });
/// ```
///
/// ========================================
/// 4. CODE STYLE
/// ========================================
///
/// RULE: Follow TypeScript strict mode and existing patterns
///
/// TypeScript:
/// - Use strict mode
/// - Define proper types/interfaces
/// - Avoid `any` when possible (use `unknown` or proper types)
///
/// MongoDB:
/// - Always validate ObjectId format before queries
/// - Use `.lean()` for read-only queries when possible
/// - Use atomic operations to prevent race conditions
/// - Use consistent data types: ObjectId for references (not String)
///
/// Data Model Consistency:
/// - User references should be ObjectId everywhere (e.g., Message.userId should be ObjectId, not String)
/// - Use mongoose.Schema.Types.ObjectId for all foreign key references
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - validate ObjectId
/// if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
///   throw new ValidationError('Invalid user ID format');
/// }
/// const user = await User.findById(userId);
///
/// // ✅ CORRECT - atomic operation
/// await User.updateOne(
///   { _id: userId },
///   { $addToSet: { joinedRooms: roomId } }
/// );
///
/// // ❌ WRONG - race condition possible
/// const user = await User.findById(userId);
/// user.joinedRooms.push(roomId);
/// await user.save();
///
/// // ❌ WRONG - inconsistent type
/// userId: String, // Should be mongoose.Schema.Types.ObjectId
/// ```
///
/// ========================================
/// 5. AUTHENTICATION & AUTHORIZATION
/// ========================================
///
/// RULE: Always use authenticateUser middleware for protected routes
///
/// Structure:
/// - Use `authenticateUser` middleware before route handlers
/// - Access user via `req.user` (typed as `AuthRequest`)
/// - Validate user exists before operations
///
/// Example:
/// ```typescript
/// // ✅ CORRECT
/// router.get('/profile', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
///   const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
///   if (!user) {
///     throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
///   }
///   res.json({ username: user.username });
/// }));
/// ```
///
/// ========================================
/// 5.1. SOCKET.IO AUTHENTICATION
/// ========================================
///
/// RULE: Apply same authentication and validation rules to Socket.IO events
///
/// Structure:
/// - Use JWT authentication middleware in Socket.IO connection handler
/// - Validate event payloads (roomId, message text, etc.)
/// - Use same error format as HTTP endpoints
/// - Apply input sanitization to all user-generated content
/// - Use timestamps (getTime()) in Socket.IO responses, not ISO strings
/// - Consider rate limiting for Socket.IO events
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - authenticated socket with validation
/// socket.on('send_message', async (data: { text: string; parentMessageId?: string }) => {
///   const sanitizedText = sanitizeText(data.text);
///   if (!sanitizedText || sanitizedText.trim().length === 0) {
///     socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Message cannot be empty' });
///     return;
///   }
///   // ... create message
///   socket.emit('new_message', {
///     id: message._id.toString(),
///     text: message.text,
///     createdAt: message.createdAt.getTime() // ✅ Use getTime()
///   });
/// });
/// ```
///
/// ========================================
/// 6. DATABASE QUERIES
/// ========================================
///
/// RULE: Optimize queries and prevent N+1 problems
///
/// Best Practices:
/// - Use `.populate()` for related documents when needed
/// - Use `.lean()` for read-only queries (faster, returns plain objects)
/// - Bulk fetch related data instead of querying in loops
/// - Use indexes for frequently queried fields
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - bulk fetch
/// const participantIds = new Set<string>();
/// rooms.forEach(room => {
///   room.participants.forEach(id => participantIds.add(id));
/// });
/// const users = await User.find({ _id: { $in: Array.from(participantIds) } });
///
/// // ❌ WRONG - N+1 query problem
/// for (const room of rooms) {
///   for (const participantId of room.participants) {
///     const user = await User.findById(participantId); // Multiple queries!
///   }
/// }
/// ```
///
/// ========================================
/// 6.1. MIGRATIONS & INDEX MANAGEMENT
/// ========================================
///
/// RULE: Never perform schema/index changes in server.ts startup code
///
/// Structure:
/// - Use dedicated migration scripts for schema changes
/// - Index cleanup/creation should be in migrations, not server startup
/// - Use mongoose migrations library or custom migration system
/// - Document all schema changes in migration files
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - migration script
/// // migrations/001-drop-old-index.ts
/// export async function up() {
///   const collection = db.collection('rooms');
///   await collection.dropIndex('name_1');
/// }
///
/// // ❌ WRONG - index cleanup in server.ts
/// // In server.ts startup:
/// await collection.dropIndex('name_1'); // Don't do this!
/// ```
///
/// ========================================
/// 7. RACE CONDITION HANDLING
/// ========================================
///
/// RULE: Use atomic operations for concurrent operations
///
/// Common Scenarios:
/// - Adding items to arrays: Use `$addToSet` or `$push` with `updateOne`
/// - Creating unique resources: Use `findOneAndUpdate` with `upsert: true`
/// - Counting/checking limits: Use atomic operations or transactions
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - atomic upsert prevents duplicates
/// const room = await Room.findOneAndUpdate(
///   { participantsHash: hash },
///   { $setOnInsert: { name, type: 'private', participants } },
///   { upsert: true, new: true }
/// );
///
/// // ✅ CORRECT - atomic add to set
/// await User.updateOne(
///   { _id: userId },
///   { $addToSet: { joinedRooms: roomId } }
/// );
/// ```
///
/// ========================================
/// 8. FILE UPLOADS
/// ========================================
///
/// RULE: Use multer for file handling, upload to R2
///
/// Structure:
/// - Configure multer with memory storage
/// - Validate file types and sizes
/// - Upload to R2 using `r2Service`
/// - Delete old files when replacing
///
/// Example:
/// ```typescript
/// router.post('/upload', authenticateUser, upload.single('image'), asyncHandler(async (req: AuthRequest, res: express.Response) => {
///   if (!req.file) {
///     throw new ValidationError('No file provided');
///   }
///   // Validate, upload, save URL
/// }));
/// ```
///
/// ========================================
/// 9. SERVICE LAYER (THIN CONTROLLERS)
/// ========================================
///
/// RULE: Routes should be thin - extract business logic to services
///
/// Structure:
/// - Routes handle: input validation, calling services, formatting responses
/// - Services handle: business logic, database operations, external API calls
/// - Models handle: data structure and validation
///
/// Benefits:
/// - Testable business logic (services can be unit tested)
/// - Reusable logic across routes and Socket.IO handlers
/// - Clear separation of concerns
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - thin route, business logic in service
/// // routes/auth.ts
/// router.post('/verify-code', asyncHandler(async (req, res) => {
///   const { phoneNumber, code } = req.body;
///   const result = await authService.verifyCode(phoneNumber, code);
///   setRefreshCookie(res, result.refreshToken);
///   res.json({ token: result.accessToken, requiresUsername: result.requiresUsername });
/// }));
///
/// // services/authService.ts
/// export async function verifyCode(phoneNumber: string, code: string) {
///   const normalizedPhone = normalizePhoneNumber(phoneNumber);
///   const user = await User.findOne({ phoneNumber: normalizedPhone });
///   // ... business logic here
///   return { accessToken, refreshToken, requiresUsername };
/// }
///
/// // ❌ WRONG - business logic in route
/// router.post('/verify-code', asyncHandler(async (req, res) => {
///   const { phoneNumber, code } = req.body;
///   const normalizedPhone = normalizePhoneNumber(phoneNumber);
///   const user = await User.findOne({ phoneNumber: normalizedPhone });
///   // ... 50 lines of business logic here
/// }));
/// ```
///
/// ========================================
/// 10. INPUT VALIDATION & SANITIZATION
/// ========================================
///
/// RULE: Always validate and sanitize user-generated input
///
/// Structure:
/// - Validate input format/types before processing
/// - Sanitize all user-generated content (XSS prevention)
/// - Use centralized sanitization utilities from `utils/sanitize.ts`
/// - Apply sanitization to: message text, bio, usernames, phone numbers
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - validate and sanitize
/// import { sanitizeText, sanitizeUsername } from '../utils/sanitize.js';
///
/// router.post('/message', asyncHandler(async (req, res) => {
///   const { text } = req.body;
///   if (!text || typeof text !== 'string') {
///     throw new ValidationError('Message text is required');
///   }
///   const sanitizedText = sanitizeText(text);
///   if (sanitizedText.trim().length === 0) {
///     throw new ValidationError('Message cannot be empty');
///   }
///   // Use sanitizedText for message creation
/// }));
///
/// // ❌ WRONG - no sanitization
/// router.post('/message', asyncHandler(async (req, res) => {
///   const { text } = req.body;
///   // Directly using user input - XSS risk!
///   await Message.create({ text: req.body.text });
/// }));
/// ```
///
/// ========================================
/// 11. ROUTE ORGANIZATION
/// ========================================
///
/// RULE: Group related routes in separate files
///
/// Structure:
/// - `routes/auth.ts`: Authentication routes
/// - `routes/users.ts`: User profile routes
/// - `routes/rooms.ts`: Room management routes
/// - `routes/messages.ts`: Message routes
///
/// Naming:
/// - Use RESTful conventions where possible
/// - Place specific routes before parameterized routes (e.g., `/me` before `/:id`)
///
/// ========================================
/// 12. MIDDLEWARE ORDER
/// ========================================
///
/// RULE: Apply middleware in correct order
///
/// Typical Order:
/// 1. CORS (with allowlist configuration)
/// 2. Body parsing (express.json)
/// 3. Request logging (must not log sensitive data)
/// 4. Rate limiting
/// 5. Routes
/// 6. Error handler (last)
///
/// CORS Configuration:
/// - Use allowlist from environment variables (not `origin: true`)
/// - Configure in `utils/cors.ts` for consistency
/// - Apply same CORS rules to Socket.IO
///
/// ========================================
/// 13. CONFIGURATION MANAGEMENT
/// ========================================
///
/// RULE: Validate all environment variables at startup
///
/// Structure:
/// - Create typed config module that validates env vars
/// - Fail fast if required config is missing
/// - Use sensible defaults only for non-critical values
/// - Document all required env vars in `.env.example`
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - validated config
/// // config/index.ts
/// export const config = {
///   mongoUri: process.env.MONGODB_URI || (() => {
///     throw new Error('MONGODB_URI is required');
///   })(),
///   jwtSecret: process.env.JWT_SECRET || (() => {
///     throw new Error('JWT_SECRET is required');
///   })(),
///   corsOrigins: process.env.CORS_ORIGINS?.split(',') || [process.env.CLIENT_ORIGIN || 'http://localhost:3000'],
/// };
///
/// // ❌ WRONG - unvalidated config
/// const mongoUri = process.env.MONGODB_URI; // Could be undefined!
/// ```
///
/// ========================================
/// 14. LOGGING
/// ========================================
///
/// RULE: Use structured logging, never log sensitive data
///
/// Structure:
/// - Use structured logging library (Winston/Pino) - avoid console.log in business logic
/// - Never log: passwords, tokens, full request bodies
/// - Include request ID for tracing
/// - Use appropriate log levels (debug, info, warn, error)
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - structured logging
/// import logger from '../utils/logger.js';
///
/// logger.info('User authenticated', {
///   userId: user._id.toString(),
///   requestId: req.id
/// });
///
/// // ❌ WRONG - logging sensitive data
/// console.log('Request body:', req.body); // May contain tokens!
/// console.log('User:', user); // May contain sensitive fields!
/// ```
///
/// ========================================
/// 15. TESTING
/// ========================================
///
/// RULE: Write tests for critical business logic
///
/// Minimum Requirements:
/// - Unit tests for service layer functions
/// - Integration tests for API endpoints (auth flows, room creation, etc.)
/// - Test error handling paths
///
/// Structure:
/// - `__tests__/` or `tests/` directory
/// - Test services in isolation (mock database)
/// - Test routes with integration tests (test database)
///
/// Example:
/// ```typescript
/// // ✅ CORRECT - service test
/// // __tests__/services/authService.test.ts
/// describe('authService', () => {
///   it('should verify code correctly', async () => {
///     const result = await authService.verifyCode('+1234567890', '123456');
///     expect(result).toHaveProperty('accessToken');
///   });
/// });
/// ```
///
/// ========================================
/// 16. FORBIDDEN PATTERNS
/// ========================================
///
/// ❌ NEVER:
/// - Use `.toISOString()` for API response dates (use `.getTime()`)
/// - Return raw mongoose documents (always format responses)
/// - Skip ObjectId validation before queries
/// - Use manual try/catch in routes (use asyncHandler)
/// - Query in loops (causes N+1 problems)
/// - Use non-atomic operations for concurrent updates
/// - Skip authentication middleware on protected routes
/// - Use `any` type without good reason
/// - Put business logic directly in routes (use service layer)
/// - Skip input sanitization for user-generated content
/// - Log sensitive data (tokens, passwords, full request bodies)
/// - Use `origin: true` for CORS (use allowlist)
/// - Perform schema/index changes in server.ts
/// - Use console.log in business logic (use structured logger)
///
/// ========================================
/// 17. CODE REVIEW CHECKLIST
/// ========================================
///
/// Before submitting PR:
/// - [ ] All dates use `.getTime()` (not `.toISOString()`)
/// - [ ] Routes use `asyncHandler` wrapper
/// - [ ] Custom error classes used (not manual error handling)
/// - [ ] ObjectId format validated before queries
/// - [ ] Atomic operations used for concurrent updates
/// - [ ] No N+1 query problems
/// - [ ] Protected routes use `authenticateUser` middleware
/// - [ ] Response format is consistent
/// - [ ] No `any` types (or properly justified)
/// - [ ] Business logic extracted to service layer
/// - [ ] User input is validated and sanitized
/// - [ ] CORS uses allowlist (not `origin: true`)
/// - [ ] No sensitive data in logs
/// - [ ] Socket.IO events follow same validation rules
/// - [ ] Configuration validated at startup
/// - [ ] Tests added for new business logic
///
/// ========================================
/// END OF ARCHITECTURE RULES
/// ========================================
```
