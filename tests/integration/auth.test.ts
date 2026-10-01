import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { UserIdentity } from '../../models/UserIdentity.js';
import { User } from '../../models/User.js';
import { PushToken } from '../../models/PushToken.js';

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

function googleSignIn(sub: string) {
    return getTestAgent()
        .post('/v1/auth/provider-sign-in')
        .send({
            provider: 'google',
            idToken: makeProviderTestToken({ sub, email: `${sub}@example.com`, email_verified: true }),
        })
        .expect(200);
}

function registerPushToken(accessToken: string, token: string) {
    return getTestAgent()
        .post('/v1/notifications/push/register')
        .set({ Authorization: `Bearer ${accessToken}` })
        .send({ token, platform: 'ios' })
        .expect(200);
}

// Supertest types Set-Cookie as one string; at runtime it's a list.
function cookieList(setCookie: string | string[] | undefined): string[] {
    return ([] as string[]).concat(setCookie ?? []);
}

function logout(setCookie: string | string[]) {
    return getTestAgent()
        .post('/v1/auth/logout')
        .set('Cookie', cookieList(setCookie))
        .expect(200);
}

function clearsRefreshCookie(setCookie: string | string[] | undefined): boolean {
    return cookieList(setCookie).some((cookie) => cookie.startsWith('refreshToken=;'));
}

// The refresh cookie a response issued, as a `refreshToken=<value>` pair, or
// null when it issued none.
function issuedRefreshCookie(setCookie: string | string[] | undefined): string | null {
    const pair = cookieList(setCookie)
        .map((cookie) => cookie.split(';', 1)[0])
        .find((cookie) => cookie.startsWith('refreshToken=') && cookie !== 'refreshToken=');
    return pair ?? null;
}

function refresh(cookie: string) {
    return getTestAgent()
        .post('/v1/auth/refresh')
        .set('Cookie', cookie);
}

async function signIn(sub: string): Promise<string> {
    const res = await googleSignIn(sub);
    const cookie = issuedRefreshCookie(res.headers['set-cookie']);
    assert.ok(cookie);
    return cookie;
}

// Refreshes successfully and returns the refresh cookie that was issued.
async function rotate(cookie: string): Promise<string> {
    const res = await refresh(cookie).expect(200);
    assert.ok(res.body.token);
    const next = issuedRefreshCookie(res.headers['set-cookie']);
    assert.ok(next);
    return next;
}

// As if the current refresh token had been issued that long ago.
async function backdateCurrentRefreshToken(ms: number): Promise<void> {
    await User.updateMany({}, { $set: { refreshTokenIssuedAt: new Date(Date.now() - ms) } });
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

        it('gives the previous token only an access token within 30 s of its successor', async () => {
            const original = await signIn('google-refresh-1');
            const successor = await rotate(original);

            const res = await refresh(original).expect(200);

            assert.equal(res.headers['set-cookie'], undefined);
            const user = await User.findOne({}).select('_id').lean();
            const { userId } = jwt.verify(res.body.token, config.jwtSecret) as { userId: string };
            assert.equal(userId, user!._id.toString());
            await rotate(successor);
        });

        it('issues a new refresh token for the previous one after 30 s', async () => {
            const original = await signIn('google-refresh-2');
            // The response carrying this one never reaches the app.
            const lost = await rotate(original);
            await backdateCurrentRefreshToken(60_000);

            const reissued = await rotate(original);

            assert.notEqual(reissued, original);
            assert.notEqual(reissued, lost);
            assert.ok(clearsRefreshCookie((await refresh(lost).expect(401)).headers['set-cookie']));
            await rotate(reissued);
            // Using the new token ends the previous one.
            await refresh(original).expect(401);
        });

        it('recovers again when the reissued response is lost too', async () => {
            const original = await signIn('google-refresh-3');
            await rotate(original);
            const firstRotation = await User.findOne({}).select('+previousRefreshTokenExpiresAt').lean();
            await backdateCurrentRefreshToken(60_000);
            await rotate(original);
            await backdateCurrentRefreshToken(60_000);

            await rotate(original);

            // The 7 days still count from the first rotation.
            const stored = await User.findOne({}).select('+previousRefreshTokenExpiresAt').lean();
            assert.ok(firstRotation?.previousRefreshTokenExpiresAt);
            assert.equal(
                stored?.previousRefreshTokenExpiresAt?.getTime(),
                firstRotation.previousRefreshTokenExpiresAt.getTime()
            );
        });

        it('lets two refreshes with the same cookie succeed at once', async () => {
            const original = await signIn('google-refresh-4');

            const responses = await Promise.all([
                refresh(original).expect(200),
                refresh(original).expect(200),
            ]);

            for (const res of responses) {
                assert.ok(res.body.token);
            }
            const issued = responses
                .map((res) => issuedRefreshCookie(res.headers['set-cookie']))
                .filter((cookie): cookie is string => cookie !== null);
            assert.equal(issued.length, 1);
            await rotate(issued[0]);
        });

        it('stops accepting the previous token 7 days after it was replaced', async () => {
            const original = await signIn('google-refresh-5');
            const successor = await rotate(original);
            const stored = await User.findOne({})
                .select('+refreshTokenIssuedAt +previousRefreshTokenExpiresAt')
                .lean();
            assert.equal(
                stored!.previousRefreshTokenExpiresAt!.getTime() - stored!.refreshTokenIssuedAt!.getTime(),
                SEVEN_DAYS_MS
            );

            const replacedAt = Date.now() - SEVEN_DAYS_MS - 60_000;
            await User.updateMany({}, {
                $set: {
                    refreshTokenIssuedAt: new Date(replacedAt),
                    previousRefreshTokenExpiresAt: new Date(replacedAt + SEVEN_DAYS_MS),
                },
            });

            const res = await refresh(original).expect(401);

            assert.ok(clearsRefreshCookie(res.headers['set-cookie']));
            // Logging out with it doesn't end the session either.
            await logout(original);
            await rotate(successor);
        });

        it('ends both tokens of the old session on a new sign-in', async () => {
            const original = await signIn('google-refresh-6');
            const successor = await rotate(original);

            const next = await signIn('google-refresh-6');

            await refresh(original).expect(401);
            await refresh(successor).expect(401);
            await backdateCurrentRefreshToken(60_000);
            await refresh(original).expect(401);
            await rotate(next);
        });

        it('looks up both refresh tokens by index', async () => {
            const indexes = await User.collection.indexes();
            for (const field of ['refreshTokenHash', 'previousRefreshTokenHash']) {
                assert.ok(indexes.some((index) => index.key[field] === 1 && index.sparse), field);
            }
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

        it('switches off the account\'s push token', async () => {
            const session = await googleSignIn('google-logout-1');
            await registerPushToken(session.body.token, 'device-1');

            const res = await logout(session.headers['set-cookie']);

            assert.ok(clearsRefreshCookie(res.headers['set-cookie']));
            const stored = await PushToken.findOne({ token: 'device-1' }).lean();
            assert.equal(stored?.isActive, false);
            assert.equal(stored?.failureReason, 'logged_out');
        });

        it('switches off pushes when the access token has already expired', async () => {
            const session = await googleSignIn('google-logout-2');
            await registerPushToken(session.body.token, 'device-2');
            const user = await User.findOne({}).select('_id').lean();
            const expiredToken = jwt.sign(
                { userId: user!._id.toString(), exp: Math.floor(Date.now() / 1000) - 60 },
                config.jwtSecret,
                { algorithm: 'HS256' }
            );

            // The app's own clean-up call needs a valid access token.
            await getTestAgent()
                .post('/v1/notifications/push/unregister')
                .set({ Authorization: `Bearer ${expiredToken}` })
                .send({ token: 'device-2' })
                .expect(401);

            await getTestAgent()
                .post('/v1/auth/logout')
                .set('Cookie', cookieList(session.headers['set-cookie']))
                .set({ Authorization: `Bearer ${expiredToken}` })
                .expect(200);

            const stored = await PushToken.findOne({ token: 'device-2' }).lean();
            assert.equal(stored?.isActive, false);
            assert.equal(stored?.failureReason, 'logged_out');
        });

        it('ends the session when logging out with the previous token', async () => {
            const session = await googleSignIn('google-logout-6');
            await registerPushToken(session.body.token, 'device-6');
            const original = issuedRefreshCookie(session.headers['set-cookie']);
            assert.ok(original);
            const successor = await rotate(original);

            const res = await logout(original);

            assert.ok(clearsRefreshCookie(res.headers['set-cookie']));
            await refresh(successor).expect(401);
            await refresh(original).expect(401);
            const stored = await PushToken.findOne({ token: 'device-6' }).lean();
            assert.equal(stored?.isActive, false);
            assert.equal(stored?.failureReason, 'logged_out');
        });

        it('ends the previous token too when logging out with the current one', async () => {
            const original = await signIn('google-logout-7');
            const successor = await rotate(original);

            await logout(successor);

            await refresh(original).expect(401);
            await refresh(successor).expect(401);
        });

        it('leaves pushes on for a cookie from a replaced session', async () => {
            const replacedSession = await googleSignIn('google-logout-3');
            const currentSession = await googleSignIn('google-logout-3');
            await registerPushToken(currentSession.body.token, 'device-3');

            await logout(replacedSession.headers['set-cookie']);

            const stored = await PushToken.findOne({ token: 'device-3' }).lean();
            assert.equal(stored?.isActive, true);
            await getTestAgent()
                .post('/v1/auth/refresh')
                .set('Cookie', cookieList(currentSession.headers['set-cookie']))
                .expect(200);
        });

        it('switches pushes back on when the user signs in and registers again', async () => {
            const firstSession = await googleSignIn('google-logout-4');
            await registerPushToken(firstSession.body.token, 'device-4');
            await logout(firstSession.headers['set-cookie']);
            assert.equal((await PushToken.findOne({ token: 'device-4' }).lean())?.isActive, false);

            const nextSession = await googleSignIn('google-logout-4');
            await registerPushToken(nextSession.body.token, 'device-4');

            const stored = await PushToken.findOne({ token: 'device-4' }).lean();
            assert.equal(stored?.isActive, true);
            assert.equal(stored?.failureReason, '');
        });

        it('still ends the session when switching off pushes fails', async (t) => {
            const session = await googleSignIn('google-logout-5');
            await registerPushToken(session.body.token, 'device-5');
            t.mock.method(PushToken, 'updateMany', async () => {
                throw new Error('database unavailable');
            });

            const res = await logout(session.headers['set-cookie']);

            assert.equal(res.body.success, true);
            assert.ok(clearsRefreshCookie(res.headers['set-cookie']));
            await getTestAgent()
                .post('/v1/auth/refresh')
                .set('Cookie', cookieList(session.headers['set-cookie']))
                .expect(401);
        });
    });
});
