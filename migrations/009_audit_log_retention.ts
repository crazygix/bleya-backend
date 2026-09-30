import mongoose from 'mongoose';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { DAY_MS } from '../utils/retention.js';

// Moderation-action records used to be kept indefinitely. They now carry
// retainUntil (the action's time plus AUDIT_LOG_RETENTION_DAYS) and a TTL index
// deletes them when it passes. This sets retainUntil on existing records and
// builds the TTL index. Idempotent.

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    const actions = db.collection('moderationactions');
    const result = await actions.updateMany(
      { retainUntil: { $exists: false } },
      [{ $set: { retainUntil: { $add: ['$createdAt', config.auditLog.retentionDays * DAY_MS] } } }]
    );
    await actions.createIndex({ retainUntil: 1 }, { expireAfterSeconds: 0 });

    logger.info('migration.audit_log_retention.completed', {
      updated: result.modifiedCount,
      retentionDays: config.auditLog.retentionDays,
    });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.audit_log_retention.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
