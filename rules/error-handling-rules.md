## Bleya Backend - Error Handling Rules

The original backend error handling rules were authored in a TypeScript file.
Their content is preserved below as code for reference.

```ts
/// Bleya Backend Rule: ERROR HANDLING
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
```

