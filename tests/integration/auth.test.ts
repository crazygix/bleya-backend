import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { UserIdentity } from '../../models/UserIdentity.js';
import { User } from '../../models/User.js';

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

    describe('POST /v1/auth/provider-sign-in', () => {
        it('creates a user and issues session tokens for a verified provider identity', async () => {
            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'google',
                    idToken: makeProviderTestToken({
                        sub: 'google-user-1',
                        email: 'alice@example.com',
                        email_verified: true,
                    }),
                })
                .expect(200);

            assert.ok(res.body.token);
            assert.equal(res.body.requiresUsername, true);
            assert.equal(res.body.hasPasskey, false);
            assert.ok(res.headers['set-cookie']);

            const users = await User.find({});
            assert.equal(users.length, 1);

            const identity = await UserIdentity.findOne({ provider: 'google', providerUserId: 'google-user-1' });
            assert.ok(identity);
        });

        it('reuses an existing identity on repeat sign-in', async () => {
            const user = await createTestUser({ username: 'alice' });
            await UserIdentity.create({
                userId: user._id,
                provider: 'google',
                providerUserId: 'google-user-1',
                email: 'alice@example.com',
                emailVerified: true,
                isPrivateRelay: false,
            });

            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'google',
                    idToken: makeProviderTestToken({
                        sub: 'google-user-1',
                        email: 'alice@example.com',
                        email_verified: true,
                    }),
                })
                .expect(200);

            assert.ok(res.body.token);
            assert.equal(res.body.requiresUsername, false);
        });
    });

    describe('GET /v1/auth/identities', () => {
        it('returns linked providers for the authenticated user', async () => {
            const user = await createTestUser({ username: 'alice' });
            await UserIdentity.create({
                userId: user._id,
                provider: 'google',
                providerUserId: 'google-user-1',
                email: 'alice@example.com',
                emailVerified: true,
                isPrivateRelay: false,
            });

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/auth/identities')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.hasPasskey, false);
            assert.equal(res.body.linkedProviders.length, 1);
            assert.equal(res.body.linkedProviders[0].provider, 'google');
        });
    });

    describe('POST /v1/auth/identities/link', () => {
        it('links a second provider to the current user', async () => {
            const user = await createTestUser({ username: 'alice' });
            await UserIdentity.create({
                userId: user._id,
                provider: 'google',
                providerUserId: 'google-user-1',
                email: 'alice@example.com',
                emailVerified: true,
                isPrivateRelay: false,
            });

            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/identities/link')
                .set(authHeader(user._id.toString()))
                .send({
                    provider: 'apple',
                    idToken: makeProviderTestToken({
                        sub: 'apple-user-1',
                        email: 'alice@example.com',
                        email_verified: true,
                        is_private_email: false,
                    }),
                })
                .expect(200);

            assert.equal(res.body.linkedProviders.length, 2);
        });
    });

    describe('POST /v1/auth/passkeys/registration/options', () => {
        it('returns WebAuthn registration options for authenticated users', async () => {
            const user = await createTestUser({ username: 'alice' });
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/passkeys/registration/options')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.ok(res.body.challengeId);
            assert.ok(res.body.options);
            assert.ok(res.body.options.challenge);
        });
    });

    describe('POST /v1/auth/passkeys/authentication/options', () => {
        it('returns WebAuthn authentication options', async () => {
            const agent = getTestAgent();
            const res = await agent
                .post('/v1/auth/passkeys/authentication/options')
                .expect(200);

            assert.ok(res.body.challengeId);
            assert.ok(res.body.options.challenge);
        });
    });

    describe('POST /v1/auth/refresh', () => {
        it('rotates refresh token and returns new access token', async () => {
            const agent = getTestAgent();
            const signInRes = await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'google',
                    idToken: makeProviderTestToken({
                        sub: 'google-user-2',
                        email: 'bob@example.com',
                        email_verified: true,
                    }),
                })
                .expect(200);

            const cookies = signInRes.headers['set-cookie'];
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
    });

    describe('POST /v1/auth/set-username', () => {
        it('sets username for user without one', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/set-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'testuser' })
                .expect(200);

            assert.equal(res.body.username, 'testuser');
        });
    });

    describe('POST /v1/auth/check-username', () => {
        it('returns availability for usernames', async () => {
            await createTestUser({ username: 'alice' });
            const user = await createTestUser();
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
