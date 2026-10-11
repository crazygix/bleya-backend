import mongoose from 'mongoose';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Analytics count messages, sign-ups and blocks by date range (the admin
// summary and the daily rollup in DailyStat). Without these indexes each count
// scans the whole collection. Builds them on the existing collections (new
// deploys also build them from the schemas). Idempotent.

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    await db.collection('messages').createIndex({ createdAt: 1 });
    await db.collection('users').createIndex({ createdAt: 1 });
    await db.collection('userblocks').createIndex({ blockedAt: 1 });

    logger.info('migration.analytics_indexes.completed');
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.analytics_indexes.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
