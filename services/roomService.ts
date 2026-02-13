import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { discoverNearbyCities } from './cityDiscoveryService.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import logger from '../utils/logger.js';

const MAX_PUBLIC_ROOMS = 5;
export const FIXED_DISCOVERY_RADIUS_KM = 100;

interface GeoPoint {
    type?: 'Point';
    coordinates?: number[];
}

interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    type?: 'public' | 'private';
    cityKey?: string;
    imageUrl?: string;
    geo?: GeoPoint;
}

interface LeanJoinedRoomsUser {
    joinedRooms: mongoose.Types.ObjectId[];
}

interface NearbyRoomAgg {
    _id: mongoose.Types.ObjectId;
    name: string;
    type?: 'public' | 'private';
    cityKey?: string;
    imageUrl?: string;
    geo?: GeoPoint;
    distanceMeters: number;
}

export interface RoomLocation {
    latitude: number;
    longitude: number;
}

export interface RoomSummaryDto {
    id: string;
    name: string;
    type: 'public' | 'private';
    cityKey: string | null;
    imageUrl: string | null;
    location: RoomLocation | null;
}

export interface NearbyRoomDto extends RoomSummaryDto {
    distanceKm: number;
    isJoined: boolean;
}

export interface NearbyRoomsResponseDto {
    rooms: NearbyRoomDto[];
}

export interface JoinRoomResponseDto {
    message: string;
    room: RoomSummaryDto;
}

interface GetNearbyRoomsForUserInput {
    userId: string;
    latitude: number;
    longitude: number;
    radiusKm: number;
    limit: number;
    searchQuery?: string;
}

interface JoinRoomForUserInput {
    userId: string;
    roomId: mongoose.Types.ObjectId;
}

interface ListPublicRoomsInput {
    searchQuery?: string;
}

function toRoomLocation(room: { geo?: GeoPoint }): RoomLocation | null {
    const coordinates = room.geo?.coordinates;
    if (!coordinates || coordinates.length < 2) {
        return null;
    }

    const [longitude, latitude] = coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return null;
    }

    return { latitude, longitude };
}

function toRoomSummary(room: LeanRoom): RoomSummaryDto {
    return {
        id: room._id.toString(),
        name: room.name,
        type: room.type || 'public',
        cityKey: room.cityKey || null,
        imageUrl: room.imageUrl || null,
        location: toRoomLocation(room),
    };
}

function toRadians(value: number): number {
    return value * (Math.PI / 180);
}

function distanceInKm(
    fromLatitude: number,
    fromLongitude: number,
    toLatitude: number,
    toLongitude: number
): number {
    const earthRadiusKm = 6371;
    const deltaLat = toRadians(toLatitude - fromLatitude);
    const deltaLon = toRadians(toLongitude - fromLongitude);

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
        + Math.cos(toRadians(fromLatitude))
        * Math.cos(toRadians(toLatitude))
        * Math.sin(deltaLon / 2)
        * Math.sin(deltaLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPublicRoomFilter(searchQuery?: string): Record<string, unknown> {
    const filter: Record<string, unknown> = { type: 'public' };
    if (searchQuery) {
        filter.name = {
            $regex: new RegExp(escapeRegex(searchQuery), 'i'),
        };
    }

    return filter;
}

function isPublicRoom(room: { type?: 'public' | 'private' }): boolean {
    return (room.type || 'public') === 'public';
}

async function countJoinedPublicRooms(joinedRoomIds: mongoose.Types.ObjectId[]): Promise<number> {
    return Room.countDocuments({
        _id: { $in: joinedRoomIds },
        type: 'public',
    });
}

async function syncNearbyCityRooms(input: {
    userId: string;
    latitude: number;
    longitude: number;
    radiusKm: number;
    limit: number;
}): Promise<void> {
    try {
        const discoveredCities = await discoverNearbyCities({
            latitude: input.latitude,
            longitude: input.longitude,
            radiusKm: input.radiusKm,
            limit: input.limit,
        });

        if (discoveredCities.length === 0) {
            return;
        }

        await Room.bulkWrite(discoveredCities.map((city) => {
            const updateSet: Record<string, unknown> = {
                cityKey: city.cityKey,
                name: city.name,
                geo: {
                    type: 'Point',
                    coordinates: [city.longitude, city.latitude],
                },
            };

            if (city.imageUrl) {
                updateSet.imageUrl = city.imageUrl;
            }

            return {
                updateOne: {
                    filter: {
                        type: 'public',
                        cityKey: city.cityKey,
                    },
                    update: {
                        $set: updateSet,
                        $setOnInsert: {
                            type: 'public',
                        },
                    },
                    upsert: true,
                },
            };
        }), { ordered: false });
    } catch (error) {
        logger.warn('rooms.nearby.discovery_failed', {
            userId: input.userId,
            latitude: input.latitude,
            longitude: input.longitude,
            radiusKm: input.radiusKm,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function getNearbyRoomsForUser(input: GetNearbyRoomsForUserInput): Promise<NearbyRoomsResponseDto> {
    const user = await User.findById(input.userId)
        .select('joinedRooms')
        .lean<LeanJoinedRoomsUser | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    await syncNearbyCityRooms({
        userId: input.userId,
        latitude: input.latitude,
        longitude: input.longitude,
        radiusKm: input.radiusKm,
        limit: input.limit,
    });

    const publicRoomFilter = buildPublicRoomFilter(input.searchQuery);
    const radiusMeters = Math.round(input.radiusKm * 1000);
    let nearbyRooms: NearbyRoomAgg[] = [];

    try {
        nearbyRooms = await Room.aggregate<NearbyRoomAgg>([
            {
                $geoNear: {
                    near: {
                        type: 'Point',
                        coordinates: [input.longitude, input.latitude],
                    },
                    key: 'geo',
                    distanceField: 'distanceMeters',
                    maxDistance: radiusMeters,
                    spherical: true,
                    query: publicRoomFilter,
                },
            },
            { $limit: input.limit },
            {
                $project: {
                    _id: 1,
                    name: 1,
                    type: 1,
                    cityKey: 1,
                    imageUrl: 1,
                    geo: 1,
                    distanceMeters: 1,
                },
            },
        ]);
    } catch (error) {
        logger.warn('rooms.nearby.geo_query_failed', {
            userId: input.userId,
            latitude: input.latitude,
            longitude: input.longitude,
            radiusKm: input.radiusKm,
            error: error instanceof Error ? error.message : String(error),
        });

        const fallbackRooms = await Room.find({
            ...publicRoomFilter,
            'geo.type': 'Point',
        })
            .select('_id name type cityKey imageUrl geo')
            .lean<LeanRoom[]>();

        const fallbackCandidates: Array<NearbyRoomAgg | null> = fallbackRooms.map((room): NearbyRoomAgg | null => {
            const roomLocation = toRoomLocation(room);
            if (!roomLocation) {
                return null;
            }

            const roomDistanceKm = distanceInKm(
                input.latitude,
                input.longitude,
                roomLocation.latitude,
                roomLocation.longitude
            );

            if (roomDistanceKm > input.radiusKm) {
                return null;
            }

            return {
                _id: room._id,
                name: room.name,
                type: room.type,
                cityKey: room.cityKey,
                imageUrl: room.imageUrl,
                geo: room.geo,
                distanceMeters: roomDistanceKm * 1000,
            };
        });

        nearbyRooms = fallbackCandidates
            .filter((room): room is NearbyRoomAgg => room !== null)
            .sort((a, b) => a.distanceMeters - b.distanceMeters)
            .slice(0, input.limit);
    }

    const joinedRoomIds = new Set(user.joinedRooms.map((roomId) => roomId.toString()));
    const rooms = nearbyRooms.map((room) => ({
        ...toRoomSummary(room),
        distanceKm: Number((room.distanceMeters / 1000).toFixed(2)),
        isJoined: joinedRoomIds.has(room._id.toString()),
    }));

    return { rooms };
}

export async function listPublicRooms(input: ListPublicRoomsInput = {}): Promise<RoomSummaryDto[]> {
    const filter = buildPublicRoomFilter(input.searchQuery);
    const rooms = await Room.find(filter)
        .sort({ name: 1 })
        .select('_id name type cityKey imageUrl geo')
        .lean<LeanRoom[]>();

    return rooms.map((room) => toRoomSummary(room));
}

export async function joinRoomForUser(input: JoinRoomForUserInput): Promise<JoinRoomResponseDto> {
    const room = await Room.findById(input.roomId)
        .select('_id name type imageUrl cityKey geo')
        .lean<LeanRoom | null>();

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    const roomSummary = toRoomSummary(room);

    const user = await User.findById(input.userId)
        .select('joinedRooms')
        .lean<LeanJoinedRoomsUser | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const alreadyJoined = user.joinedRooms.some((id) => id.equals(input.roomId));
    if (alreadyJoined) {
        return {
            message: 'Already joined this room',
            room: roomSummary,
        };
    }

    if (isPublicRoom(room)) {
        const publicRoomCount = await countJoinedPublicRooms(user.joinedRooms);
        if (publicRoomCount >= MAX_PUBLIC_ROOMS) {
            throw new ValidationError('You can only join up to 5 group chats at a time.');
        }
    }

    const addResult = await User.updateOne(
        { _id: input.userId, joinedRooms: { $ne: input.roomId } },
        { $addToSet: { joinedRooms: input.roomId } }
    );

    if (addResult.modifiedCount === 0) {
        return {
            message: 'Already joined this room',
            room: roomSummary,
        };
    }

    if (isPublicRoom(room)) {
        const updatedUser = await User.findById(input.userId)
            .select('joinedRooms')
            .lean<LeanJoinedRoomsUser | null>();

        if (!updatedUser) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        const updatedPublicCount = await countJoinedPublicRooms(updatedUser.joinedRooms);
        if (updatedPublicCount > MAX_PUBLIC_ROOMS) {
            await User.updateOne(
                { _id: input.userId },
                { $pull: { joinedRooms: input.roomId } }
            );
            throw new ValidationError('You can only join up to 5 group chats at a time.');
        }
    }

    return {
        message: 'Successfully joined room',
        room: roomSummary,
    };
}
