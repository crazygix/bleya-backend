import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import type { Message as PushMessage } from 'firebase-admin/messaging';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser } from '../helpers/auth.js';
import { PushToken } from '../../models/PushToken.js';
import { User } from '../../models/User.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { UserBlock } from '../../models/UserBlock.js';
import { NotificationService } from '../../services/NotificationService.js';
import {
    deactivatePushTokensForUser,
    registerPushToken,
    resetPushMessagingForTests,
    sendPushNotifications,
    setPushMessagingForTests,
    type SendPushNotificationsInput,
} from '../../services/pushNotificationService.js';

const SOUND_ONLY_APNS = { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } };
const ANDROID_CONFIG = { priority: 'high', notification: { channelId: 'bleya_messages', sound: 'default' } };

function recordPushes(): PushMessage[] {
    const sent: PushMessage[] = [];
    setPushMessagingForTests({
        sendEach: async (messages) => {
            sent.push(...messages);
            return { responses: messages.map(() => ({ success: true })) };
        },
    });
    return sent;
}

function pushTo(userIds: string[], overrides: Partial<SendPushNotificationsInput> = {}): SendPushNotificationsInput {
    return {
        type: 'message',
        recipients: userIds.map((userId) => ({ userId })),
        roomId: new mongoose.Types.ObjectId().toString(),
        roomName: 'General',
        roomType: 'public',
        messageId: new mongoose.Types.ObjectId().toString(),
        threadId: null,
        senderId: new mongoose.Types.ObjectId().toString(),
        senderUsername: 'alice',
        messageText: 'Hello world',
        ...overrides,
    };
}

function tokenOf(push: PushMessage): string | undefined {
    return 'token' in push ? push.token : undefined;
}

function pushFor(sent: PushMessage[], token: string): PushMessage {
    const push = sent.find((message) => tokenOf(message) === token);
    assert.ok(push, `no push was sent to ${token}`);
    return push;
}

async function publicRoom(...members: mongoose.Types.ObjectId[]): Promise<mongoose.Types.ObjectId> {
    const room = await Room.create({ name: 'City', type: 'public' });
    await User.updateMany({ _id: { $in: members } }, { $addToSet: { joinedRooms: room._id } });
    return room._id as mongoose.Types.ObjectId;
}

async function directRoom(a: mongoose.Types.ObjectId, b: mongoose.Types.ObjectId): Promise<mongoose.Types.ObjectId> {
    const room = await Room.create({
        name: 'Direct',
        type: 'private',
        participants: [a, b],
        participantsHash: [a.toString(), b.toString()].sort().join('_'),
    });
    await User.updateMany({ _id: { $in: [a, b] } }, { $addToSet: { joinedRooms: room._id } });
    return room._id as mongoose.Types.ObjectId;
}

// An Activity item for `recipient`: `sender` replied in a thread they started.
async function replyNotification(
    recipient: mongoose.Types.ObjectId,
    sender: mongoose.Types.ObjectId,
    roomId: mongoose.Types.ObjectId,
    state: { read?: boolean; isDismissed?: boolean; replyRemoved?: boolean } = {}
): Promise<void> {
    const thread = await Message.create({ roomId, userId: recipient, text: 'thread' });
    const reply = await Message.create({
        roomId,
        userId: sender,
        text: 'reply',
        parentMessageId: thread._id,
        deletedAt: state.replyRemoved ? new Date() : null,
    });
    await Notification.create({
        recipient,
        sender,
        type: 'reply',
        room: roomId,
        message: reply._id,
        thread: thread._id,
        read: state.read ?? false,
        isDismissed: state.isDismissed ?? false,
    });
}

describe('pushNotificationService', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        resetPushMessagingForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetPushMessagingForTests();
    });

    it('deactivates invalid tokens returned by Firebase', async () => {
        const user = await createTestUser();
        await PushToken.create({
            userId: user._id,
            token: 'invalid-token',
            platform: 'ios',
            isActive: true,
        });

        setPushMessagingForTests({
            sendEach: async () => ({
                successCount: 0,
                failureCount: 1,
                responses: [{
                    success: false,
                    error: {
                        code: 'messaging/registration-token-not-registered',
                        message: 'Token no longer valid',
                    },
                }],
            }),
        });

        await sendPushNotifications({
            type: 'message',
            recipients: [{ userId: user._id.toString() }],
            roomId: new mongoose.Types.ObjectId().toString(),
            roomName: 'General',
            roomType: 'public',
            messageId: new mongoose.Types.ObjectId().toString(),
            threadId: null,
            senderId: new mongoose.Types.ObjectId().toString(),
            senderUsername: 'alice',
            messageText: 'Hello world',
        });

        const storedToken = await PushToken.findOne({ userId: user._id }).lean();
        assert.equal(storedToken?.isActive, false);
        assert.equal(storedToken?.failureReason, 'messaging/registration-token-not-registered');
    });

    it('keeps tokens active on transient provider failures', async () => {
        const user = await createTestUser();
        await PushToken.create({
            userId: user._id,
            token: 'transient-token',
            platform: 'android',
            isActive: true,
        });

        setPushMessagingForTests({
            sendEach: async () => ({
                successCount: 0,
                failureCount: 1,
                responses: [{
                    success: false,
                    error: {
                        code: 'messaging/internal-error',
                        message: 'Temporary failure',
                    },
                }],
            }),
        });

        await sendPushNotifications({
            type: 'reply',
            recipients: [{
                userId: user._id.toString(),
                notificationId: new mongoose.Types.ObjectId().toString(),
            }],
            roomId: new mongoose.Types.ObjectId().toString(),
            roomName: 'General',
            roomType: 'public',
            messageId: new mongoose.Types.ObjectId().toString(),
            threadId: new mongoose.Types.ObjectId().toString(),
            senderId: new mongoose.Types.ObjectId().toString(),
            senderUsername: 'bob',
            messageText: 'Reply text',
        });

        const storedToken = await PushToken.findOne({ userId: user._id }).lean();
        assert.equal(storedToken?.isActive, true);
        assert.equal(storedToken?.failureReason, 'messaging/internal-error');
    });

    it('plays the default sound on iPhone and Android for messages and replies', async () => {
        const iphone = await createTestUser();
        const android = await createTestUser();
        await PushToken.create([
            { userId: iphone._id, token: 'token-ios', platform: 'ios', isActive: true },
            { userId: android._id, token: 'token-android', platform: 'android', isActive: true },
        ]);
        const recipients = [iphone._id.toString(), android._id.toString()];

        const sent = recordPushes();
        await sendPushNotifications(pushTo(recipients));
        await sendPushNotifications(pushTo(recipients, {
            type: 'reply',
            threadId: new mongoose.Types.ObjectId().toString(),
            messageText: 'Reply text',
        }));

        assert.equal(sent.length, 4);
        for (const push of sent) {
            assert.deepEqual(push.apns, SOUND_ONLY_APNS);
            assert.deepEqual(push.android, ANDROID_CONFIG);
        }
    });

    it('sets the iPhone badge to unread Activity items plus DM chats with unread messages', async () => {
        const me = await createTestUser({ username: 'myself' });
        const friend = await createTestUser({ username: 'friend' });
        const reader = await createTestUser({ username: 'reader' });
        const hider = await createTestUser({ username: 'hider' });
        const blocked = await createTestUser({ username: 'blocked' });
        const quiet = await createTestUser({ username: 'quiet' });

        // Activity: the two unread replies count. Read, dismissed and removed
        // replies don't, and neither does anything from a blocked user.
        const city = await publicRoom(me._id, friend._id, blocked._id);
        await replyNotification(me._id, friend._id, city);
        await replyNotification(me._id, friend._id, city);
        await replyNotification(me._id, friend._id, city, { read: true });
        await replyNotification(me._id, friend._id, city, { isDismissed: true });
        await replyNotification(me._id, friend._id, city, { replyRemoved: true });
        await replyNotification(me._id, blocked._id, city);
        // City rooms don't count.
        await Message.create({ roomId: city, userId: friend._id, text: 'city news' });

        // DMs: a chat counts once, however many unread messages it has.
        const unreadDm = await directRoom(me._id, friend._id);
        await Message.create([
            { roomId: unreadDm, userId: friend._id, text: 'hi' },
            { roomId: unreadDm, userId: friend._id, text: 'are you there?' },
        ]);
        const readDm = await directRoom(me._id, reader._id);
        await Message.create({
            roomId: readDm,
            userId: reader._id,
            text: 'already read',
            createdAt: new Date(Date.now() - 60_000),
        });
        await User.updateOne(
            { _id: me._id },
            { $push: { roomReadPointers: { roomId: readDm, lastReadAt: new Date() } } }
        );
        const hiddenDm = await directRoom(me._id, hider._id);
        await Message.create({ roomId: hiddenDm, userId: hider._id, text: 'in a hidden chat' });
        await User.updateOne({ _id: me._id }, { $addToSet: { hiddenDirectRooms: hiddenDm } });
        const blockedDm = await directRoom(me._id, blocked._id);
        await Message.create({ roomId: blockedDm, userId: blocked._id, text: 'from a blocked user' });
        const ownDm = await directRoom(me._id, quiet._id);
        await Message.create({ roomId: ownDm, userId: me._id, text: 'my own message' });
        await UserBlock.create({ blockerUserId: me._id, blockedUserId: blocked._id });

        await registerPushToken({ userId: me._id.toString(), token: 'token-me', platform: 'ios', badge: true });
        await registerPushToken({ userId: friend._id.toString(), token: 'token-friend', platform: 'ios', badge: true });

        const sent = recordPushes();
        await sendPushNotifications(pushTo([me._id.toString(), friend._id.toString()]));

        assert.deepEqual(pushFor(sent, 'token-me').apns, {
            headers: { 'apns-priority': '10' },
            payload: { aps: { sound: 'default', badge: 3 } },
        });
        // Each recipient gets their own count. Nothing is unread for friend, so
        // the push clears their badge.
        assert.deepEqual(pushFor(sent, 'token-friend').apns, {
            headers: { 'apns-priority': '10' },
            payload: { aps: { sound: 'default', badge: 0 } },
        });
        assert.deepEqual(pushFor(sent, 'token-me').android, ANDROID_CONFIG);
    });

    it('caps the badge at 99', async () => {
        const me = await createTestUser({ username: 'myself' });
        const friend = await createTestUser({ username: 'friend' });
        const city = await publicRoom(me._id, friend._id);
        const thread = await Message.create({ roomId: city, userId: me._id, text: 'thread' });
        const reply = await Message.create({ roomId: city, userId: friend._id, text: 'reply', parentMessageId: thread._id });
        await Notification.insertMany(Array.from({ length: 120 }, () => ({
            recipient: me._id,
            sender: friend._id,
            type: 'reply',
            room: city,
            message: reply._id,
            thread: thread._id,
        })));
        await registerPushToken({ userId: me._id.toString(), token: 'token-me', platform: 'ios', badge: true });

        const sent = recordPushes();
        await sendPushNotifications(pushTo([me._id.toString()]));

        assert.equal(pushFor(sent, 'token-me').apns?.payload?.aps.badge, 99);
    });

    it('sends no badge to app builds that did not ask for it, or to Android', async () => {
        const olderIphone = await createTestUser({ username: 'older' });
        const android = await createTestUser({ username: 'android' });
        const friend = await createTestUser({ username: 'friend' });
        for (const user of [olderIphone, android]) {
            const dm = await directRoom(user._id, friend._id);
            await Message.create({ roomId: dm, userId: friend._id, text: 'unread' });
        }
        await registerPushToken({ userId: olderIphone._id.toString(), token: 'token-older', platform: 'ios' });
        await registerPushToken({
            userId: android._id.toString(),
            token: 'token-android',
            platform: 'android',
            badge: true,
        });

        const sent = recordPushes();
        await sendPushNotifications(pushTo([olderIphone._id.toString(), android._id.toString()]));

        assert.equal(sent.length, 2);
        for (const push of sent) {
            assert.deepEqual(push.apns, SOUND_ONLY_APNS);
            assert.deepEqual(push.android, ANDROID_CONFIG);
        }
    });

    it('registers without the badge flag as before, and the next registration replaces the flag', async () => {
        const me = await createTestUser({ username: 'myself' });
        const friend = await createTestUser({ username: 'friend' });
        const dm = await directRoom(me._id, friend._id);
        await Message.create({ roomId: dm, userId: friend._id, text: 'unread' });

        await registerPushToken({ userId: me._id.toString(), token: 'token-1', platform: 'ios' });
        let stored = await PushToken.findOne({ userId: me._id }).lean();
        assert.equal(stored?.token, 'token-1');
        assert.equal(stored?.isActive, true);
        assert.equal(stored?.badge, false);

        await registerPushToken({ userId: me._id.toString(), token: 'token-1', platform: 'ios', badge: true });
        stored = await PushToken.findOne({ userId: me._id }).lean();
        assert.equal(stored?.badge, true);

        // An app build without badge support signs in to the account next.
        await registerPushToken({ userId: me._id.toString(), token: 'token-2', platform: 'ios' });
        stored = await PushToken.findOne({ userId: me._id }).lean();
        assert.equal(stored?.token, 'token-2');
        assert.equal(stored?.badge, false);

        const sent = recordPushes();
        await sendPushNotifications(pushTo([me._id.toString()]));
        assert.deepEqual(pushFor(sent, 'token-2').apns, SOUND_ONLY_APNS);
    });

    it('still sends the push, without a badge, when the count fails', async (t) => {
        const me = await createTestUser({ username: 'myself' });
        await registerPushToken({ userId: me._id.toString(), token: 'token-me', platform: 'ios', badge: true });
        t.mock.method(NotificationService, 'countUnread', async () => {
            throw new Error('database unavailable');
        });

        const sent = recordPushes();
        await sendPushNotifications(pushTo([me._id.toString()]));

        assert.deepEqual(pushFor(sent, 'token-me').apns, SOUND_ONLY_APNS);
        const stored = await PushToken.findOne({ userId: me._id }).lean();
        assert.ok(stored?.lastSuccessAt);
    });

    it('switches off only the given account\'s pushes', async () => {
        const leaving = await createTestUser();
        const staying = await createTestUser();
        await PushToken.create([
            { userId: leaving._id, token: 'token-leaving', platform: 'ios', isActive: true },
            { userId: staying._id, token: 'token-staying', platform: 'android', isActive: true },
        ]);

        await deactivatePushTokensForUser(leaving._id.toString(), 'logged_out');

        const left = await PushToken.findOne({ userId: leaving._id }).lean();
        assert.equal(left?.isActive, false);
        assert.equal(left?.failureReason, 'logged_out');
        assert.ok(left?.lastFailureAt);
        const stayed = await PushToken.findOne({ userId: staying._id }).lean();
        assert.equal(stayed?.isActive, true);

        const sent = recordPushes();
        await sendPushNotifications(pushTo([leaving._id.toString(), staying._id.toString()]));
        assert.deepEqual(sent.map(tokenOf), ['token-staying']);
    });
});
