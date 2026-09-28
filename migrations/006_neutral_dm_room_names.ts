import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { DIRECT_ROOM_NAME } from '../services/directMessageService.js';
import logger from '../utils/logger.js';

// DM rooms used to be stored as "DM: <username> & <username>", which kept a
// deleted user's handle around. The app never shows this stored name (it uses
// the other participant's current username), so it is replaced with a neutral
// one. Idempotent.

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    const result = await db.collection('rooms').updateMany(
      { type: 'private', name: { $ne: DIRECT_ROOM_NAME } },
      { $set: { name: DIRECT_ROOM_NAME } }
    );

    logger.info('migration.neutral_dm_names.completed', { updated: result.modifiedCount });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.neutral_dm_names.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
