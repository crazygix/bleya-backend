import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { Room } from '../models/Room.js';
import logger from '../utils/logger.js';

const PRESET_ROOMS = [
  { name: 'Belgrade, Serbia' },
  { name: 'Novi Sad, Serbia' },
  { name: 'Niš, Serbia' },
  { name: 'Kraljevo, Serbia' },
  { name: 'Kragujevac, Serbia' },
  { name: 'Subotica, Serbia' },
];

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    for (const room of PRESET_ROOMS) {
      await Room.updateOne(
        { name: room.name, type: 'public' },
        { $setOnInsert: { ...room, type: 'public' } },
        { upsert: true }
      );
    }

    logger.info('migration.seed_public_rooms.completed', { count: PRESET_ROOMS.length });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.seed_public_rooms.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
