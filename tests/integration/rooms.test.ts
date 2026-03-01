import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';

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

    describe('GET /api/v1/rooms', () => {
        it('lists public rooms', async () => {
            const user = await createTestUser({ phoneNumber: '+11111111111' });
            await createPublicRoom('Room Alpha');
            await createPublicRoom('Room Beta');

            const agent = getTestAgent();
            const res = await agent
                .get('/api/v1/rooms')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.length, 2);
            const names = res.body.map((r: { name: string }) => r.name);
            assert.ok(names.includes('Room Alpha'));
            assert.ok(names.includes('Room Beta'));
        });

        it('filters rooms by search query', async () => {
            const user = await createTestUser({ phoneNumber: '+11111111112' });
            await createPublicRoom('Berlin');
            await createPublicRoom('Paris');

            const agent = getTestAgent();
            const res = await agent
                .get('/api/v1/rooms?search=berlin')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.length, 1);
            assert.equal(res.body[0].name, 'Berlin');
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.get('/api/v1/rooms').expect(401);
        });
    });

    describe('POST /api/v1/rooms/:roomId/join', () => {
        it('joins a public room', async () => {
            const user = await createTestUser({ phoneNumber: '+11111111113' });
            const room = await createPublicRoom('Join Me');

            const agent = getTestAgent();
            const res = await agent
                .post(`/api/v1/rooms/${room._id}/join`)
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
                phoneNumber: '+11111111114',
                joinedRooms: [room._id as mongoose.Types.ObjectId],
            });

            const agent = getTestAgent();
            const res = await agent
                .post(`/api/v1/rooms/${room._id}/join`)
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
                phoneNumber: '+11111111115',
                joinedRooms: rooms.map((r) => r._id as mongoose.Types.ObjectId),
            });
            const extraRoom = await createPublicRoom('Room Extra');

            const agent = getTestAgent();
            await agent
                .post(`/api/v1/rooms/${extraRoom._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(400);
        });

        it('rejects non-participant joining private room', async () => {
            const user = await createTestUser({ phoneNumber: '+11111111116' });
            const otherUser = await createTestUser({ phoneNumber: '+11111111117' });
            const thirdUser = await createTestUser({ phoneNumber: '+11111111118' });

            const room = await createPrivateRoom([otherUser._id.toString(), thirdUser._id.toString()]);

            const agent = getTestAgent();
            await agent
                .post(`/api/v1/rooms/${room._id}/join`)
                .set(authHeader(user._id.toString()))
                .expect(403);
        });

        it('returns 404 for non-existent room', async () => {
            const user = await createTestUser({ phoneNumber: '+11111111119' });
            const fakeId = new mongoose.Types.ObjectId();

            const agent = getTestAgent();
            await agent
                .post(`/api/v1/rooms/${fakeId}/join`)
                .set(authHeader(user._id.toString()))
                .expect(404);
        });
    });
});
