import express from 'express';
import { config } from '../config/index.js';
import { findNearbyCitiesWithImages } from '../services/cityService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { cityRepository } from '../repositories/cityRepository.js';
import { Room } from '../models/Room.js';
import { joinRoomForUser } from '../services/roomService.js';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';

const router = express.Router();

router.get(
    '/nearby',
    asyncHandler(async (req: express.Request, res: express.Response) => {
        const lat = parseFloat(req.query.lat as string);
        const lng = parseFloat(req.query.lng as string);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            throw new ValidationError('Invalid lat/lng coordinates');
        }

        // Backend-controlled parameters
        const radiusKm = config.citySearch.defaultRadiusKm;
        const limit = config.citySearch.defaultLimit;

        const cities = await findNearbyCitiesWithImages(lat, lng, radiusKm, limit);

        // Format response (follow API format rules)
        res.json(
            cities.map((city) => ({
                id: city._id,
                name: city.name,
                country: city.country,
                countryName: city.countryName,
                latitude: city.location.coordinates[1],
                longitude: city.location.coordinates[0],
                imageUrl: city.imageUrl || null,
                lastUpdated: city.lastUpdated?.getTime() || null, // Timestamp in ms
            }))
        );
    })
);

router.post(
    '/:cityId/join',
    authenticateUser,
    asyncHandler(async (req: AuthRequest, res: express.Response) => {
        const userId = req.user!.userId;
        const cityId = req.params.cityId;

        // 1. Verify city exists
        const city = await cityRepository.findById(cityId);
        if (!city) {
            throw new NotFoundError('City not found', ErrorCode.CITY_NOT_FOUND);
        }

        // 2. Find or create room for this city
        let room = await Room.findOne({ cityKey: cityId });
        if (!room) {
            room = await Room.create({
                name: `${city.name}, ${city.countryName}`,
                type: 'public',
                cityKey: cityId,
                imageUrl: city.imageUrl || undefined,
                geo: {
                    type: 'Point',
                    coordinates: [city.location.coordinates[0], city.location.coordinates[1]],
                },
            });
        }

        // 3. Join user to room
        await joinRoomForUser({ userId, roomId: room._id });

        res.json({
            room: {
                id: room._id.toString(),
                name: room.name,
                cityKey: room.cityKey,
                imageUrl: room.imageUrl || null,
            },
        });
    })
);

export default router;
