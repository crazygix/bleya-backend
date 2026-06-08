import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Report } from '../../models/Report.js';

describe('Reports API', () => {
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

    describe('POST /v1/reports', () => {
        it('creates a report against another user', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });

            const agent = getTestAgent();
            const res = await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reportedUserId: other._id.toString(), reason: 'harassment', details: 'rude messages' })
                .expect(201);

            assert.ok(res.body.id);
            assert.equal(res.body.status, 'open');
            assert.equal(typeof res.body.createdAt, 'number');

            const stored = await Report.findById(res.body.id).lean<{
                reporterUserId: mongoose.Types.ObjectId;
                reportedUserId?: mongoose.Types.ObjectId;
                reason: string;
                details: string;
            } | null>();
            assert.equal(stored!.reporterUserId.toString(), me._id.toString());
            assert.equal(stored!.reportedUserId!.toString(), other._id.toString());
            assert.equal(stored!.reason, 'harassment');
            assert.equal(stored!.details, 'rude messages');
        });

        it('creates a report against a specific message', async () => {
            const room = await Room.create({ name: 'Room', type: 'public' });
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const msg = await Message.create({ roomId, userId: other._id, text: 'bad', parentMessageId: null });

            const agent = getTestAgent();
            const res = await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ messageId: msg._id.toString(), roomId: roomId.toString(), reason: 'inappropriate_content' })
                .expect(201);

            assert.ok(res.body.id);
        });

        it('rejects an invalid reason', async () => {
            const me = await createTestUser();
            const other = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reportedUserId: other._id.toString(), reason: 'because' })
                .expect(400);
        });

        it('rejects a report with no target', async () => {
            const me = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reason: 'spam' })
                .expect(400);
        });

        it('rejects reporting yourself', async () => {
            const me = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reportedUserId: me._id.toString(), reason: 'other' })
                .expect(400);
        });

        it('returns 404 for a non-existent reported user', async () => {
            const me = await createTestUser();
            const agent = getTestAgent();
            const fakeId = new mongoose.Types.ObjectId();

            await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reportedUserId: fakeId.toString(), reason: 'spam' })
                .expect(404);
        });

        it('rejects an invalid target id', async () => {
            const me = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/reports')
                .set(authHeader(me._id.toString()))
                .send({ reportedUserId: 'not-an-id', reason: 'spam' })
                .expect(400);
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.post('/v1/reports').send({ reason: 'spam' }).expect(401);
        });
    });
});
