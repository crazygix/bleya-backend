import mongoose from 'mongoose';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { toRoomLocation, type RoomLocation } from '../utils/room.js';
import type { LeanRoom, LeanJoinedRoomsUser } from '../types/lean.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';
import { type RoomRepository, roomRepository as defaultRoomRepo } from '../repositories/roomRepository.js';

const MAX_PUBLIC_ROOMS = 5;

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

export function toRoomSummary(room: LeanRoom): RoomSummaryDto {
    return {
        id: room._id.toString(),
        name: room.name,
        type: room.type || 'public',
        cityKey: room.cityKey || null,
        imageUrl: room.imageUrl || null,
        location: toRoomLocation(room),
    };
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPublicRoomFilter(searchQuery?: string): Record<string, unknown> {
    const filter: Record<string, unknown> = { type: 'public' };
    if (searchQuery) {
        filter.name = {
            $regex: new RegExp(escapeRegex(searchQuery), 'i'),
        };
    }

    return filter;
}

export function isPublicRoom(room: { type?: 'public' | 'private' }): boolean {
    return (room.type || 'public') === 'public';
}

export interface RoomServiceDeps {
    userRepo: UserRepository;
    roomRepo: RoomRepository;
}

export function createRoomService(deps: RoomServiceDeps) {
    const { userRepo, roomRepo } = deps;

    async function countJoinedPublicRooms(joinedRoomIds: mongoose.Types.ObjectId[]): Promise<number> {
        return roomRepo.countByFilter({
            _id: { $in: joinedRoomIds },
            type: 'public',
        });
    }

    async function listPublicRooms(input: ListPublicRoomsInput = {}): Promise<RoomSummaryDto[]> {
        const filter = buildPublicRoomFilter(input.searchQuery);
        const rooms = await roomRepo.findPublicRooms(filter, '_id name type cityKey imageUrl geo');
        return rooms.map((room) => toRoomSummary(room));
    }

    async function joinRoomForUser(input: JoinRoomForUserInput): Promise<JoinRoomResponseDto> {
        const room = await roomRepo.findById(input.roomId, '_id name type participants imageUrl cityKey geo');

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

        const user = await userRepo.findByIdSelectJoinedRooms(input.userId);

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

        const addResult = await userRepo.addToJoinedRooms(input.userId, input.roomId);

        if (addResult.modifiedCount === 0) {
            return {
                message: 'Already joined this room',
                room: roomSummary,
            };
        }

        if (isPublicRoom(room)) {
            const updatedUser = await userRepo.findByIdSelectJoinedRooms(input.userId);

            if (!updatedUser) {
                throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
            }

            const updatedPublicCount = await countJoinedPublicRooms(updatedUser.joinedRooms);
            if (updatedPublicCount > MAX_PUBLIC_ROOMS) {
                await userRepo.removeFromJoinedRooms(input.userId, input.roomId);
                throw new ValidationError('You can only join up to 5 group chats at a time.');
            }
        }

        return {
            message: 'Successfully joined room',
            room: roomSummary,
        };
    }

    return { listPublicRooms, joinRoomForUser };
}

const defaultRoomService = createRoomService({
    userRepo: defaultUserRepo,
    roomRepo: defaultRoomRepo,
});

export const listPublicRooms = defaultRoomService.listPublicRooms;
export const joinRoomForUser = defaultRoomService.joinRoomForUser;
