## Bleya Backend - Code Style Rules

The original backend code style rules were authored in a TypeScript file.
Their content is preserved below as code for reference.

```ts
/// Bleya Backend Rule: CODE STYLE
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
/// ```
```

