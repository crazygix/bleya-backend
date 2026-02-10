import mongoose from 'mongoose';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

function toObjectId(value: string): mongoose.Types.ObjectId | null {
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : null;
}

async function normalizeMessageUserIds(): Promise<number> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not available');
  }

  const messages = db.collection('messages');
  const cursor = messages.find(
    { userId: { $type: 'string' } },
    { projection: { _id: 1, userId: 1 } }
  );

  let modified = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const stringUserId = typeof doc.userId === 'string' ? doc.userId : null;
    if (!stringUserId) continue;

    const objectId = toObjectId(stringUserId);
    if (!objectId) {
      logger.warn('migration.normalize_user_refs.invalid_message_user_id', {
        messageId: String(doc._id),
        userId: stringUserId,
      });
      continue;
    }

    const result = await messages.updateOne(
      { _id: doc._id, userId: stringUserId },
      { $set: { userId: objectId } }
    );

    if (result.modifiedCount > 0) {
      modified += 1;
    }
  }

  return modified;
}

async function normalizeRoomParticipants(): Promise<number> {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not available');
  }

  const rooms = db.collection('rooms');
  const cursor = rooms.find(
    { participants: { $elemMatch: { $type: 'string' } } },
    { projection: { _id: 1, participants: 1 } }
  );

  let modified = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc || !Array.isArray(doc.participants)) {
      continue;
    }

    const normalizedParticipants = doc.participants
      .map((participant) => {
        if (participant instanceof mongoose.Types.ObjectId) {
          return participant;
        }

        if (typeof participant === 'string') {
          return toObjectId(participant);
        }

        return null;
      })
      .filter((participant): participant is mongoose.Types.ObjectId => participant !== null);

    const result = await rooms.updateOne(
      { _id: doc._id },
      { $set: { participants: normalizedParticipants } }
    );

    if (result.modifiedCount > 0) {
      modified += 1;
    }
  }

  return modified;
}

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const [messageUpdates, roomUpdates] = await Promise.all([
      normalizeMessageUserIds(),
      normalizeRoomParticipants(),
    ]);

    logger.info('migration.normalize_user_refs.completed', {
      messageUpdates,
      roomUpdates,
    });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.normalize_user_refs.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
