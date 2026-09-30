import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader, makeProviderTestToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import { User } from '../../models/User.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { PushToken } from '../../models/PushToken.js';
import { ModerationAction } from '../../models/ModerationAction.js';
import { BannedIdentity } from '../../models/BannedIdentity.js';

const ADMIN_KEY = 'k'.repeat(40);

function admin() {
    return { 'x-admin-key': ADMIN_KEY };
}

function googleSignIn(sub: string) {
    return getTestAgent()
        .post('/v1/auth/provider-sign-in')
        .send({ provider: 'google', idToken: makeProviderTestToken({ sub, email: `${sub}@example.com`, email_verified: true }) });
}

async function signedInUserId(sub: string): Promise<string> {
    await googleSignIn(sub).expect(200);
    const users = await User.find({}).select('_id').lean();
    const identityUser = users[users.length - 1];
    return identityUser._id.toString();
}

describe('Moderation and enforcement', () => {
    const originalKey = config.admin.apiKey;

    before(async () => {
        await connectTestDb();
        config.admin.apiKey = ADMIN_KEY;
    });

    after(async () => {
        config.admin.apiKey = originalKey;
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetTestApp();
    });

    describe('admin gate', () => {
        it('rejects a missing or wrong key and accepts the right one', async () => {
            const agent = getTestAgent();
            await agent.get('/v1/admin/ping').expect(403);
            await agent.get('/v1/admin/ping').set({ 'x-admin-key': 'wrong' }).expect(403);
            const res = await agent.get('/v1/admin/ping').set(admin()).expect(200);
            assert.equal(res.body.ok, true);
        });

        it('is disabled entirely when no key is configured', async () => {
            config.admin.apiKey = '';
            try {
                await getTestAgent().get('/v1/admin/ping').set(admin()).expect(403);
            } finally {
                config.admin.apiKey = ADMIN_KEY;
            }
        });
    });

    describe('bans', () => {
        it('blocks sign-in and push re-registration and stops pushes', async () => {
            const userId = await signedInUserId('google-banned-1');
            await PushToken.create({ userId, token: 'push-1', platform: 'ios', isActive: true });

            await getTestAgent()
                .post(`/v1/admin/users/${userId}/ban`)
                .set(admin())
                .send({ reason: 'spam' })
                .expect(200);

            const token = await PushToken.findOne({ userId }).lean();
            assert.equal(token?.isActive, false);

            const signIn = await googleSignIn('google-banned-1').expect(403);
            assert.equal(signIn.body.error.code, 'USER_BLOCKED');
            assert.equal(signIn.body.error.message, 'Your account has been banned. Reason: spam');

            await getTestAgent()
                .post('/v1/notifications/push/register')
                .set(authHeader(userId))
                .send({ token: 'push-1', platform: 'ios' })
                .expect(403);
        });

        it('ends the refresh session and says why', async () => {
            const res = await googleSignIn('google-banned-2').expect(200);
            const cookie = res.headers['set-cookie'];
            const user = await User.findOne({}).select('_id').lean();

            await getTestAgent()
                .post(`/v1/admin/users/${user!._id}/ban`)
                .set(admin())
                .send({ reason: 'spam' })
                .expect(200);

            const refresh = await getTestAgent().post('/v1/auth/refresh').set('Cookie', cookie).expect(403);
            assert.equal(refresh.body.error.code, 'USER_BLOCKED');
            assert.equal(refresh.body.error.message, 'Your account has been banned. Reason: spam');
            assert.equal(refresh.body.token, undefined);

            const stored = await User.findById(user!._id).select('+refreshTokenHash').lean();
            assert.equal(stored?.refreshTokenHash, undefined);
        });

        it('explains a suspension on refresh', async () => {
            const res = await googleSignIn('google-suspended-2').expect(200);
            const cookie = res.headers['set-cookie'];
            const user = await User.findOne({}).select('_id').lean();

            await getTestAgent()
                .post(`/v1/admin/users/${user!._id}/suspend`)
                .set(admin())
                .send({ suspendedUntil: '2999-01-01T00:00:00Z' })
                .expect(200);

            const refresh = await getTestAgent().post('/v1/auth/refresh').set('Cookie', cookie).expect(403);
            assert.match(refresh.body.error.message, /suspended until 2999-01-01/);
        });

        it('keeps the ended session ended after the ban is lifted', async () => {
            const res = await googleSignIn('google-banned-4').expect(200);
            const cookie = res.headers['set-cookie'];
            const user = await User.findOne({}).select('_id').lean();

            await getTestAgent().post(`/v1/admin/users/${user!._id}/ban`).set(admin()).send({}).expect(200);
            await getTestAgent().post(`/v1/admin/users/${user!._id}/unban`).set(admin()).expect(200);

            await getTestAgent().post('/v1/auth/refresh').set('Cookie', cookie).expect(401);
        });

        it('forgets the ended session once the user signs in again', async () => {
            const userId = await signedInUserId('google-returning-1');
            await User.updateOne({ _id: userId }, { $set: { revokedRefreshTokenHash: 'ended-session' } });

            await googleSignIn('google-returning-1').expect(200);

            const stored = await User.findById(userId).select('+revokedRefreshTokenHash').lean();
            assert.equal(stored?.revokedRefreshTokenHash, undefined);
        });

        it('stores a reason that starts with $ as written', async () => {
            const userId = await signedInUserId('google-banned-5');

            await getTestAgent()
                .post(`/v1/admin/users/${userId}/ban`)
                .set(admin())
                .send({ reason: '$100 scam links' })
                .expect(200);

            const signIn = await googleSignIn('google-banned-5').expect(403);
            assert.equal(signIn.body.error.message, 'Your account has been banned. Reason: $100 scam links');
        });

        it('survives account deletion: the same identity cannot sign up again', async () => {
            const userId = await signedInUserId('google-banned-3');
            await getTestAgent().post(`/v1/admin/users/${userId}/ban`).set(admin()).send({}).expect(200);
            await getTestAgent().delete(`/v1/admin/users/${userId}`).set(admin()).expect(200);

            assert.equal(await User.countDocuments({}), 0);
            assert.equal(await BannedIdentity.countDocuments({}), 1);

            const retry = await googleSignIn('google-banned-3').expect(403);
            assert.equal(retry.body.error.code, 'USER_BLOCKED');
            assert.equal(await User.countDocuments({}), 0);
        });

        it('suspension blocks sign-in until lifted by unban', async () => {
            const userId = await signedInUserId('google-suspended-1');
            await getTestAgent()
                .post(`/v1/admin/users/${userId}/suspend`)
                .set(admin())
                .send({ suspendedUntil: '2999-01-01T00:00:00Z' })
                .expect(200);

            const blocked = await googleSignIn('google-suspended-1').expect(403);
            assert.match(blocked.body.error.message, /suspended until 2999-01-01/);

            await getTestAgent().post(`/v1/admin/users/${userId}/unban`).set(admin()).expect(200);
            await googleSignIn('google-suspended-1').expect(200);
            assert.equal(await BannedIdentity.countDocuments({}), 0);
        });
    });

    describe('content removal', () => {
        it('deleting a message also removes the notifications that quote it', async () => {
            const author = await createTestUser({ username: 'author' });
            const reader = await createTestUser({ username: 'reader' });
            const room = await Room.create({ name: 'General', type: 'public' });
            const root = await Message.create({ roomId: room._id, userId: reader._id, text: 'root' });
            const reply = await Message.create({ roomId: room._id, userId: author._id, text: 'reply', parentMessageId: root._id });
            await Notification.create({
                recipient: reader._id, sender: author._id, type: 'reply', room: room._id, message: reply._id, thread: root._id,
            });

            await getTestAgent().delete(`/v1/admin/messages/${reply._id}`).set(admin()).send({ reason: 'abuse' }).expect(200);

            assert.equal(await Notification.countDocuments({}), 0);
            const stored = await Message.findById(reply._id).lean();
            assert.ok(stored?.deletedAt);
        });

        it('clears an abusive profile', async () => {
            const user = await createTestUser({ username: 'rude_name', bio: 'rude bio' });

            const res = await getTestAgent()
                .post(`/v1/admin/users/${user._id}/clear-profile`)
                .set(admin())
                .send({ fields: ['username', 'bio'], reason: 'abusive profile' })
                .expect(200);

            assert.deepEqual(res.body.cleared, ['username', 'bio']);
            const stored = await User.findById(user._id).lean();
            assert.equal(stored?.username, '');
            assert.equal(stored?.bio, '');
            assert.equal(await ModerationAction.countDocuments({ action: 'user_profile_cleared' }), 1);
        });

        it('removes all of a user\'s messages at once', async () => {
            const spammer = await createTestUser({ username: 'spammer' });
            const room = await Room.create({ name: 'General', type: 'public' });
            await Message.create([
                { roomId: room._id, userId: spammer._id, text: 'spam 1' },
                { roomId: room._id, userId: spammer._id, text: 'spam 2' },
            ]);

            const res = await getTestAgent()
                .post(`/v1/admin/users/${spammer._id}/remove-messages`)
                .set(admin())
                .send({ reason: 'spam' })
                .expect(200);

            assert.equal(res.body.removed, 2);
            assert.equal(await Message.countDocuments({ deletedAt: null }), 0);
        });
    });

    describe('data-subject requests', () => {
        it('exports a user\'s data and records the export', async () => {
            const user = await createTestUser({ username: 'subject' });
            const res = await getTestAgent().get(`/v1/admin/users/${user._id}/export`).set(admin()).expect(200);
            assert.equal(res.body.account.username, 'subject');
            assert.equal(res.body.account.status, 'active');
            assert.deepEqual(res.body.reportsFiled, []);
            assert.equal(await ModerationAction.countDocuments({ action: 'user_data_exported' }), 1);
        });

        it('rejects malformed ids', async () => {
            await getTestAgent().get('/v1/admin/users/not-an-id/export').set(admin()).expect(400);
            await getTestAgent()
                .delete(`/v1/admin/users/${new mongoose.Types.ObjectId()}`)
                .set(admin())
                .expect(404);
        });
    });
});
