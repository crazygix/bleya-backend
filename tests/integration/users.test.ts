import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';

describe('Users API', () => {
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

    describe('GET /v1/users/me', () => {
        it('returns the authenticated user profile', async () => {
            const user = await createTestUser({
                username: 'myuser',
                bio: 'hello',
            });

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/users/me')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.id, user._id.toString());
            assert.equal(res.body.username, 'myuser');
            assert.equal(res.body.bio, 'hello');
            assert.equal(typeof res.body.createdAt, 'number');
            assert.equal(typeof res.body.updatedAt, 'number');
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.get('/v1/users/me').expect(401);
        });
    });

    describe('PUT /v1/users/profile', () => {
        it('updates bio', async () => {
            const user = await createTestUser({
                username: 'edituser',
            });

            const agent = getTestAgent();
            const res = await agent
                .put('/v1/users/profile')
                .set(authHeader(user._id.toString()))
                .send({ bio: 'new bio' })
                .expect(200);

            assert.equal(res.body.bio, 'new bio');
        });

        it('rejects invalid bio type', async () => {
            const user = await createTestUser({
                username: 'biouser',
            });

            const agent = getTestAgent();
            await agent
                .put('/v1/users/profile')
                .set(authHeader(user._id.toString()))
                .send({ bio: 123 })
                .expect(400);
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent
                .put('/v1/users/profile')
                .send({ bio: 'x' })
                .expect(401);
        });
    });

    describe('GET /v1/users/:userId', () => {
        it('returns public profile of another user', async () => {
            const viewer = await createTestUser();
            const target = await createTestUser({
                username: 'publicuser',
                bio: 'public bio',
            });

            const agent = getTestAgent();
            const res = await agent
                .get(`/v1/users/${target._id}`)
                .set(authHeader(viewer._id.toString()))
                .expect(200);

            assert.equal(res.body.username, 'publicuser');
            assert.equal(res.body.bio, 'public bio');
            // Public profile should not include lastLogin
            assert.equal(res.body.lastLogin, undefined);
        });

        it('returns 404 for non-existent user', async () => {
            const viewer = await createTestUser();
            const agent = getTestAgent();
            await agent
                .get('/v1/users/507f1f77bcf86cd799439011')
                .set(authHeader(viewer._id.toString()))
                .expect(404);
        });
    });
});
