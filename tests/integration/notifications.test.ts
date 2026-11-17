import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { PushToken } from '../../models/PushToken.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { UserBlock } from '../../models/UserBlock.js';

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

    describe('POST /v1/notifications/threads/:threadId/dismiss', () => {
        // A city room where `me` started two threads, `friend` replied in
        // both, and `other` got a reply of their own in the first one.
        async function threadsWithReplies() {
            const room = await Room.create({ name: 'General', type: 'public' });
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'myself', joinedRooms: [roomId] });
            const friend = await createTestUser({ username: 'friend', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'other', joinedRooms: [roomId] });
            const thread = await Message.create({ roomId, userId: me._id, text: 'Coffee?' });
            const otherThread = await Message.create({ roomId, userId: me._id, text: 'Lunch?' });
            const replies = await Message.create([
                { roomId, userId: friend._id, text: 'Yes', parentMessageId: thread._id },
                { roomId, userId: friend._id, text: 'At 10?', parentMessageId: thread._id },
                { roomId, userId: friend._id, text: 'Or 11', parentMessageId: thread._id },
                { roomId, userId: friend._id, text: 'Sure', parentMessageId: otherThread._id },
            ]);
            const item = (recipient: mongoose.Types.ObjectId, reply: typeof replies[number], read = false) => ({
                recipient,
                sender: friend._id,
                type: 'reply',
                room: roomId,
                message: reply._id,
                thread: reply.parentMessageId,
                read,
            });
            await Notification.create([
                item(me._id, replies[0]),
                item(me._id, replies[1]),
                // Read already, e.g. its push was tapped, but still listed.
                item(me._id, replies[2], true),
                item(me._id, replies[3]),
                item(other._id, replies[1]),
            ]);
            return { me, friend, other, thread, otherThread };
        }

        /** The threads of the items Activity still lists for the user. */
        async function listedThreadIds(userId: mongoose.Types.ObjectId): Promise<string[]> {
            const listed = await Notification.find({ recipient: userId, isDismissed: false }).lean();
            return listed.map((notification) => notification.thread.toString());
        }

        it("takes all of the caller's items from that thread out of Activity, and only those", async () => {
            const { me, other, thread, otherThread } = await threadsWithReplies();

            const res = await getTestAgent()
                .post(`/v1/notifications/threads/${thread._id}/dismiss`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.deepEqual(res.body, { success: true, unreadCount: 1 });
            // The read item goes too, and what's dismissed counts as read.
            assert.deepEqual(await listedThreadIds(me._id), [otherThread._id.toString()]);
            assert.equal(await Notification.countDocuments({ recipient: me._id, isDismissed: true, read: false }), 0);
            // Someone else's item from the same thread stays.
            assert.deepEqual(await listedThreadIds(other._id), [thread._id.toString()]);

            const list = await getTestAgent().get('/v1/notifications').set(authHeader(me._id.toString())).expect(200);
            assert.deepEqual(list.body.notifications.map((n: { replyText: string }) => n.replyText), ['Sure']);
            assert.equal(list.body.unreadCount, 1);
        });

        it('counts what is left the way the Activity list does', async () => {
            const { me, friend, otherThread } = await threadsWithReplies();
            await UserBlock.create({ blockerUserId: me._id, blockedUserId: friend._id });

            const res = await getTestAgent()
                .post(`/v1/notifications/threads/${otherThread._id}/dismiss`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            // The first thread's items are still unread, but they come from
            // a blocked user, so Activity doesn't count them.
            assert.equal(res.body.unreadCount, 0);
            const list = await getTestAgent().get('/v1/notifications').set(authHeader(me._id.toString())).expect(200);
            assert.equal(list.body.unreadCount, 0);
        });

        it('succeeds for a thread with nothing to take out', async () => {
            const { me } = await threadsWithReplies();

            const res = await getTestAgent()
                .post(`/v1/notifications/threads/${new mongoose.Types.ObjectId()}/dismiss`)
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.deepEqual(res.body, { success: true, unreadCount: 3 });
        });

        it('rejects a thread id that is not valid', async () => {
            const user = await createTestUser();

            await getTestAgent()
                .post('/v1/notifications/threads/not-an-id/dismiss')
                .set(authHeader(user._id.toString()))
                .expect(400);
        });

        it('returns 401 without authentication', async () => {
            await getTestAgent()
                .post(`/v1/notifications/threads/${new mongoose.Types.ObjectId()}/dismiss`)
                .expect(401);
        });
    });
});
