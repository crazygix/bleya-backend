import mongoose from 'mongoose';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    const collection = db.collection('rooms');
    const indexes = await collection.indexes();
    const hasLegacyIndex = indexes.some((index) => index.name === 'name_1');

    if (hasLegacyIndex) {
      await collection.dropIndex('name_1');
      logger.info('migration.drop_legacy_room_name_index.completed', { dropped: true });
      return;
    }

    logger.info('migration.drop_legacy_room_name_index.completed', { dropped: false });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.drop_legacy_room_name_index.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
