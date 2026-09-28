import sharp from 'sharp';
import { cityRepository } from '../repositories/cityRepository.js';
import { getImageService } from './imageService/index.js';
import { uploadToR2 } from './r2Service.js';
import { ICity } from '../models/City.js';
import { Room } from '../models/Room.js';
import logger from '../utils/logger.js';

// A city whose image lookup found nothing (or failed) is tried again after this.
const IMAGE_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_IMAGE_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_INPUT_PIXELS = 100_000_000;

// Lookups already running in this process.
const inFlightCityIds = new Set<string>();

export async function findNearbyCitiesWithImages(
    latitude: number,
    longitude: number,
    radiusKm: number,
    limit: number
): Promise<ICity[]> {
    const cities = await cityRepository.findNearby({
        latitude,
        longitude,
        radiusKm,
        limit,
    });

    // Missing images load in the background: the response never waits on
    // external APIs, and the image shows up from the next request on.
    for (const city of cities) {
        if (!city.imageUrl) {
            void loadCityImageInBackground(city);
        }
    }

    return cities;
}

async function loadCityImageInBackground(city: ICity): Promise<void> {
    if (inFlightCityIds.has(city._id)) {
        return;
    }

    inFlightCityIds.add(city._id);
    try {
        const claimed = await cityRepository.claimImageAttempt(
            city._id,
            new Date(Date.now() - IMAGE_RETRY_AFTER_MS)
        );
        if (claimed) {
            await fetchAndStoreImage(city);
        }
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('city.image.load_failed', { cityId: city._id, error: error.message });
    } finally {
        inFlightCityIds.delete(city._id);
    }
}

async function downloadImage(url: string): Promise<Buffer | null> {
    const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        logger.warn('city.image.download_failed', { status: response.status });
        return null;
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_DOWNLOAD_BYTES) {
        logger.warn('city.image.too_large', { bytes: declaredLength });
        return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_DOWNLOAD_BYTES) {
        logger.warn('city.image.too_large', { bytes: buffer.length });
        return null;
    }

    return buffer;
}

async function fetchAndStoreImage(city: ICity): Promise<void> {
    try {
        const imageService = getImageService();

        // 1. Find an image using name, country, and coordinates
        const imageResult = await imageService.searchCityImage({
            name: city.name,
            country: city.country,
            countryName: city.countryName,
            latitude: city.location.coordinates[1],
            longitude: city.location.coordinates[0],
        });

        if (!imageResult) {
            // imageCheckedAt (set when the attempt was claimed) holds off retries.
            logger.warn(`No image found for ${city.name}`);
            return;
        }

        // 2. Download image
        const buffer = await downloadImage(imageResult.url);
        if (!buffer) {
            return;
        }

        // 3. Resize to 800x500 WebP (optimized for room details hero image)
        // Room details screen shows 200px height image (full width ~390px)
        // 800x500 provides 2x retina quality while keeping file size reasonable (~50-70 KB)
        const resizedBuffer = await sharp(buffer, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
            .resize(800, 500, { fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();

        // 4. Upload to R2
        // Append timestamp to key to bypass R2/CDN caching of old images
        const timestamp = Date.now();
        const key = `cities/${city._id}-${timestamp}.webp`;
        const uploadResult = await uploadToR2(resizedBuffer, key, 'image/webp');

        // 5. Save URL to database
        await cityRepository.updateImageUrl(city._id, uploadResult.url);
        city.imageUrl = uploadResult.url; // Update in-memory reference

        logger.info(`✓ Fetched image for ${city.name}`);
    } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(`Failed to fetch image for ${city.name}`, { error: error.message, stack: error.stack });
    }
}

/**
 * Returns the public room for a city, creating it on first join. The unique
 * {cityKey, type} index makes concurrent first joins converge on one room: the
 * losing upsert gets a duplicate-key error and reads the winner's room.
 */
export async function findOrCreateCityRoom(city: ICity) {
    const filter = { cityKey: city._id, type: 'public' };
    try {
        return await Room.findOneAndUpdate(
            filter,
            {
                $setOnInsert: {
                    name: `${city.name}, ${city.countryName}`,
                    type: 'public',
                    cityKey: city._id,
                    imageUrl: city.imageUrl || undefined,
                    geo: {
                        type: 'Point',
                        coordinates: [city.location.coordinates[0], city.location.coordinates[1]],
                    },
                },
            },
            { upsert: true, new: true }
        );
    } catch (error) {
        if ((error as { code?: unknown }).code === 11000) {
            return Room.findOne(filter);
        }
        throw error;
    }
}
