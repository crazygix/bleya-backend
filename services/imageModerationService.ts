import { config } from '../config/index.js';
import logger from '../utils/logger.js';

// Image-safety check for uploaded images (profile pictures today; reusable for
// any upload): the image half of Apple 1.2's "filter objectionable material".
// Off (every image allowed) until a provider is configured:
//
//   IMAGE_MODERATION_PROVIDER=sightengine
//   IMAGE_MODERATION_API_KEY=<Sightengine api_user>
//   IMAGE_MODERATION_API_SECRET=<Sightengine api_secret>
//
// Enabling it adds Sightengine as a processor of profile photos, so the privacy
// policy's sub-processor list must say so.

export interface ImageModerationResult {
    allowed: boolean;
    // Shown to the user as-is when the image is rejected.
    reason?: string;
}

// https://sightengine.com/docs/advanced-nudity-detection-model-2.1
const SIGHTENGINE_CHECK_URL = 'https://api.sightengine.com/1.0/check.json';
const SIGHTENGINE_MODELS = 'nudity-2.1';
// Explicit classes, rejected at Sightengine's suggested score of 0.5 or more.
// Suggestive photos (swimwear, cleavage) are allowed.
const EXPLICIT_CLASSES = ['sexual_activity', 'sexual_display', 'erotica'] as const;
const EXPLICIT_THRESHOLD = 0.5;
const REQUEST_TIMEOUT_MS = 10_000;

const REJECTED_REASON = "This photo can't be used. Please choose a different one.";

interface SightengineResponse {
    status?: string;
    nudity?: Partial<Record<(typeof EXPLICIT_CLASSES)[number], number>>;
    error?: { message?: string };
}

export function isImageModerationConfigured(): boolean {
    const { provider, apiKey, apiSecret } = config.contentFilter.imageModeration;
    return provider === 'sightengine' && Boolean(apiKey && apiSecret);
}

async function explicitClassesFromSightengine(buffer: Buffer, mimeType: string): Promise<string[]> {
    const { apiKey, apiSecret } = config.contentFilter.imageModeration;
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(buffer)], { type: mimeType }), 'image');
    form.append('models', SIGHTENGINE_MODELS);
    form.append('api_user', apiKey);
    form.append('api_secret', apiSecret);

    const response = await fetch(SIGHTENGINE_CHECK_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => ({})) as SightengineResponse;
    if (!response.ok || body.status !== 'success' || !body.nudity) {
        throw new Error(`Sightengine check failed (${response.status}): ${body.error?.message ?? 'no result'}`);
    }

    const nudity = body.nudity;
    return EXPLICIT_CLASSES.filter((name) => (nudity[name] ?? 0) >= EXPLICIT_THRESHOLD);
}

export async function moderateImage(buffer: Buffer, mimeType: string): Promise<ImageModerationResult> {
    if (!isImageModerationConfigured()) {
        return { allowed: true };
    }

    try {
        const flagged = await explicitClassesFromSightengine(buffer, mimeType);
        if (flagged.length > 0) {
            logger.info('image_moderation.rejected', { classes: flagged });
            return { allowed: false, reason: REJECTED_REASON };
        }
        return { allowed: true };
    } catch (error) {
        // Fail-open: don't block uploads on a moderation-provider outage; log it.
        logger.error('image_moderation.error', {
            error: error instanceof Error ? error.message : 'unknown',
        });
        return { allowed: true };
    }
}
