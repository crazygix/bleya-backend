import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { User } from '../../models/User.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { UserBlock } from '../../models/UserBlock.js';
import { Notification } from '../../models/Notification.js';
import { PasskeyCredential } from '../../models/PasskeyCredential.js';
import { UserIdentity } from '../../models/UserIdentity.js';
import { PushToken } from '../../models/PushToken.js';

async function createPublicRoom(name: string) {
    return Room.create({ name, type: 'public' });
}

async function createDirectRoom(a: string, b: string) {
    const sorted = [a, b].sort();
    return Room.create({
        name: `DM: ${sorted.join(' & ')}`,
        type: 'private',
        participants: sorted.map((id) => new mongoose.Types.ObjectId(id)),
        participantsHash: sorted.join('_'),
    });
}

describe('Account API', () => {
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

    describe('GET /v1/users/me/export', () => {
        it('exports profile, messages, rooms and blocks', async () => {
            const room = await createPublicRoom('Export Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'bob' });

            const dm = await createDirectRoom(me._id.toString(), other._id.toString());
            await User.updateOne({ _id: me._id }, { $addToSet: { joinedRooms: dm._id } });

            await Message.create({ roomId, userId: me._id, text: 'hello world', parentMessageId: null });
            await UserBlock.create({
                blockerUserId: me._id,
                blockedUserId: other._id,
                roomId: dm._id,
                isActive: true,
            });

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/users/me/export')
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.equal(res.body.account.username, 'alice');
            assert.equal(res.body.messages.length, 1);
            assert.equal(res.body.messages[0].text, 'hello world');

            const roomIds = res.body.rooms.map((r: { id: string }) => r.id);
            assert.ok(roomIds.includes(roomId.toString()));
            assert.ok(roomIds.includes((dm._id as mongoose.Types.ObjectId).toString()));

            const dmExport = res.body.rooms.find((r: { id: string }) => r.id === (dm._id as mongoose.Types.ObjectId).toString());
            assert.equal(dmExport.type, 'private');
            assert.ok(dmExport.otherParticipantIds.includes(other._id.toString()));

            assert.equal(res.body.blockedUsers.length, 1);
            assert.equal(res.body.blockedUsers[0].blockedUserId, other._id.toString());

            // Sent as a downloadable attachment.
            assert.match(res.headers['content-disposition'] || '', /attachment/);
        });

        it('includes notifications, blocks-by-others, inactive blocks, hidden rooms and read pointers', async () => {
            const room = await createPublicRoom('Full Export');
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'bob' });

            const root = await Message.create({ roomId, userId: me._id, text: 'root', parentMessageId: null });
            const reply = await Message.create({ roomId, userId: other._id, text: 'reply', parentMessageId: root._id });
            await Notification.create({
                recipient: me._id,
                sender: other._id,
                type: 'reply',
                room: roomId,
                message: reply._id,
                thread: root._id,
            });

            // Another user blocked me (data about me, created by them).
            await UserBlock.create({ blockerUserId: other._id, blockedUserId: me._id, roomId, isActive: true });
            // A block I created, then lifted (inactive) — must still appear.
            await UserBlock.create({ blockerUserId: me._id, blockedUserId: other._id, roomId, isActive: false });

            const dm = await createDirectRoom(me._id.toString(), other._id.toString());
            await User.updateOne({ _id: me._id }, {
                $addToSet: { hiddenDirectRooms: dm._id },
                $push: { roomReadPointers: { roomId, lastReadAt: new Date() } },
            });

            const agent = getTestAgent();
            const res = await agent
                .get('/v1/users/me/export')
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.equal(res.body.notifications.length, 1);
            assert.equal(res.body.notifications[0].role, 'recipient');
            assert.equal(res.body.notifications[0].roomId, roomId.toString());

            assert.equal(res.body.blockedByOthers.length, 1);
            assert.equal(res.body.blockedByOthers[0].active, true);
            // Art. 15(4): the blocker's identity must NOT be disclosed.
            assert.ok(!('blockerUserId' in res.body.blockedByOthers[0]));
            assert.ok(!('blockedUserId' in res.body.blockedByOthers[0]));

            // Inactive block I created is still included, flagged active:false.
            assert.equal(res.body.blockedUsers.length, 1);
            assert.equal(res.body.blockedUsers[0].active, false);

            assert.equal(res.body.account.hiddenDirectRoomIds.length, 1);
            assert.equal(res.body.account.hiddenDirectRoomIds[0], (dm._id as mongoose.Types.ObjectId).toString());
            assert.equal(res.body.account.roomReadPointers.length, 1);
            assert.equal(res.body.account.roomReadPointers[0].roomId, roomId.toString());
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.get('/v1/users/me/export').expect(401);
        });
    });

    describe('DELETE /v1/users/me', () => {
        it('hard-deletes the user, their messages, and cascades related data', async () => {
            const room = await createPublicRoom('Delete Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'bob', joinedRooms: [roomId] });

            const mine = await Message.create({ roomId, userId: me._id, text: 'mine', parentMessageId: null });
            const theirs = await Message.create({ roomId, userId: other._id, text: 'theirs', parentMessageId: null });

            await PasskeyCredential.create({ userId: me._id, credentialId: 'cred-1', publicKey: 'pk' });
            await UserIdentity.create({ userId: me._id, provider: 'google', providerUserId: 'g-1', email: 'a@example.com' });
            await PushToken.create({ userId: me._id, token: 'tok-1', platform: 'ios' });
            await UserBlock.create({ blockerUserId: me._id, blockedUserId: other._id, roomId, isActive: true });
            await Notification.create({
                recipient: me._id,
                sender: other._id,
                type: 'reply',
                room: roomId,
                message: theirs._id,
                thread: mine._id,
            });

            const agent = getTestAgent();
            const res = await agent
                .delete('/v1/users/me')
                .set(authHeader(me._id.toString()))
                .expect(200);

            assert.equal(res.body.deleted, true);
            assert.ok(res.body.removed.messages >= 1);

            assert.equal(await User.findById(me._id), null);
            assert.equal(await Message.countDocuments({ userId: me._id }), 0);
            assert.ok(await Message.findById(theirs._id)); // other user's message kept
            assert.equal(await PasskeyCredential.countDocuments({ userId: me._id }), 0);
            assert.equal(await UserIdentity.countDocuments({ userId: me._id }), 0);
            assert.equal(await PushToken.countDocuments({ userId: me._id }), 0);
            assert.equal(await UserBlock.countDocuments({ blockerUserId: me._id }), 0);
            assert.equal(
                await Notification.countDocuments({ $or: [{ recipient: me._id }, { sender: me._id }] }),
                0
            );

            // Refresh cookie is cleared.
            const setCookie = (res.headers['set-cookie'] || []) as string[];
            assert.ok(setCookie.some((c) => c.startsWith('refreshToken=')));

            // The now-deleted account can no longer be fetched even with a valid token.
            await agent.get('/v1/users/me').set(authHeader(me._id.toString())).expect(404);
        });

        it('re-parents replies left under a deleted thread root to top-level', async () => {
            const room = await createPublicRoom('Thread Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'bob', joinedRooms: [roomId] });

            const root = await Message.create({ roomId, userId: me._id, text: 'root', parentMessageId: null, replyCount: 1 });
            const reply = await Message.create({ roomId, userId: other._id, text: 'reply', parentMessageId: root._id });

            const agent = getTestAgent();
            await agent.delete('/v1/users/me').set(authHeader(me._id.toString())).expect(200);

            assert.equal(await Message.findById(root._id), null); // root deleted
            const keptReply = await Message.findById(reply._id);
            assert.ok(keptReply); // other user's reply kept
            assert.equal(keptReply!.parentMessageId, null); // re-parented to top-level
        });

        it('recomputes reply count on a surviving thread', async () => {
            const room = await createPublicRoom('Count Room');
            const roomId = room._id as mongoose.Types.ObjectId;
            const me = await createTestUser({ username: 'alice', joinedRooms: [roomId] });
            const other = await createTestUser({ username: 'bob', joinedRooms: [roomId] });
            const third = await createTestUser({ username: 'carol', joinedRooms: [roomId] });

            const root = await Message.create({ roomId, userId: other._id, text: 'root', parentMessageId: null, replyCount: 2 });
            await Message.create({ roomId, userId: me._id, text: 'my reply', parentMessageId: root._id });
            const keptReply = await Message.create({ roomId, userId: third._id, text: 'their reply', parentMessageId: root._id });

            const agent = getTestAgent();
            await agent.delete('/v1/users/me').set(authHeader(me._id.toString())).expect(200);

            const survivingRoot = await Message.findById(root._id);
            assert.ok(survivingRoot);
            assert.equal(survivingRoot!.replyCount, 1); // recomputed from 2 -> 1
            assert.ok(await Message.findById(keptReply._id));
        });

        it('removes the deleted user\'s DM messages but keeps the other participant\'s', async () => {
            const me = await createTestUser({ username: 'alice' });
            const other = await createTestUser({ username: 'bob' });
            const dm = await createDirectRoom(me._id.toString(), other._id.toString());
            const dmId = dm._id as mongoose.Types.ObjectId;
            await User.updateOne({ _id: me._id }, { $addToSet: { joinedRooms: dmId } });
            await User.updateOne({ _id: other._id }, { $addToSet: { joinedRooms: dmId } });

            await Message.create({ roomId: dmId, userId: me._id, text: 'from me', parentMessageId: null });
            const theirDm = await Message.create({ roomId: dmId, userId: other._id, text: 'from them', parentMessageId: null });

            const agent = getTestAgent();
            await agent.delete('/v1/users/me').set(authHeader(me._id.toString())).expect(200);

            assert.equal(await Message.countDocuments({ roomId: dmId, userId: me._id }), 0);
            assert.ok(await Message.findById(theirDm._id)); // other participant keeps their message
            assert.ok(await Room.findById(dmId)); // DM room left intact
        });

        it('returns 401 without auth', async () => {
            const agent = getTestAgent();
            await agent.delete('/v1/users/me').expect(401);
        });
    });
});
