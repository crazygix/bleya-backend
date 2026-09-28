import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { UserIdentity } from '../../models/UserIdentity.js';
import { User } from '../../models/User.js';

function parseAndroidIntentRedirect(location: string): { params: URLSearchParams; intent: string } {
    assert.ok(location);
    assert.match(location, /^intent:\/\/callback\?/);

    const [urlPart, intentPart] = location.split('#Intent;', 2);
    assert.ok(urlPart);
    assert.ok(intentPart);

    return {
        params: new URLSearchParams(urlPart.slice('intent://callback?'.length)),
        intent: `#Intent;${intentPart}`,
    };
}

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

        it('creates a user and issues session tokens for a verified Apple identity', async () => {
            const agent = getTestAgent();
            const rawNonce = 'apple-login-nonce';
            const hashedNonce = crypto.createHash('sha256').update(rawNonce).digest('base64url');
            const res = await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'apple',
                    idToken: makeProviderTestToken({
                        sub: 'apple-user-1',
                        email: 'alice@example.com',
                        email_verified: true,
                        is_private_email: false,
                        nonce: hashedNonce,
                    }),
                    rawNonce,
                })
                .expect(200);

            assert.ok(res.body.token);
            assert.equal(res.body.requiresUsername, true);
            assert.equal(res.body.hasPasskey, false);
            assert.ok(res.headers['set-cookie']);

            const users = await User.find({});
            assert.equal(users.length, 1);

            const identity = await UserIdentity.findOne({ provider: 'apple', providerUserId: 'apple-user-1' });
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

        it('creates a separate user for a different provider even when the email matches', async () => {
            const agent = getTestAgent();

            await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'google',
                    idToken: makeProviderTestToken({
                        sub: 'google-user-2',
                        email: 'shared@example.com',
                        email_verified: true,
                    }),
                })
                .expect(200);

            await agent
                .post('/v1/auth/provider-sign-in')
                .send({
                    provider: 'apple',
                    idToken: makeProviderTestToken({
                        sub: 'apple-user-2',
                        email: 'shared@example.com',
                        email_verified: true,
                        is_private_email: false,
                        nonce: 'apple-nonce-2',
                    }),
                    rawNonce: 'apple-nonce-2',
                })
                .expect(200);

            const users = await User.find({});
            assert.equal(users.length, 2);

            const googleIdentity = await UserIdentity.findOne({ provider: 'google', providerUserId: 'google-user-2' });
            const appleIdentity = await UserIdentity.findOne({ provider: 'apple', providerUserId: 'apple-user-2' });
            assert.ok(googleIdentity);
            assert.ok(appleIdentity);
            assert.notEqual(googleIdentity.userId.toString(), appleIdentity.userId.toString());
        });
    });

    describe(`GET ${config.authProviders.appleAndroidRedirectPath}`, () => {
        it('redirects Apple callback query params into the Android intent URL', async () => {
            const agent = getTestAgent();
            const res = await agent
                .get(config.authProviders.appleAndroidRedirectPath)
                .query({
                    code: 'auth-code',
                    state: 'state-token',
                })
                .expect(302);

            const { params, intent } = parseAndroidIntentRedirect(res.headers.location);
            assert.equal(params.get('code'), 'auth-code');
            assert.equal(params.get('state'), 'state-token');
            assert.ok(intent.includes(`package=${config.authProviders.androidPackageName};`));
            assert.ok(intent.includes('scheme=signinwithapple;'));
        });
    });

    describe(`POST ${config.authProviders.appleAndroidRedirectPath}`, () => {
        it('redirects Apple callback form data into the Android intent URL', async () => {
            const agent = getTestAgent();
            const res = await agent
                .post(config.authProviders.appleAndroidRedirectPath)
                .type('form')
                .send({
                    code: 'posted-code',
                    state: 'posted-state',
                    user: '{"email":"alice@example.com"}',
                })
                .expect(302);

            const { params, intent } = parseAndroidIntentRedirect(res.headers.location);
            assert.equal(params.get('code'), 'posted-code');
            assert.equal(params.get('state'), 'posted-state');
            assert.equal(params.get('user'), '{"email":"alice@example.com"}');
            assert.ok(intent.includes(`package=${config.authProviders.androidPackageName};`));
            assert.ok(intent.includes('scheme=signinwithapple;'));
        });
    });

    describe('GET /v1/auth/security', () => {
        it('returns passkey status for the authenticated user', async () => {
            const user = await createTestUser({ username: 'alice' });
            const agent = getTestAgent();

            const res = await agent
                .get('/v1/auth/security')
                .set(authHeader(user._id.toString()))
                .expect(200);

            assert.equal(res.body.hasPasskey, false);
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

        it('rejects uppercase usernames instead of lowercasing them', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            await agent
                .post('/v1/auth/set-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'TestUser' })
                .expect(400);
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

        it('returns unavailable for uppercase usernames', async () => {
            const user = await createTestUser();
            const agent = getTestAgent();

            const res = await agent
                .post('/v1/auth/check-username')
                .set(authHeader(user._id.toString()))
                .send({ username: 'Alice' })
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
