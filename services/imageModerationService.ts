import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Image-safety hook for uploaded images (profile pictures today; reusable for any
// upload). Until an image-moderation provider is configured this allows
// everything (no-op), so it's safe to ship now. Integrating a provider
// (Sightengine / WebPurify / Hive) is the remaining piece of Apple 1.2's
// "filter objectionable material" pillar for images.

export interface ImageModerationResult {
    allowed: boolean;
    reason?: string;
}

export function isImageModerationConfigured(): boolean {
    const im = config.contentFilter.imageModeration;
    return Boolean(im.provider && im.apiKey);
}

export async function moderateImage(buffer: Buffer, mimeType: string): Promise<ImageModerationResult> {
    if (!isImageModerationConfigured()) {
        return { allowed: true };
    }

    try {
        // TODO(provider): call config.contentFilter.imageModeration.provider's API
        // with the image bytes and return { allowed: false, reason } when it flags
        // nudity/violence/etc. Keep the shape below so callers don't change.
        void buffer;
        void mimeType;
        return { allowed: true };
    } catch (error) {
        // Fail-open: don't block uploads on a moderation-provider outage; log it.
        logger.error('image_moderation.error', {
            error: error instanceof Error ? error.message : 'unknown',
        });
        return { allowed: true };
    }
}
