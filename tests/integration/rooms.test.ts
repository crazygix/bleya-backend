import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { Message } from '../../models/Message.js';

async function createPublicRoom(name: string) {
    return Room.create({ name, type: 'public' });
}

async function createPrivateRoom(participantIds: string[]) {
    const sorted = participantIds.sort();
    return Room.create({
        name: `DM: ${sorted.join(' & ')}`,
        type: 'private',
        participants: sorted.map((id) => new mongoose.Types.ObjectId(id)),
        participantsHash: sorted.join('_'),
    });
}

describe('Rooms API', () => {
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

    describe('GET /v1/rooms', () => {
        it('lists public rooms', async () => {
            const user = await createTestUser();
            await createPublicRoom('Room Alpha');
            await createPublicRoom('Room Beta');

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/rooms')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.length, 2);
            const names = res.body.map((r: { name: string }) => r.name);
            assert.ok(names.includes('Room Alpha'));
            assert.ok(names.includes('Room Beta'));
        });

        it('filters rooms by search query', async () => {
            const user = await createTestUser();
            await createPublicRoom('Berlin');
            await createPublicRoom('Paris');

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/rooms?search=berlin')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.length, 1);
            assert.equal(res.body[0].name, 'Berlin');
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.get('/v1/rooms').expect(401);
        });
    });

    describe('POST /v1/rooms/:roomId/join', () => {
        it('joins a public room', async () => {
            const user = await createTestUser();
            const room = await createPublicRoom('Join Me');

            const agent = getTestAgent();
            const res = await agent
                .post(`/v1/rooms/${room._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.ok(res.body.room);
            assert.equal(res.body.room.name, 'Join Me');

            const updated = await User.findById(user._id);
            assert.ok(updated!.joinedRooms.some((id: mongoose.Types.ObjectId) => id.equals(room._id as mongoose.Types.ObjectId)));
        });

        it('returns idempotent response when already joined', async () => {
            const room = await createPublicRoom('Already Joined');
            const user = await createTestUser({
                joinedRooms: [room._id as mongoose.Types.ObjectId],
            });

            const agent = getTestAgent();
            const res = await agent
                .post(`/v1/rooms/${room._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.ok(res.body.message.toLowerCase().includes('already'));
        });

        it('enforces 5-room public limit', async () => {
            const rooms = [];
            for (let i = 0; i < 5; i++) {
                rooms.push(await createPublicRoom(`Room ${i}`));
            }
            const user = await createTestUser({
                joinedRooms: rooms.map((r) => r._id as mongoose.Types.ObjectId),
            });
            const extraRoom = await createPublicRoom('Room Extra');

            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/${extraRoom._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(400);
        });

        it('rejects non-participant joining private room', async () => {
            const user = await createTestUser();
            const otherUser = await createTestUser();
            const thirdUser = await createTestUser();

            const room = await createPrivateRoom([otherUser._id.toString(), thirdUser._id.toString()]);

            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/${room._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(403);
        });

        it('returns 404 for non-existent room', async () => {
            const user = await createTestUser();
            const fakeId = new mongoose.Types.ObjectId();

            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/${fakeId}/join`)
                .set(authHeader(user._id.toString()))
                .expect(404);
        });
    });

    describe('GET /v1/rooms/joined', () => {
        it('returns joined rooms with last message and unread count, newest first', async () => {
            const room = await createPublicRoom('Joined Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const author = await createTestUser({ username: 'author' });
            const user = await createTestUser({ joinedRooms: [roomId] });

            await Message.create({ roomId, userId: author._id, text: 'hello there', parentMessageId: null });

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/rooms/joined')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.length, 1);
            assert.equal(res.body[0].id, roomId.toString());
            assert.equal(res.body[0].lastMessageText, 'hello there');
            assert.equal(res.body[0].lastMessageUsername, 'author');
            assert.equal(res.body[0].unreadCount, 1);
        });

        it('returns an empty array when the user has joined nothing', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();
            const res = await agent
                .get('/v1/rooms/joined')
                .set(authHeader(user._id.toString()))
                .expect(200);
            assert.deepEqual(res.body, []);
        });
    });

    describe('GET /v1/rooms/:roomId/members', () => {
        it('lists members sorted by username', async () => {
            const room = await createPublicRoom('Members Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            await createTestUser({ username: 'charlie', joinedRooms: [roomId] });
            await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const viewer = await createTestUser({ username: 'bob', joinedRooms: [roomId] });

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/rooms/${roomId}/members`)
                .set(authHeader(viewer._id.toString()))
                .expect(200);

            const names = res.body.map((m: { username: string }) => m.username);
            assert.deepEqual(names, ['alice', 'bob', 'charlie']);
        });

        it('rejects a non-member', async () => {
            const room = await createPublicRoom('Closed Room');
            const outsider = await createTestUser({ username: 'outsider' });
            const agent = getTestAgent();
            await agent
                .get(`/v1/rooms/${room._id}/members`)
                .set(authHeader(outsider._id.toString()))
                .expect(403);
        });
    });

    describe('POST /v1/rooms/:roomId/read', () => {
        it('marks a joined room as read and clears the unread count', async () => {
            const room = await createPublicRoom('Read Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const author = await createTestUser({ username: 'author' });
            const user = await createTestUser({ joinedRooms: [roomId] });
            await Message.create({ roomId, userId: author._id, text: 'unread message', parentMessageId: null });

            const agent = getTestAgent();
            const read = await agent
                .post(`/v1/rooms/${roomId}/read`)
                .set(authHeader(user._id.toString()))
                .expect(200);
            assert.ok(typeof read.body.lastReadAt === 'number');

            const joined = await agent
                .get('/v1/rooms/joined')
                .set(authHeader(user._id.toString()))
                .expect(200);
            assert.equal(joined.body[0].unreadCount, 0);
        });

        it('rejects marking a room the user has not joined', async () => {
            const room = await createPublicRoom('Not Joined');
            const user = await createTestUser();
            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/${room._id}/read`)
                .set(authHeader(user._id.toString()))
                .expect(400);
        });
    });
});
