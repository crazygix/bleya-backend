import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';

describe('Error handling', () => {
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

    it('returns 400 for invalid ObjectId in room join', async () => {
        const user = await createTestUser({ phoneNumber: '+14444444444' });
        const agent = getTestAgent();

        const res = await agent
            .post('/api/v1/rooms/not-a-valid-id/join')
            .set(authHeader(user._id.toString()))
            .expect(400);

        assert.ok(res.body.error);
    });

    it('returns 404 for non-existent room', async () => {
        const user = await createTestUser({ phoneNumber: '+14444444445' });
        const agent = getTestAgent();

        await agent
            .get('/api/v1/rooms/507f1f77bcf86cd799439011')
            .set(authHeader(user._id.toString()))
            .expect(404);
    });

    it('returns 401 for missing auth token', async () => {
        const agent = getTestAgent();

        const res = await agent
            .get('/api/v1/users/me')
            .expect(401);

        assert.ok(res.body.error);
    });

    it('returns 401 for invalid auth token', async () => {
        const agent = getTestAgent();

        const res = await agent
            .get('/api/v1/users/me')
            .set('Authorization', 'Bearer invalid-token')
            .expect(401);

        assert.ok(res.body.error);
    });

    it('returns 400 for invalid message ID format', async () => {
        const user = await createTestUser({ phoneNumber: '+14444444446' });
        const agent = getTestAgent();

        await agent
            .get('/api/v1/messages/not-valid')
            .set(authHeader(user._id.toString()))
            .expect(400);
    });
});
