import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';
import { Notification } from '../models/Notification.js';
import logger from '../utils/logger.js';

// The Room unique indexes never built (MongoDB rejects `sparse` together with
// `partialFilterExpression`), so concurrent joins could create duplicate city
// rooms and duplicate DM rooms. This merges each duplicate group into its oldest
// room — messages, members, read pointers, hidden flags, notifications, reports
// and blocks move over — then builds the indexes so it can't happen again.
//
// Idempotent: a second run finds nothing to merge. `--dry-run` only reports.

const DRY_RUN = process.argv.includes('--dry-run');

type ObjectId = mongoose.Types.ObjectId;

interface DuplicateGroup {
  _id: string;
  rooms: Array<{ id: ObjectId; createdAt?: Date }>;
}

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not available');
  }
  return db;
}

async function findDuplicateGroups(match: Record<string, unknown>, groupField: string): Promise<DuplicateGroup[]> {
  return getDb().collection('rooms').aggregate<DuplicateGroup>([
    { $match: match },
    { $group: { _id: `$${groupField}`, rooms: { $push: { id: '$_id', createdAt: '$createdAt' } }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
}

async function mergeReadPointers(keepId: ObjectId, duplicateIds: ObjectId[]): Promise<void> {
  const users = getDb().collection('users');
  const duplicateSet = new Set(duplicateIds.map((id) => id.toString()));
  const cursor = users.find(
    { 'roomReadPointers.roomId': { $in: duplicateIds } },
    { projection: { roomReadPointers: 1 } }
  );

  for await (const user of cursor) {
    const latestByRoom = new Map<string, { roomId: ObjectId; lastReadAt: Date }>();
    for (const pointer of (user.roomReadPointers || []) as Array<{ roomId: ObjectId; lastReadAt: Date }>) {
      const roomId = duplicateSet.has(pointer.roomId.toString()) ? keepId : pointer.roomId;
      const key = roomId.toString();
      const existing = latestByRoom.get(key);
      if (!existing || pointer.lastReadAt > existing.lastReadAt) {
        latestByRoom.set(key, { roomId, lastReadAt: pointer.lastReadAt });
      }
    }
    await users.updateOne({ _id: user._id }, { $set: { roomReadPointers: [...latestByRoom.values()] } });
  }
}

async function mergeGroup(group: DuplicateGroup): Promise<void> {
  const sorted = [...group.rooms].sort((a, b) => {
    const aTime = a.createdAt ? a.createdAt.getTime() : a.id.getTimestamp().getTime();
    const bTime = b.createdAt ? b.createdAt.getTime() : b.id.getTimestamp().getTime();
    return aTime - bTime;
  });
  const keepId = sorted[0].id;
  const duplicateIds = sorted.slice(1).map((room) => room.id);

  logger.info('migration.dedupe_rooms.group', {
    key: group._id,
    keep: keepId.toString(),
    merge: duplicateIds.map((id) => id.toString()),
  });

  if (DRY_RUN) {
    return;
  }

  const db = getDb();
  const users = db.collection('users');
  const inDuplicates = { $in: duplicateIds };
  // The driver's typings don't model $pull with a condition on untyped
  // collections; the update itself is standard MongoDB.
  const pullDuplicates = (field: string) => (
    { $pull: { [field]: inDuplicates } } as unknown as mongoose.mongo.UpdateFilter<mongoose.mongo.Document>
  );

  await db.collection('messages').updateMany({ roomId: inDuplicates }, { $set: { roomId: keepId } });
  await users.updateMany({ joinedRooms: inDuplicates }, { $addToSet: { joinedRooms: keepId } });
  await users.updateMany({ joinedRooms: inDuplicates }, pullDuplicates('joinedRooms'));
  await users.updateMany({ hiddenDirectRooms: inDuplicates }, { $addToSet: { hiddenDirectRooms: keepId } });
  await users.updateMany({ hiddenDirectRooms: inDuplicates }, pullDuplicates('hiddenDirectRooms'));
  await mergeReadPointers(keepId, duplicateIds);
  await db.collection('notifications').updateMany({ room: inDuplicates }, { $set: { room: keepId } });
  await db.collection('reports').updateMany({ roomId: inDuplicates }, { $set: { roomId: keepId } });
  await db.collection('userblocks').updateMany({ roomId: inDuplicates }, { $set: { roomId: keepId } });
  await db.collection('rooms').deleteMany({ _id: inDuplicates });
}

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  try {
    const cityGroups = await findDuplicateGroups({ type: 'public', cityKey: { $type: 'string' } }, 'cityKey');
    const directGroups = await findDuplicateGroups({ type: 'private', participantsHash: { $type: 'string' } }, 'participantsHash');

    for (const group of [...cityGroups, ...directGroups]) {
      await mergeGroup(group);
    }

    if (!DRY_RUN) {
      // syncIndexes also drops Room indexes the schema no longer defines.
      await Room.syncIndexes();
      await Message.createIndexes();
      await Notification.createIndexes();
    }

    logger.info('migration.dedupe_rooms.completed', {
      dryRun: DRY_RUN,
      cityGroupsMerged: cityGroups.length,
      directGroupsMerged: directGroups.length,
    });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.dedupe_rooms.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
