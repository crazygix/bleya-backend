import sharp from 'sharp';
import { cityRepository } from '../repositories/cityRepository.js';
import { imageService } from './imageService/index.js';
import { uploadToR2 } from './r2Service.js';
import { ICity } from '../models/City.js';
import logger from '../utils/logger.js';

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

    // Lazy-load missing images
    await Promise.all(
        cities.map(async (city) => {
            if (!city.imageUrl) {
                await fetchAndStoreImage(city);
            }
        })
    );

    return cities;
}

async function fetchAndStoreImage(city: ICity): Promise<void> {
    try {
        // 1. Fetch image from Wikidata using name, country, and coordinates
        const imageResult = await imageService.searchCityImage({
            name: city.name,
            country: city.country,
            countryName: city.countryName,
            latitude: city.location.coordinates[1],
            longitude: city.location.coordinates[0],
        });

        if (!imageResult) {
            logger.warn(`No image found for ${city.name}`);
            await cityRepository.updateImageUrl(city._id, ''); // Store empty to skip retry
            return;
        }

        // 2. Download image
        const response = await fetch(imageResult.url);
        const buffer = Buffer.from(await response.arrayBuffer());

        // 3. Resize to 800x500 WebP (optimized for room details hero image)
        // Room details screen shows 200px height image (full width ~390px)
        // 800x500 provides 2x retina quality while keeping file size reasonable (~50-70 KB)
        const resizedBuffer = await sharp(buffer)
            .resize(800, 500, { fit: 'cover' })
            .webp({ quality: 80 })
            .toBuffer();

        // 4. Upload to R2
        const key = `cities/${city._id}.webp`;
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
