import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { User } from '../../models/User.js';
import { PasskeyCredential } from '../../models/PasskeyCredential.js';

function tokenIssuedAt(userId: string, issuedAtMs: number): string {
    return jwt.sign(
        { userId, iat: Math.floor(issuedAtMs / 1000) },
        config.jwtSecret,
        { algorithm: 'HS256', expiresIn: '1h' }
    );
}

describe('Sessions and passkeys', () => {
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

    describe('passkey registration', () => {
        it('is allowed right after signing in', async () => {
            const res = await getTestAgent()
                .post('/v1/auth/provider-sign-in')
                .send({ provider: 'google', idToken: makeProviderTestToken({ sub: 'g-passkey-1' }) })
                .expect(200);

            const options = await getTestAgent()
                .post('/v1/auth/passkeys/registration/options')
                .set({ Authorization: `Bearer ${res.body.token}` })
                .expect(200);
            assert.ok(options.body.challengeId);
        });

        it('needs a fresh sign-in, not just a valid token', async () => {
            const user = await createTestUser({ username: 'stale' });
            const signedInAt = Date.now() - 2 * 60 * 60 * 1000;
            await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date(signedInAt) } });

            await getTestAgent()
                .post('/v1/auth/passkeys/registration/options')
                .set({ Authorization: `Bearer ${tokenIssuedAt(user._id.toString(), Date.now())}` })
                .expect(403);
        });

        it('rejects a token from before the latest sign-in', async () => {
            const user = await createTestUser({ username: 'resigned' });
            await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });

            await getTestAgent()
                .post('/v1/auth/passkeys/registration/options')
                .set({ Authorization: `Bearer ${tokenIssuedAt(user._id.toString(), Date.now() - 10 * 60 * 1000)}` })
                .expect(403);
        });
    });

    it('lists and deletes passkeys', async () => {
        const user = await createTestUser({ username: 'keys' });
        await User.updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
        const passkey = await PasskeyCredential.create({
            userId: user._id,
            credentialId: 'cred-1',
            publicKey: 'pk',
            counter: 0,
        });

        const list = await getTestAgent().get('/v1/auth/passkeys').set(authHeader(user._id.toString())).expect(200);
        assert.deepEqual(list.body.map((item: { id: string }) => item.id), [passkey._id.toString()]);

        const res = await getTestAgent()
            .delete(`/v1/auth/passkeys/${passkey._id}`)
            .set(authHeader(user._id.toString()))
            .expect(200);
        assert.equal(res.body.hasPasskey, false);

        await getTestAgent()
            .delete(`/v1/auth/passkeys/${new mongoose.Types.ObjectId()}`)
            .set(authHeader(user._id.toString()))
            .expect(404);
    });
});
