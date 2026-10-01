import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
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
        findEnforcementState: async () => null,
        create: async () => null as any,
        updateLastLogin: async () => {},
        findByUsernameLean: async () => null,
        rotateRefreshToken: async () => null,
        reissueFromPreviousRefreshToken: async () => null,
        findByRecentPreviousRefreshToken: async () => null,
        clearRefreshToken: async () => null,
        findEnforcementByRevokedRefreshToken: async () => null,
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
        findDistinctReplyAuthorIds: async () => [],
        ...overrides,
    };
}

// Wraps the service factory with a no-op block lookup by default so each test
// only specifies the repos it cares about (override getBlockedPairUserIds to
// simulate active blocks).
function buildService(deps: {
    userRepo: UserRepository;
    roomRepo: RoomRepository;
    messageRepo: MessageRepository;
    getBlockedPairUserIds?: (userId: string) => Promise<string[]>;
}) {
    return createMessageService({
        userRepo: deps.userRepo,
        roomRepo: deps.roomRepo,
        messageRepo: deps.messageRepo,
        getBlockedPairUserIds: deps.getBlockedPairUserIds ?? (async () => []),
    });
}

describe('messageService (mocked repos)', () => {
    it('creates a top-level message successfully', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const userId = new mongoose.Types.ObjectId();
        const room: LeanRoom = {
            _id: roomId,
            name: 'Test Room',
            type: 'public',
            participants: [],
        };

        const svc = buildService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findByIdSelectUsername: async () => ({ _id: userId, username: 'alice' }),
                findJoinedUserIds: async () => [userId.toString(), 'other-user-id'],
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
        assert.deepEqual(result.candidateRecipientUserIds, ['other-user-id']);
    });

    it('excludes blocked-pair users from recipients and returns them for broadcast filtering', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const userId = new mongoose.Types.ObjectId();
        const blockedId = '507f1f77bcf86cd799439011';
        const room: LeanRoom = {
            _id: roomId,
            name: 'Test Room',
            type: 'public',
            participants: [],
        };

        const svc = buildService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findByIdSelectUsername: async () => ({ _id: userId, username: 'alice' }),
                findJoinedUserIds: async () => [userId.toString(), blockedId, 'other-user-id'],
            }),
            roomRepo: fakeRoomRepo({ findById: async () => room }),
            messageRepo: fakeMessageRepo(),
            getBlockedPairUserIds: async () => [blockedId],
        });

        const result = await svc.createMessage({
            userId: userId.toString(),
            roomId: roomId.toString(),
            text: 'Hello world',
        });

        assert.deepEqual(result.candidateRecipientUserIds, ['other-user-id']);
        assert.deepEqual(result.blockedPairUserIds, [blockedId]);
    });

    it('creates a reply and increments reply count', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const userId = new mongoose.Types.ObjectId();
        const parentId = new mongoose.Types.ObjectId();
        let replyCountIncremented = false;

        const parentMessage: LeanMessage = {
            _id: parentId,
            roomId,
            userId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'),
            text: 'Parent',
            createdAt: new Date(),
            parentMessageId: null,
            replyCount: 0,
        };

        const svc = buildService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findByIdSelectUsername: async () => ({ _id: userId, username: 'bob' }),
                findJoinedUserIds: async () => [
                    userId.toString(),
                    '507f1f77bcf86cd799439011',
                    '507f191e810c19729de860ea',
                    '507f1f77bcf86cd799439099',
                ],
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
                findDistinctReplyAuthorIds: async () => [
                    new mongoose.Types.ObjectId('507f191e810c19729de860ea'),
                    new mongoose.Types.ObjectId('507f191e810c19729de860ea'),
                    new mongoose.Types.ObjectId('507f1f77bcf86cd799439099'),
                ],
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
        assert.deepEqual(result.candidateRecipientUserIds, [
            '507f1f77bcf86cd799439011',
            '507f191e810c19729de860ea',
            '507f1f77bcf86cd799439099',
        ]);
    });

    it('rejects a sender whose account is blocked from acting (banned/suspended)', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const room: LeanRoom = {
            _id: roomId,
            name: 'Test Room',
            type: 'public',
            participants: [],
        };

        const svc = buildService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findEnforcementState: async () => ({ status: 'banned', enforcementReason: 'Banned for spam.' }),
            }),
            roomRepo: fakeRoomRepo({ findById: async () => room }),
            messageRepo: fakeMessageRepo(),
        });

        // Same sentence as sign-in and the socket handshake.
        await assert.rejects(
            () => svc.createMessage({
                userId: new mongoose.Types.ObjectId().toString(),
                roomId: roomId.toString(),
                text: 'Hello',
            }),
            {
                code: 'FORBIDDEN',
                message: 'Your account has been banned. Reason: Banned for spam.',
            }
        );
    });

    it('tells a suspended sender until when', async () => {
        const roomId = new mongoose.Types.ObjectId();
        const svc = buildService({
            userRepo: fakeUserRepo({
                existsWithRoom: async () => true,
                findEnforcementState: async () => ({
                    status: 'suspended',
                    suspendedUntil: new Date('2999-01-02T00:00:00Z'),
                    enforcementReason: 'Spam',
                }),
            }),
            roomRepo: fakeRoomRepo({
                findById: async () => ({ _id: roomId, name: 'Room', type: 'public', participants: [] }),
            }),
            messageRepo: fakeMessageRepo(),
        });

        await assert.rejects(
            () => svc.createMessage({
                userId: new mongoose.Types.ObjectId().toString(),
                roomId: roomId.toString(),
                text: 'Hello',
            }),
            {
                code: 'FORBIDDEN',
                message: 'Your account is suspended until 2999-01-02. Reason: Spam',
            }
        );
    });

    it('throws when room not found', async () => {
        const svc = buildService({
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
        const svc = buildService({
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
        const svc = buildService({
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
