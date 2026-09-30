import mongoose from 'mongoose';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Reports used to be kept indefinitely. They now carry retainUntil (filing time
// plus REPORT_RETENTION_DAYS) and a TTL index deletes them when it passes. This
// sets retainUntil on existing reports and builds the TTL index. Idempotent.

const DAY_MS = 24 * 60 * 60 * 1000;

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    const reports = db.collection('reports');
    const result = await reports.updateMany(
      { retainUntil: { $exists: false } },
      [{ $set: { retainUntil: { $add: ['$createdAt', config.reports.retentionDays * DAY_MS] } } }]
    );
    await reports.createIndex({ retainUntil: 1 }, { expireAfterSeconds: 0 });

    logger.info('migration.report_retention.completed', {
      updated: result.modifiedCount,
      retentionDays: config.reports.retentionDays,
    });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.report_retention.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
