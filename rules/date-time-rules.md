## Bleya Backend - Date/Time Handling Rules

The original backend date/time rules were authored in a TypeScript file.
Their content is preserved below as code for reference.

```ts
/// Bleya Backend Rule: DATE/TIME HANDLING
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
```

