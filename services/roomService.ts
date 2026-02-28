import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';

import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';

const MAX_PUBLIC_ROOMS = 5;

interface GeoPoint {
    type?: 'Point';
    coordinates?: number[];
}

interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    type?: 'public' | 'private';
    participants?: mongoose.Types.ObjectId[];
    cityKey?: string;
    imageUrl?: string;
    geo?: GeoPoint;
}

interface LeanJoinedRoomsUser {
    joinedRooms: mongoose.Types.ObjectId[];
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

export interface JoinRoomResponseDto {
    message: string;
    room: RoomSummaryDto;
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
        .select('_id name type participants imageUrl cityKey geo')
        .lean<LeanRoom | null>();

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    if ((room.type || 'public') === 'private') {
        const isParticipant = (room.participants || []).some((participantId) => participantId.equals(input.userId));
        if (!isParticipant) {
            throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to join this chat.', 403);
        }
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
