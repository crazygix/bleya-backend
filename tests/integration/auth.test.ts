import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { User } from '../../models/User.js';
import { hashRefreshToken } from '../../services/authService.js';

describe('Auth API', () => {
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

    describe('POST /v1/auth/request-code', () => {
        it('creates user and returns verification code', async () => {
            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/request-code')
                .send({ phoneNumber: '+12345678901' })
                .expect(200);

            assert.ok(res.body.message);
            assert.ok(res.body.codeSentAt);
            assert.ok(res.body.code); // exposed in non-production

            const user = await User.findOne({ phoneNumber: '+12345678901' });
            assert.ok(user);
            assert.equal(user.code, res.body.code);
        });

        it('returns 400 for invalid phone number', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/request-code')
                .send({ phoneNumber: 'abc' })
                .expect(400);
        });

        it('returns 400 for missing phone number', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/request-code')
                .send({})
                .expect(400);
        });
    });

    describe('POST /v1/auth/verify-code', () => {
        it('returns tokens and requiresUsername for correct code', async () => {
            const agent = getTestAgent();
            const codeExpiresAt = new Date();
            codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + 10);

            await createTestUser({
                phoneNumber: '+19999999999',
                code: '123456',
                codeExpiresAt,
                codeSentAt: new Date(),
            });

            const res = await agent
                .post('/v1/auth/verify-code')
                .send({ phoneNumber: '+19999999999', code: '123456' })
                .expect(200);

            assert.ok(res.body.token);
            assert.equal(typeof res.body.requiresUsername, 'boolean');
            assert.ok(res.headers['set-cookie']);
        });

        it('returns 401 for wrong code', async () => {
            const codeExpiresAt = new Date();
            codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + 10);

            await createTestUser({
                phoneNumber: '+19999999998',
                code: '123456',
                codeExpiresAt,
                codeSentAt: new Date(),
            });

            const agent = getTestAgent();
            await agent
                .post('/v1/auth/verify-code')
                .send({ phoneNumber: '+19999999998', code: '000000' })
                .expect(401);
        });

        it('returns 401 for expired code', async () => {
            const codeExpiresAt = new Date();
            codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() - 1);

            await createTestUser({
                phoneNumber: '+19999999997',
                code: '123456',
                codeExpiresAt,
                codeSentAt: new Date(),
            });

            const agent = getTestAgent();
            await agent
                .post('/v1/auth/verify-code')
                .send({ phoneNumber: '+19999999997', code: '123456' })
                .expect(401);
        });

        it('returns 400 for missing fields', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/verify-code')
                .send({ phoneNumber: '+19999999999' })
                .expect(400);
        });
    });

    describe('POST /v1/auth/refresh', () => {
        it('rotates refresh token and returns new access token', async () => {
            const agent = getTestAgent();
            const codeExpiresAt = new Date();
            codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + 10);

            await createTestUser({
                phoneNumber: '+18888888888',
                code: '111111',
                codeExpiresAt,
                codeSentAt: new Date(),
            });

            const verifyRes = await agent
                .post('/v1/auth/verify-code')
                .send({ phoneNumber: '+18888888888', code: '111111' })
                .expect(200);

            const cookies = verifyRes.headers['set-cookie'];
            assert.ok(cookies);

            const res = await agent
                .post('/v1/auth/refresh')
                .set('Cookie', cookies)
                .expect(200);

            assert.ok(res.body.token);
            assert.ok(res.headers['set-cookie']);
        });

        it('returns 401 when no refresh cookie', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/refresh')
                .expect(401);
        });

        it('returns 401 for invalid refresh token', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/refresh')
                .set('Cookie', 'refreshToken=invalid-token')
                .expect(401);
        });
    });

    describe('POST /v1/auth/set-username', () => {
        it('sets username for user without one', async () => {
            const user = await createTestUser({ phoneNumber: '+17777777777' });
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/set-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'testuser' })
                .expect(200);

            assert.equal(res.body.username, 'testuser');
        });

        it('rejects duplicate username', async () => {
            await createTestUser({ phoneNumber: '+17777777776', username: 'taken' });
            const user = await createTestUser({ phoneNumber: '+17777777775' });
            const agent = getTestAgent();

            await agent
                .post('/v1/auth/set-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'taken' })
                .expect(400);
        });

        it('rejects if username already set', async () => {
            const user = await createTestUser({ phoneNumber: '+17777777774', username: 'existing' });
            const agent = getTestAgent();

            await agent
                .post('/v1/auth/set-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'newname' })
                .expect(400);
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent
                .post('/v1/auth/set-username')
                .send({ username: 'test' })
                .expect(401);
        });
    });

    describe('POST /v1/auth/check-username', () => {
        it('returns available true for unused username', async () => {
            const user = await createTestUser({ phoneNumber: '+16666666666' });
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/check-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'uniquename' })
                .expect(200);

            assert.equal(res.body.available, true);
        });

        it('returns available false for taken username', async () => {
            await createTestUser({ phoneNumber: '+16666666665', username: 'alice' });
            const user = await createTestUser({ phoneNumber: '+16666666664' });
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/check-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'alice' })
                .expect(200);

            assert.equal(res.body.available, false);
        });
    });

    describe('POST /v1/auth/logout', () => {
        it('clears refresh cookie', async () => {
            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/logout')
                .expect(200);

            assert.equal(res.body.success, true);
        });
    });
});
