import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { User } from '../../models/User.js';
import { UserBlock } from '../../models/UserBlock.js';

async function createRoomWithMember() {
    const room = await Room.create({ name: `Room-${Date.now()}`, type: 'public' });
    const roomId = room._id as mongoose.Types.ObjectId;
    const user = await createTestUser({ joinedRooms: [roomId] });
    return { room, user };
}

async function createActiveBlock(
    blockerUserId: mongoose.Types.ObjectId,
    blockedUserId: mongoose.Types.ObjectId
) {
    await UserBlock.create({ blockerUserId, blockedUserId, isActive: true, source: 'user_action' });
}

describe('Messages API', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetTestApp();
    });

    describe('GET /v1/rooms/:roomId/messages', () => {
        it('returns messages for a room the user is in', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;

            await Message.create([
                { roomId, userId: user._id, text: 'Hello' },
                { roomId, userId: user._id, text: 'World' },
            ]);

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/rooms/${roomId}/messages`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.messages.length, 2);
            assert.ok(res.body.pagination);
            assert.equal(typeof res.body.pagination.hasMore, 'boolean');

            const msg = res.body.messages[0];
            assert.equal(typeof msg.id, 'string');
            assert.equal(typeof msg.roomId, 'string');
            assert.equal(typeof msg.userId, 'string');
            assert.equal(typeof msg.text, 'string');
            assert.equal(typeof msg.createdAt, 'number');
        });

        it('returns empty messages for room with no messages', async () => {
            const { room, user } = await createRoomWithMember();

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/rooms/${room._id}/messages`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.messages.length, 0);
            assert.equal(res.body.pagination.hasMore, false);
        });

        it('returns 403 for non-member', async () => {
            const room = await Room.create({ name: 'Secret Room', type: 'public' });
            const user = await createTestUser();

            const agent = getTestAgent();
            await agent
                .get(`/v1/rooms/${room._id}/messages`)
                .set(authHeader(user._id.toString()))
                .expect(403);
        });

        it('hides messages from a user I blocked, keeps my own', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const other = await createTestUser({ joinedRooms: [roomId] });
            await createActiveBlock(user._id, other._id);

            await Message.create([
                { roomId, userId: user._id, text: 'mine' },
                { roomId, userId: other._id, text: 'theirs' },
            ]);

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/rooms/${roomId}/messages`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.messages.length, 1);
            assert.equal(res.body.messages[0].text, 'mine');
        });

        it('hides messages from a user who blocked me (mutual)', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const other = await createTestUser({ joinedRooms: [roomId] });
            // other blocked me; I should not see other's messages either.
            await createActiveBlock(other._id, user._id);

            await Message.create([
                { roomId, userId: user._id, text: 'mine' },
                { roomId, userId: other._id, text: 'theirs' },
            ]);

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/rooms/${roomId}/messages`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.messages.length, 1);
            assert.equal(res.body.messages[0].text, 'mine');
        });
    });

    describe('GET /v1/messages/:messageId', () => {
        it('returns a single message', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const message = await Message.create({ roomId, userId: user._id, text: 'Test msg' });

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/messages/${message._id}`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.id, message._id.toString());
            assert.equal(res.body.text, 'Test msg');
        });

        it('returns 404 for non-existent message', async () => {
            const user = await createTestUser();
            const fakeId = new mongoose.Types.ObjectId();

            const agent = getTestAgent();
            await agent
                .get(`/v1/messages/${fakeId}`)
                .set(authHeader(user._id.toString()))
                .expect(404);
        });

        it('returns 404 for a message authored by a blocked-pair user', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const other = await createTestUser({ joinedRooms: [roomId] });
            await createActiveBlock(user._id, other._id);
            const message = await Message.create({ roomId, userId: other._id, text: 'hidden' });

            const agent = getTestAgent();
            await agent
                .get(`/v1/messages/${message._id}`)
                .set(authHeader(user._id.toString()))
                .expect(404);
        });
    });

    describe('GET /v1/messages/:messageId/thread', () => {
        it('returns parent message and replies', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const parent = await Message.create({ roomId, userId: user._id, text: 'Parent' });
            await Message.create({ roomId, userId: user._id, text: 'Reply 1', parentMessageId: parent._id });
            await Message.create({ roomId, userId: user._id, text: 'Reply 2', parentMessageId: parent._id });

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/messages/${parent._id}/thread`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.parentMessage.text, 'Parent');
            assert.equal(res.body.replies.length, 2);
        });

        it('filters out replies authored by a blocked-pair user', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const other = await createTestUser({ joinedRooms: [roomId] });
            await createActiveBlock(user._id, other._id);

            const parent = await Message.create({ roomId, userId: user._id, text: 'Parent' });
            await Message.create({ roomId, userId: user._id, text: 'mine', parentMessageId: parent._id });
            await Message.create({ roomId, userId: other._id, text: 'theirs', parentMessageId: parent._id });

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/messages/${parent._id}/thread`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.replies.length, 1);
            assert.equal(res.body.replies[0].text, 'mine');
        });

        it('returns 404 for a thread whose parent is from a blocked-pair user', async () => {
            const { room, user } = await createRoomWithMember();
            const roomId = room._id as mongoose.Types.ObjectId;
            const other = await createTestUser({ joinedRooms: [roomId] });
            await createActiveBlock(user._id, other._id);
            const parent = await Message.create({ roomId, userId: other._id, text: 'hidden parent' });

            const agent = getTestAgent();
            await agent
                .get(`/v1/messages/${parent._id}/thread`)
                .set(authHeader(user._id.toString()))
                .expect(404);
        });
    });
});
