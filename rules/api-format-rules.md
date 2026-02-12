## Bleya Backend - API Response Format Rules

The original API response format rules were authored in a TypeScript file.
Their content is preserved below as code for reference.

```ts
/// Bleya Backend Rule: API RESPONSE FORMAT
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
/// - Use versioned endpoints: `/api/v1/...` (future-proofing)
/// - Plan for backward compatibility when adding v2
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
```

