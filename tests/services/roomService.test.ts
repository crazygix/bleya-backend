import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createRoomService } from '../../services/roomService.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { RoomRepository } from '../../repositories/roomRepository.js';
import type { LeanRoom, LeanJoinedRoomsUser } from '../../types/lean.js';

function fakeRoom(overrides: Partial<LeanRoom> = {}): LeanRoom {
    return {
        _id: new mongoose.Types.ObjectId(),
        name: 'Test Room',
        type: 'public',
        ...overrides,
    };
}

function fakeUserRepo(overrides: Partial<UserRepository> = {}): UserRepository {
    return {
        findById: async () => null,
        findByIdLean: async () => null,
        findByIdSelectJoinedRooms: async () => null,
        findByIdSelectUsername: async () => null,
        create: async () => null as any,
        updateLastLogin: async () => {},
        findByUsernameLean: async () => null,
        findOneAndUpdateByRefreshToken: async () => null,
        clearRefreshToken: async () => {},
        addToJoinedRooms: async () => ({ modifiedCount: 0 }),
        removeFromJoinedRooms: async () => {},
        existsWithRoom: async () => false,
        findByIds: async () => [],
        findJoinedUserIds: async () => [],
        ...overrides,
    };
}

function fakeRoomRepo(overrides: Partial<RoomRepository> = {}): RoomRepository {
    return {
        findById: async () => null,
        findPublicRooms: async () => [],
        countByFilter: async () => 0,
        ...overrides,
    };
}

describe('roomService (mocked)', () => {
    describe('joinRoomForUser', () => {
        it('joins a public room successfully', async () => {
            const roomId = new mongoose.Types.ObjectId();
            const room = fakeRoom({ _id: roomId, type: 'public' });
            const user: LeanJoinedRoomsUser = { joinedRooms: [] };

            const svc = createRoomService({
                userRepo: fakeUserRepo({
                    findByIdSelectJoinedRooms: async () => user,
                    addToJoinedRooms: async () => ({ modifiedCount: 1 }),
                }),
                roomRepo: fakeRoomRepo({
                    findById: async () => room,
                    countByFilter: async () => 1,
                }),
            });

            const result = await svc.joinRoomForUser({ userId: 'user1', roomId });
            assert.equal(result.message, 'Successfully joined room');
            assert.equal(result.room.name, 'Test Room');
        });

        it('returns already joined when user is a member', async () => {
            const roomId = new mongoose.Types.ObjectId();
            const room = fakeRoom({ _id: roomId });
            const user: LeanJoinedRoomsUser = { joinedRooms: [roomId] };

            const svc = createRoomService({
                userRepo: fakeUserRepo({
                    findByIdSelectJoinedRooms: async () => user,
                }),
                roomRepo: fakeRoomRepo({
                    findById: async () => room,
                }),
            });

            const result = await svc.joinRoomForUser({ userId: 'user1', roomId });
            assert.ok(result.message.toLowerCase().includes('already'));
        });

        it('throws when exceeding max public rooms', async () => {
            const roomId = new mongoose.Types.ObjectId();
            const room = fakeRoom({ _id: roomId, type: 'public' });
            const user: LeanJoinedRoomsUser = { joinedRooms: [] };

            const svc = createRoomService({
                userRepo: fakeUserRepo({
                    findByIdSelectJoinedRooms: async () => user,
                }),
                roomRepo: fakeRoomRepo({
                    findById: async () => room,
                    countByFilter: async () => 5,
                }),
            });

            await assert.rejects(
                () => svc.joinRoomForUser({ userId: 'user1', roomId }),
                (err: Error) => err.message.includes('5 group chats')
            );
        });

        it('rejects non-participant joining private room', async () => {
            const roomId = new mongoose.Types.ObjectId();
            const room = fakeRoom({
                _id: roomId,
                type: 'private',
                participants: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
            });

            const svc = createRoomService({
                userRepo: fakeUserRepo(),
                roomRepo: fakeRoomRepo({
                    findById: async () => room,
                }),
            });

            await assert.rejects(
                () => svc.joinRoomForUser({ userId: 'notaparticipant', roomId }),
                (err: Error) => err.message.includes('not allowed')
            );
        });

        it('throws when room not found', async () => {
            const svc = createRoomService({
                userRepo: fakeUserRepo(),
                roomRepo: fakeRoomRepo({ findById: async () => null }),
            });

            await assert.rejects(
                () => svc.joinRoomForUser({
                    userId: 'user1',
                    roomId: new mongoose.Types.ObjectId(),
                }),
                (err: Error) => err.message.includes('Room not found')
            );
        });
    });

    describe('listPublicRooms', () => {
        it('returns formatted room summaries', async () => {
            const rooms = [
                fakeRoom({ name: 'Berlin' }),
                fakeRoom({ name: 'Paris' }),
            ];

            const svc = createRoomService({
                userRepo: fakeUserRepo(),
                roomRepo: fakeRoomRepo({
                    findPublicRooms: async () => rooms,
                }),
            });

            const result = await svc.listPublicRooms();
            assert.equal(result.length, 2);
            assert.equal(result[0].name, 'Berlin');
            assert.equal(result[1].name, 'Paris');
        });

        it('returns empty array when no rooms', async () => {
            const svc = createRoomService({
                userRepo: fakeUserRepo(),
                roomRepo: fakeRoomRepo({
                    findPublicRooms: async () => [],
                }),
            });

            const result = await svc.listPublicRooms();
            assert.equal(result.length, 0);
        });
    });
});
