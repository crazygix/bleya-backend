import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { createTestUser, authHeader } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { UserBlock } from '../../models/UserBlock.js';
import { buildRoomJoinView } from '../../services/roomService.js';
import { openOrCreateDirectRoom } from '../../services/directMessageService.js';
import { findOrCreateCityRoom } from '../../services/cityService.js';
import type { ICity } from '../../models/City.js';

describe('Visibility: blocks, moderation and data integrity', () => {
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

    async function publicRoomWith(...userIds: mongoose.Types.ObjectId[]) {
        const room = await Room.create({ name: 'General', type: 'public' });
        for (const userId of userIds) {
            await mongoose.model('User').updateOne({ _id: userId }, { $addToSet: { joinedRooms: room._id } });
        }
        return room;
    }

    it('hides a blocked user\'s messages when a room is opened over the socket', async () => {
        const me = await createTestUser({ username: 'myself' });
        const blocked = await createTestUser({ username: 'blocked' });
        const room = await publicRoomWith(me._id, blocked._id);
        await Message.create([
            { roomId: room._id, userId: blocked._id, text: 'hidden' },
            { roomId: room._id, userId: me._id, text: 'visible' },
        ]);
        await UserBlock.create({ blockerUserId: me._id, blockedUserId: blocked._id });

        const view = await buildRoomJoinView(me._id.toString(), room._id as mongoose.Types.ObjectId);
        assert.deepEqual(view.messages.map((message) => message.text), ['visible']);

        // Mutual: the blocked user doesn't see the blocker's messages either.
        const reverse = await buildRoomJoinView(blocked._id.toString(), room._id as mongoose.Types.ObjectId);
        assert.deepEqual(reverse.messages.map((message) => message.text), ['hidden']);
    });

    it('leaves a blocked user out of room previews and unread counts', async () => {
        const me = await createTestUser({ username: 'myself' });
        const friend = await createTestUser({ username: 'friend' });
        const blocked = await createTestUser({ username: 'blocked' });
        const room = await publicRoomWith(me._id, friend._id, blocked._id);
        await Message.create({ roomId: room._id, userId: friend._id, text: 'from friend', createdAt: new Date(Date.now() - 1000) });
        await Message.create({ roomId: room._id, userId: blocked._id, text: 'from blocked' });
        await UserBlock.create({ blockerUserId: blocked._id, blockedUserId: me._id });

        const res = await getTestAgent().get('/v1/rooms/joined').set(authHeader(me._id.toString())).expect(200);
        assert.equal(res.body[0].lastMessageText, 'from friend');
        assert.equal(res.body[0].unreadCount, 1);
    });

    it('filters blocked senders, removed messages and dangling references from notifications', async () => {
        const me = await createTestUser({ username: 'myself' });
        const friend = await createTestUser({ username: 'friend' });
        const blocked = await createTestUser({ username: 'blocked' });
        const room = await publicRoomWith(me._id, friend._id, blocked._id);
        const root = await Message.create({ roomId: room._id, userId: me._id, text: 'root' });
        const friendReply = await Message.create({ roomId: room._id, userId: friend._id, text: 'hi', parentMessageId: root._id });
        const blockedReply = await Message.create({ roomId: room._id, userId: blocked._id, text: 'hey', parentMessageId: root._id });
        const removedReply = await Message.create({
            roomId: room._id, userId: friend._id, text: 'removed', parentMessageId: root._id, deletedAt: new Date(),
        });

        const base = { recipient: me._id, type: 'reply', room: room._id, thread: root._id };
        await Notification.create([
            { ...base, sender: friend._id, message: friendReply._id },
            { ...base, sender: blocked._id, message: blockedReply._id },
            { ...base, sender: friend._id, message: removedReply._id },
            { ...base, sender: friend._id, message: new mongoose.Types.ObjectId() },
        ]);
        await UserBlock.create({ blockerUserId: me._id, blockedUserId: blocked._id });

        const res = await getTestAgent().get('/v1/notifications').set(authHeader(me._id.toString())).expect(200);
        assert.deepEqual(res.body.notifications.map((n: { replyText: string }) => n.replyText), ['hi']);
        assert.equal(res.body.notifications[0].sender.username, 'friend');
        assert.equal(res.body.unreadCount, 1);
    });

    it('unblocks from a profile after a user-level block', async () => {
        const me = await createTestUser({ username: 'myself' });
        const other = await createTestUser({ username: 'other' });
        await getTestAgent().post(`/v1/users/${other._id}/block`).set(authHeader(me._id.toString())).expect(200);

        const res = await getTestAgent()
            .post(`/v1/rooms/direct/${other._id}/unblock`)
            .set(authHeader(me._id.toString()))
            .expect(200);
        assert.equal(res.body.blocked, false);
        assert.equal(await UserBlock.countDocuments({ isActive: true }), 0);
    });

    it('does not let an upper-case id get around a block or open a self-DM', async () => {
        const me = await createTestUser({ username: 'myself' });
        const other = await createTestUser({ username: 'other' });
        await UserBlock.create({ blockerUserId: other._id, blockedUserId: me._id });

        await getTestAgent()
            .post(`/v1/rooms/direct/${other._id.toString().toUpperCase()}`)
            .set(authHeader(me._id.toString()))
            .expect(403);

        await getTestAgent()
            .post(`/v1/rooms/direct/${me._id.toString().toUpperCase()}`)
            .set(authHeader(me._id.toString()))
            .expect(400);

        assert.equal(await Room.countDocuments({ type: 'private' }), 0);
    });

    it('opens exactly one DM room for concurrent requests', async () => {
        const me = await createTestUser({ username: 'myself' });
        const other = await createTestUser({ username: 'other' });

        const results = await Promise.all(
            Array.from({ length: 8 }, () => openOrCreateDirectRoom(me._id.toString(), other._id.toString()))
        );

        assert.equal(new Set(results.map((result) => result.room.id)).size, 1);
        assert.equal(await Room.countDocuments({ type: 'private' }), 1);
        const stored = await Room.findOne({ type: 'private' }).lean();
        assert.equal(stored?.name, 'Direct message');
        assert.equal(results[0].room.name, 'other');
    });

    it('creates exactly one room for concurrent first joins of a city', async () => {
        const city = {
            _id: 'belgrade-rs',
            name: 'Belgrade',
            country: 'RS',
            countryName: 'Serbia',
            location: { type: 'Point', coordinates: [20.46, 44.81] },
        } as unknown as ICity;

        const rooms = await Promise.all(Array.from({ length: 8 }, () => findOrCreateCityRoom(city)));

        assert.equal(new Set(rooms.map((room) => room!._id.toString())).size, 1);
        assert.equal(await Room.countDocuments({ cityKey: 'belgrade-rs' }), 1);
    });
});
