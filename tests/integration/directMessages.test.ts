import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { UserBlock } from '../../models/UserBlock.js';

describe('Direct message API', () => {
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

    describe('POST /v1/rooms/direct/:otherUserId', () => {
        it('creates a direct message room between two users', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });

            const agent = getTestAgent();
            const res = await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.equal(res.body.room.type, 'private');
            assert.equal(res.body.room.name, 'bob');
            assert.equal(res.body.room.otherUserId, other._id.toString());
            assert.ok(res.body.room.participants.includes(me._id.toString()));
            assert.ok(res.body.room.participants.includes(other._id.toString()));
        });

        it('is idempotent and returns the same room on repeat', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });

            const agent = getTestAgent();
            const first = await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            const second = await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.equal(first.body.room.id, second.body.room.id);
        });

        it('rejects messaging yourself', async () => {
            const me = await createTestUser({ username: 'alice' });
            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/direct/${me._id}`)
                .set(authHeader(me._id.toString()))
                .expect(400);
        });

        it('returns 404 for a non-existent user', async () => {
            const me = await createTestUser({ username: 'alice' });
            const fakeId = '0123456789abcdef01234567';
            const agent = getTestAgent();
            await agent
                .post(`/v1/rooms/direct/${fakeId}`)
                .set(authHeader(me._id.toString()))
                .expect(404);
        });

        it('returns 400 for an invalid user id', async () => {
            const me = await createTestUser({ username: 'alice' });
            const agent = getTestAgent();
            await agent
                .post('/v1/rooms/direct/not-an-id')
                .set(authHeader(me._id.toString()))
                .expect(400);
        });
    });

    describe('GET /v1/rooms/direct/:otherUserId/status', () => {
        it('reports no chat before one exists, then a chat after', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            const before = await agent
                .get(`/v1/rooms/direct/${other._id}/status`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(before.body.hasChat, false);
            assert.equal(before.body.roomId, null);
            assert.equal(before.body.canSendMessage, true);

            await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            const after = await agent
                .get(`/v1/rooms/direct/${other._id}/status`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(after.body.hasChat, true);
            assert.ok(after.body.roomId);
            assert.equal(after.body.isDeletedByMe, false);
        });
    });

    describe('POST /v1/rooms/direct/:otherUserId/block + /unblock', () => {
        it('requires an existing chat to block', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            await agent
                .post(`/v1/rooms/direct/${other._id}/block`)
                .set(authHeader(me._id.toString()))
                .expect(400);
        });

        it('blocks, reflects status, and prevents reopening the DM', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            const block = await agent
                .post(`/v1/rooms/direct/${other._id}/block`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(block.body.blocked, true);
            assert.equal(block.body.alreadyBlocked, false);

            const status = await agent
                .get(`/v1/rooms/direct/${other._id}/status`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(status.body.isBlockedByMe, true);
            assert.equal(status.body.canSendMessage, false);

            // Opening the DM while I block them is rejected.
            await agent
                .post(`/v1/rooms/direct/${other._id}`)
                .set(authHeader(me._id.toString()))
                .expect(403);

            const active = await UserBlock.countDocuments({
                blockerUserId: me._id,
                blockedUserId: other._id,
                isActive: true,
            });
            assert.equal(active, 1);
        });

        it('is idempotent when blocking twice', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            await agent.post(`/v1/rooms/direct/${other._id}`).set(authHeader(me._id.toString())).expect(200);
            await agent.post(`/v1/rooms/direct/${other._id}/block`).set(authHeader(me._id.toString())).expect(200);
            const again = await agent
                .post(`/v1/rooms/direct/${other._id}/block`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(again.body.alreadyBlocked, true);
        });

        it('unblocks an existing block', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            await agent.post(`/v1/rooms/direct/${other._id}`).set(authHeader(me._id.toString())).expect(200);
            await agent.post(`/v1/rooms/direct/${other._id}/block`).set(authHeader(me._id.toString())).expect(200);

            const unblock = await agent
                .post(`/v1/rooms/direct/${other._id}/unblock`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(unblock.body.blocked, false);

            const active = await UserBlock.countDocuments({
                blockerUserId: me._id,
                blockedUserId: other._id,
                isActive: true,
            });
            assert.equal(active, 0);

            const status = await agent
                .get(`/v1/rooms/direct/${other._id}/status`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(status.body.isBlockedByMe, false);
            assert.equal(status.body.canSendMessage, true);
        });

        it('reports not-blocked when unblocking without an active block', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            const res = await agent
                .post(`/v1/rooms/direct/${other._id}/unblock`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(res.body.blocked, false);
            assert.equal(res.body.roomId, null);
        });
    });

    describe('POST /v1/rooms/direct/:otherUserId/delete', () => {
        it('hides the chat from the deleting user and is excluded from /joined', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            await agent.post(`/v1/rooms/direct/${other._id}`).set(authHeader(me._id.toString())).expect(200);

            const del = await agent
                .post(`/v1/rooms/direct/${other._id}/delete`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(del.body.deleted, true);

            const status = await agent
                .get(`/v1/rooms/direct/${other._id}/status`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(status.body.isDeletedByMe, true);

            const joined = await agent
                .get('/v1/rooms/joined')
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(joined.body.length, 0);
        });

        it('returns hasChat=false when no direct chat exists', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const agent = getTestAgent();

            const res = await agent
                .post(`/v1/rooms/direct/${other._id}/delete`)
                .set(authHeader(me._id.toString()))
                .expect(200);
            assert.equal(res.body.hasChat, false);
            assert.equal(res.body.deleted, false);
        });
    });
});
