import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { normalizeProfileImage } from '../services/userService.js';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from '../services/r2Service.js';
import logger from '../utils/logger.js';

// Profile photos used to be stored exactly as uploaded — EXIF metadata, often
// including GPS coordinates, and the client's Content-Type included. This
// re-encodes every stored photo the way new uploads are handled (WebP, metadata
// stripped), points the user at the new file and deletes the original.
//
// Idempotent: photos already stored by the new upload code are skipped.
// `--dry-run` only lists what would change.

const DRY_RUN = process.argv.includes('--dry-run');
const NEW_FORMAT_KEY = /profiles\/profile-[0-9a-f-]{36}\.webp$/;
const DOWNLOAD_TIMEOUT_MS = 15_000;

async function run(): Promise<void> {
  await mongoose.connect(config.mongoUri);

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection is not available');
    }

    const users = db.collection('users');
    const cursor = users.find(
      { profileImageUrl: { $type: 'string', $ne: '' } },
      { projection: { profileImageUrl: 1 } }
    );

    for await (const user of cursor) {
      const url = user.profileImageUrl as string;
      if (NEW_FORMAT_KEY.test(url)) {
        skipped += 1;
        continue;
      }

      if (DRY_RUN) {
        logger.info('migration.reencode_profile_images.would_convert', { userId: String(user._id) });
        converted += 1;
        continue;
      }

      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) {
          throw new Error(`download failed with ${response.status}`);
        }

        const original = Buffer.from(await response.arrayBuffer());
        const image = await normalizeProfileImage(original);
        const uploaded = await uploadToR2(image, `profiles/profile-${crypto.randomUUID()}.webp`, 'image/webp');

        // Only swap if the user hasn't uploaded a new photo in the meantime.
        const swap = await users.updateOne(
          { _id: user._id, profileImageUrl: url },
          { $set: { profileImageUrl: uploaded.url } }
        );

        const staleKey = swap.modifiedCount === 1 ? extractKeyFromUrl(url) : extractKeyFromUrl(uploaded.url);
        if (staleKey) {
          await deleteFromR2(staleKey);
        }
        converted += swap.modifiedCount;
      } catch (error) {
        failed += 1;
        logger.warn('migration.reencode_profile_images.user_failed', {
          userId: String(user._id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('migration.reencode_profile_images.completed', { dryRun: DRY_RUN, converted, skipped, failed });
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((error: unknown) => {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  logger.error('migration.reencode_profile_images.failed', {
    message: normalizedError.message,
    stack: normalizedError.stack,
  });
  process.exit(1);
});
