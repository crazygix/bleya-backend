import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { unescapeHtml } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

// User text used to be HTML-escaped when stored, so the app showed "&#39;" and
// friends in messages, bios, ban reasons and pushes. This unescapes rows written
// before that was fixed.
//
// It must only ever run once: unescaping twice would turn text a user really
// typed as "&amp;" into "&". A marker in the `migrations` collection makes a
// second run a no-op (override with --force), and only rows older than
// --before=<ISO date> are touched (default: now). Pass the deploy time of the
// fix. `--dry-run` only counts.

const MIGRATION_ID = '005_unescape_stored_text';
const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#39);/;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

function parseBefore(): Date {
  const arg = process.argv.find((value) => value.startsWith('--before='));
  if (!arg) {
    return new Date();
  }
  const date = new Date(arg.slice('--before='.length));
  if (Number.isNaN(date.getTime())) {
    throw new Error('--before must be an ISO date, e.g. --before=2026-09-29T10:00:00Z');
  }
  return date;
}

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not available');
  }
  return db;
}

async function unescapeFields(
  collectionName: string,
  fields: string[],
  timeFilter: Record<string, unknown>
): Promise<number> {
  const collection = getDb().collection(collectionName);
  const cursor = collection.find(
    {
      ...timeFilter,
      $or: fields.map((field) => ({ [field]: { $regex: ENTITY_PATTERN } })),
    },
    { projection: Object.fromEntries(fields.map((field) => [field, 1])) }
  );

  let updated = 0;
  for await (const doc of cursor) {
    const set: Record<string, string> = {};
    for (const field of fields) {
      const value = doc[field];
      if (typeof value === 'string' && ENTITY_PATTERN.test(value)) {
        set[field] = unescapeHtml(value);
      }
    }
    if (Object.keys(set).length === 0) {
      continue;
    }
    if (!DRY_RUN) {
      await collection.updateOne({ _id: doc._id }, { $set: set });
    }
    updated += 1;
  }
  return updated;
}

async function run(): Promise<void> {
  const before = parseBefore();
  await mongoose.connect(config.mongoUri);

  try {
    const markers = getDb().collection<{ _id: string; completedAt: Date; before: Date; counts: unknown }>('migrations');
    const existing = await markers.findOne({ _id: MIGRATION_ID });
    if (existing && !FORCE) {
      logger.info('migration.unescape_text.already_done', { completedAt: existing.completedAt });
      return;
    }

    const counts = {
      messages: await unescapeFields('messages', ['text', 'deleteReason'], { createdAt: { $lt: before } }),
      users: await unescapeFields('users', ['bio', 'enforcementReason'], { updatedAt: { $lt: before } }),
      reports: await unescapeFields('reports', ['details', 'resolutionNote'], { updatedAt: { $lt: before } }),
    };

    if (!DRY_RUN) {
      await markers.updateOne(
        { _id: MIGRATION_ID },
        { $set: { completedAt: new Date(), before, counts } },
        { upsert: true }
      );
    }

    logger.info('migration.unescape_text.completed', { dryRun: DRY_RUN, before: before.toISOString(), ...counts });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.unescape_text.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
