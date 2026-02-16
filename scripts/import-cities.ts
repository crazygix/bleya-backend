import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { cityRepository } from '../repositories/cityRepository.js';
import logger from '../utils/logger.js';

interface CityJsonEntry {
    name: string;
    lat: number;
    lng: number;
    country: string;
    country_name: string;
    population?: number;
}

function createCitySlug(name: string, country: string, lat: number, lng: number): string {
    // Use 8-char hash of coordinates for uniqueness while keeping IDs clean
    const coordHash = crypto.createHash('md5')
        .update(`${lat},${lng}`)
        .digest('hex')
        .substring(0, 8);

    return `${name}-${country}-${coordHash}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-|-$/g, '');
}

async function importCities(jsonPath: string) {
    await mongoose.connect(config.mongoUri);

    const jsonContent = await fs.readFile(jsonPath, 'utf-8');
    const cities: CityJsonEntry[] = JSON.parse(jsonContent);

    logger.info(`Importing ${cities.length} cities...`);

    const batchSize = 1000;
    for (let i = 0; i < cities.length; i += batchSize) {
        const batch = cities.slice(i, i + batchSize);
        const cityDocs = batch.map((city) => ({
            _id: createCitySlug(city.name, city.country, city.lat, city.lng),
            name: city.name,
            country: city.country,
            countryName: city.country_name,
            location: {
                type: 'Point' as const,
                coordinates: [city.lng, city.lat] as [number, number],
            },
            population: city.population,
        }));

        await cityRepository.upsertMany(cityDocs);
        logger.info(`Imported ${i + batch.length} / ${cities.length}`);
    }

    logger.info('Import complete!');
    await mongoose.disconnect();
}

const jsonPath = process.argv[2] || path.resolve(process.cwd(), 'cities.json');
importCities(jsonPath).catch((err) => {
    logger.error('Import failed', err);
    process.exit(1);
});
