import { City, ICity } from '../models/City.js';

export interface NearbyCitiesQuery {
    latitude: number;
    longitude: number;
    radiusKm: number;
    limit: number;
}

export interface CityRepository {
    findById(cityId: string): Promise<ICity | null>;
    findNearby(query: NearbyCitiesQuery): Promise<ICity[]>;
    upsertMany(cities: Partial<ICity>[]): Promise<void>;
    updateImageUrl(cityId: string, imageUrl: string): Promise<void>;
    // Atomically claims an image lookup for a city that still has no image and
    // wasn't tried since `retryBefore`. False when someone else has it.
    claimImageAttempt(cityId: string, retryBefore: Date): Promise<boolean>;
}

class MongoCityRepository implements CityRepository {
    async findById(cityId: string): Promise<ICity | null> {
        return City.findById(cityId).lean<ICity | null>().exec();
    }

    async findNearby(query: NearbyCitiesQuery): Promise<ICity[]> {
        return City.find({
            location: {
                $near: {
                    $geometry: {
                        type: 'Point',
                        coordinates: [query.longitude, query.latitude],
                    },
                    $maxDistance: query.radiusKm * 1000,
                },
            },
        })
            .limit(query.limit)
            .lean<ICity[]>()
            .exec();
    }

    async upsertMany(cities: Partial<ICity>[]): Promise<void> {
        const bulkOps = cities.map((city) => ({
            updateOne: {
                filter: { _id: city._id },
                update: {
                    $set: {
                        name: city.name,
                        country: city.country,
                        countryName: city.countryName,
                        location: city.location,
                        population: city.population,
                        lastUpdated: new Date(),
                    },
                    $setOnInsert: { imageUrl: city.imageUrl },
                },
                upsert: true,
            },
        }));

        await City.bulkWrite(bulkOps);
    }

    async updateImageUrl(cityId: string, imageUrl: string): Promise<void> {
        await City.updateOne({ _id: cityId }, { $set: { imageUrl } });
    }

    async claimImageAttempt(cityId: string, retryBefore: Date): Promise<boolean> {
        const result = await City.updateOne(
            {
                _id: cityId,
                $and: [
                    { $or: [{ imageUrl: { $exists: false } }, { imageUrl: null }, { imageUrl: '' }] },
                    { $or: [{ imageCheckedAt: null }, { imageCheckedAt: { $lt: retryBefore } }] },
                ],
            },
            { $set: { imageCheckedAt: new Date() } }
        );
        return result.modifiedCount === 1;
    }
}

export const cityRepository: CityRepository = new MongoCityRepository();
