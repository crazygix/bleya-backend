import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { PushToken } from '../../models/PushToken.js';

describe('Notifications API', () => {
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

    describe('POST /v1/notifications/push/register', () => {
        it('registers a push token for the authenticated user', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(user._id.toString()))
                .send({
                    token: 'push-token-1',
                    platform: 'ios',
                })
                .expect(200);

            const storedToken = await PushToken.findOne({ userId: user._id }).lean();
            assert.equal(storedToken?.token, 'push-token-1');
            assert.equal(storedToken?.platform, 'ios');
            assert.equal(storedToken?.isActive, true);
            assert.equal(storedToken?.badge, false);
        });

        it('stores the badge flag for app builds that ask for the badge count', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(user._id.toString()))
                .send({
                    token: 'push-token-1',
                    platform: 'ios',
                    badge: true,
                })
                .expect(200);

            const storedToken = await PushToken.findOne({ userId: user._id }).lean();
            assert.equal(storedToken?.badge, true);
        });

        it('rejects a badge flag that is not true or false', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(user._id.toString()))
                .send({
                    token: 'push-token-1',
                    platform: 'ios',
                    badge: 'yes',
                })
                .expect(400);

            assert.equal(await PushToken.countDocuments({ userId: user._id }), 0);
        });

        it('is idempotent and replaces the previous token for the same user', async () => {
            const user = await createTestUser();
            await PushToken.create({
                userId: user._id,
                token: 'old-token',
                platform: 'android',
                isActive: false,
            });

            const agent = getTestAgent();
            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(user._id.toString()))
                .send({
                    token: 'new-token',
                    platform: 'ios',
                })
                .expect(200);

            const tokens = await PushToken.find({ userId: user._id }).lean();
            assert.equal(tokens.length, 1);
            assert.equal(tokens[0].token, 'new-token');
            assert.equal(tokens[0].platform, 'ios');
            assert.equal(tokens[0].isActive, true);
        });

        it('moves an existing token to the latest user', async () => {
            const oldUser = await createTestUser();
            const newUser = await createTestUser();
            await PushToken.create({
                userId: oldUser._id,
                token: 'shared-token',
                platform: 'android',
            });

            const agent = getTestAgent();
            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(newUser._id.toString()))
                .send({
                    token: 'shared-token',
                    platform: 'ios',
                })
                .expect(200);

            const oldToken = await PushToken.findOne({ userId: oldUser._id }).lean();
            const newToken = await PushToken.findOne({ userId: newUser._id }).lean();

            assert.equal(oldToken, null);
            assert.equal(newToken?.token, 'shared-token');
            assert.equal(newToken?.platform, 'ios');
        });

        it('rejects invalid payloads', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/notifications/push/register')
                .set(authHeader(user._id.toString()))
                .send({
                    token: '',
                    platform: 'web',
                })
                .expect(400);
        });
    });

    describe('POST /v1/notifications/push/unregister', () => {
        it('deactivates the token for the authenticated user', async () => {
            const user = await createTestUser();
            await PushToken.create({
                userId: user._id,
                token: 'push-token-1',
                platform: 'android',
                isActive: true,
            });

            const agent = getTestAgent();
            await agent
                .post('/v1/notifications/push/unregister')
                .set(authHeader(user._id.toString()))
                .send({ token: 'push-token-1' })
                .expect(200);

            const storedToken = await PushToken.findOne({ userId: user._id }).lean();
            assert.equal(storedToken?.isActive, false);
        });

        it('returns 401 without authentication', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/notifications/push/unregister')
                .send({ token: 'push-token-1' })
                .expect(401);
        });
    });
});
