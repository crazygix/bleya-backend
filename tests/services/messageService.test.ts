import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createMessageService } from '../../services/messageService.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { RoomRepository } from '../../repositories/roomRepository.js';
import type { MessageRepository } from '../../repositories/messageRepository.js';
import type { LeanRoom, LeanMessage } from '../../types/lean.js';

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

function fakeMessageRepo(overrides: Partial<MessageRepository> = {}): MessageRepository {
    return {
        create: async (data) => ({
            _id: new mongoose.Types.ObjectId(),
            roomId: data.roomId,
            userId: data.userId,
            text: data.text,
            createdAt: new Date(),
            parentMessageId: data.parentMessageId,
            replyCount: 0,
        }),
        findByIdLean: async () => null,
        incrementReplyCount: async () => {},
        ...overrides,
    };
}

// We need a real DB for NotificationService which is called internally
describe('messageService (mocked repos)', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
    });

    it('creates a top-level message successfully', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const userId = new mongoose.Types.ObjectId();
        const room: LeanRoom = {
            _id: roomId,
            name: 'Test Room',
            type: 'public',
            participants: [],
        };

        const svc = createMessageService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findByIdSelectUsername: async () => ({ _id: userId, username: 'alice' }),
            }),
            roomRepo: fakeRoomRepo({
                findById: async () => room,
            }),
            messageRepo: fakeMessageRepo(),
        });

        const result = await svc.createMessage({
            userId: userId.toString(),
            roomId: roomId.toString(),
            text: 'Hello world',
        });

        assert.equal(result.messageData.text, 'Hello world');
        assert.equal(result.messageData.username, 'alice');
        assert.equal(result.isTopLevel, true);
        assert.equal(result.notificationTargets.length, 0);
    });

    it('creates a reply and increments reply count', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const userId = new mongoose.Types.ObjectId();
        const parentId = new mongoose.Types.ObjectId();
        let replyCountIncremented = false;

        const parentMessage: LeanMessage = {
            _id: parentId,
            roomId,
            userId: new mongoose.Types.ObjectId(),
            text: 'Parent',
            createdAt: new Date(),
            parentMessageId: null,
            replyCount: 0,
        };

        const svc = createMessageService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findByIdSelectUsername: async () => ({ _id: userId, username: 'bob' }),
            }),
            roomRepo: fakeRoomRepo({
                findById: async () => ({
                    _id: roomId,
                    name: 'Test Room',
                    type: 'public',
                    participants: [],
                }),
            }),
            messageRepo: fakeMessageRepo({
                findByIdLean: async () => parentMessage,
                incrementReplyCount: async () => { replyCountIncremented = true; },
            }),
        });

        const result = await svc.createMessage({
            userId: userId.toString(),
            roomId: roomId.toString(),
            text: 'Reply text',
            parentMessageId: parentId.toString(),
        });

        assert.equal(result.messageData.text, 'Reply text');
        assert.equal(result.isTopLevel, false);
        assert.ok(replyCountIncremented);
    });

    it('throws when room not found', async () => {
        const svc = createMessageService({
            userRepo: fakeUserRepo(),
            roomRepo: fakeRoomRepo({ findById: async () => null }),
            messageRepo: fakeMessageRepo(),
        });

        await assert.rejects(
            () => svc.createMessage({
                userId: new mongoose.Types.ObjectId().toString(),
                roomId: new mongoose.Types.ObjectId().toString(),
                text: 'Hello',
            }),
            (err: Error) => err.message.includes('Room not found')
        );
    });

    it('throws when user not in room', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const svc = createMessageService({
            userRepo: fakeUserRepo({ existsWithRoom: async () => false }),
            roomRepo: fakeRoomRepo({
                findById: async () => ({
                    _id: roomId,
                    name: 'Room',
                    type: 'public',
                }),
            }),
            messageRepo: fakeMessageRepo(),
        });

        await assert.rejects(
            () => svc.createMessage({
                userId: new mongoose.Types.ObjectId().toString(),
                roomId: roomId.toString(),
                text: 'Hello',
            }),
            (err: Error) => err.message.includes('not a member')
        );
    });

    it('throws on empty message text', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const svc = createMessageService({
            userRepo: fakeUserRepo({ existsWithRoom: async () => true }),
            roomRepo: fakeRoomRepo({
                findById: async () => ({
                    _id: roomId,
                    name: 'Room',
                    type: 'public',
                }),
            }),
            messageRepo: fakeMessageRepo(),
        });

        await assert.rejects(
            () => svc.createMessage({
                userId: new mongoose.Types.ObjectId().toString(),
                roomId: roomId.toString(),
                text: '',
            }),
            (err: Error) => err.message.includes('cannot be empty')
        );
    });
});
