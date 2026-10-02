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

// `count` unread Activity items for `recipient`, all for one reply from `sender`.
async function unreadReplyNotifications(
    recipient: mongoose.Types.ObjectId,
    sender: mongoose.Types.ObjectId,
    roomId: mongoose.Types.ObjectId,
    count: number
): Promise<void> {
    const thread = await Message.create({ roomId, userId: recipient, text: 'thread' });
    const reply = await Message.create({ roomId, userId: sender, text: 'reply', parentMessageId: thread._id });
    await Notification.insertMany(Array.from({ length: count }, () => ({
        recipient,
        sender,
        type: 'reply',
        room: roomId,
        message: reply._id,
        thread: thread._id,
    })));
}

async function markRoomRead(
    userId: mongoose.Types.ObjectId,
    roomId: mongoose.Types.ObjectId,
    lastReadAt: Date
): Promise<void> {
    await User.updateOne({ _id: userId }, { $push: { roomReadPointers: { roomId, lastReadAt } } });
}

// The database operations `run` makes, as sorted `collection.method` entries.
async function recordQueries(run: () => Promise<void>): Promise<string[]> {
    const queries: string[] = [];
    mongoose.set('debug', (collectionName: string, methodName: string) => {
        queries.push(`${collectionName}.${methodName}`);
    });
    try {
        await run();
    } finally {
        mongoose.set('debug', false);
    }
    return queries.sort();
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

    it('gives every recipient of one push the badge they would get if pushed alone', async () => {
        const now = Date.now();
        const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);
        const [ana, ben, cleo, dan, eve, finn, troll, stalker] = await Promise.all(
            ['ana', 'ben', 'cleo', 'dan', 'eve', 'finn', 'troll', 'stalker'].map((username) => createTestUser({ username }))
        );

        // Blocks in both directions, and one between two recipients of the push.
        await UserBlock.create([
            { blockerUserId: ana._id, blockedUserId: troll._id },
            { blockerUserId: stalker._id, blockedUserId: ben._id },
            { blockerUserId: cleo._id, blockedUserId: ben._id },
        ]);

        // Activity. A block only hides the blocked pair's items: troll's replies
        // still count for cleo.
        const city = await publicRoom(ana._id, ben._id, cleo._id, dan._id, eve._id, finn._id, troll._id, stalker._id);
        await replyNotification(ana._id, ben._id, city);
        await replyNotification(ana._id, ben._id, city);
        await replyNotification(ana._id, ben._id, city, { read: true });
        await replyNotification(ana._id, troll._id, city);
        await replyNotification(ben._id, ana._id, city);
        await replyNotification(ben._id, ana._id, city, { isDismissed: true });
        await replyNotification(ben._id, stalker._id, city);
        await replyNotification(ben._id, cleo._id, city);
        await replyNotification(cleo._id, troll._id, city);
        await replyNotification(cleo._id, troll._id, city);
        await replyNotification(cleo._id, ben._id, city);
        await replyNotification(cleo._id, ana._id, city, { replyRemoved: true });
        await unreadReplyNotifications(dan._id, ana._id, city, 120);
        await replyNotification(eve._id, ana._id, city);
        await replyNotification(finn._id, ana._id, city);
        await Message.create([
            { roomId: city, userId: troll._id, text: 'city news' },
            { roomId: city, userId: eve._id, text: 'more city news' },
        ]);

        // ana and ben are both pushed. Each has read up to a different point,
        // and neither one's own message counts for them: ben's message is
        // unread for ana, and ben has read ana's.
        const anaBen = await directRoom(ana._id, ben._id);
        await Message.create([
            { roomId: anaBen, userId: ana._id, text: 'hi ben', createdAt: minutesAgo(30) },
            { roomId: anaBen, userId: ben._id, text: 'hi ana', createdAt: minutesAgo(10) },
        ]);
        await markRoomRead(ana._id, anaBen, minutesAgo(40));
        await markRoomRead(ben._id, anaBen, minutesAgo(20));
        const anaTroll = await directRoom(ana._id, troll._id);
        await Message.create({ roomId: anaTroll, userId: troll._id, text: 'from a blocked user' });
        // ana hid her chat with cleo; cleo still has ana's message unread.
        const anaCleo = await directRoom(ana._id, cleo._id);
        await Message.create([
            { roomId: anaCleo, userId: cleo._id, text: 'hi ana', createdAt: minutesAgo(15) },
            { roomId: anaCleo, userId: ana._id, text: 'hi cleo', createdAt: minutesAgo(14) },
        ]);
        await User.updateOne({ _id: ana._id }, { $addToSet: { hiddenDirectRooms: anaCleo } });
        const benStalker = await directRoom(ben._id, stalker._id);
        await Message.create({ roomId: benStalker, userId: stalker._id, text: 'from someone who blocked ben' });
        const benCleo = await directRoom(ben._id, cleo._id);
        await Message.create([
            { roomId: benCleo, userId: ben._id, text: 'hi cleo' },
            { roomId: benCleo, userId: cleo._id, text: 'hi ben' },
        ]);
        const benEve = await directRoom(ben._id, eve._id);
        await Message.create({ roomId: benEve, userId: eve._id, text: 'hi ben' });
        const cleoFinn = await directRoom(cleo._id, finn._id);
        await Message.create({ roomId: cleoFinn, userId: finn._id, text: 'hi cleo' });

        for (const user of [ana, ben, cleo, dan]) {
            await registerPushToken({ userId: user._id.toString(), token: `token-${user.username}`, platform: 'ios', badge: true });
        }
        await registerPushToken({ userId: eve._id.toString(), token: 'token-eve', platform: 'ios' });
        await registerPushToken({ userId: finn._id.toString(), token: 'token-finn', platform: 'android', badge: true });

        const recipients = [ana, ben, cleo, dan, eve, finn];
        const sent = recordPushes();
        await sendPushNotifications(pushTo(recipients.map((user) => user._id.toString())));

        // ana: 2 Activity items + her DM with ben. ben: 1 + his DM with eve.
        // cleo: 2 + her DMs with ana and finn. dan: 120, capped. eve's build
        // didn't ask for a badge, and finn is on Android.
        const badges = Object.fromEntries(recipients.map((user) => [
            user.username,
            pushFor(sent, `token-${user.username}`).apns?.payload?.aps.badge,
        ]));
        assert.deepEqual(badges, { ana: 3, ben: 2, cleo: 4, dan: 99, eve: undefined, finn: undefined });
        assert.deepEqual(pushFor(sent, 'token-eve').apns, SOUND_ONLY_APNS);
        assert.deepEqual(pushFor(sent, 'token-finn').apns, SOUND_ONLY_APNS);

        for (const user of recipients) {
            const token = `token-${user.username}`;
            const alone = recordPushes();
            await sendPushNotifications(pushTo([user._id.toString()]));
            assert.deepEqual(pushFor(alone, token).apns, pushFor(sent, token).apns, `${user.username} pushed alone`);
        }
    });

    it('counts the badges of a whole push in one set of queries', async () => {
        const friend = await createTestUser({ username: 'friend' });
        const users = await Promise.all(['one', 'two', 'three'].map((username) => createTestUser({ username })));
        const city = await publicRoom(friend._id, ...users.map((user) => user._id));
        for (const user of users) {
            await replyNotification(user._id, friend._id, city);
            const dm = await directRoom(user._id, friend._id);
            await Message.create({ roomId: dm, userId: friend._id, text: 'unread' });
            await registerPushToken({ userId: user._id.toString(), token: `token-${user.username}`, platform: 'ios', badge: true });
        }
        // Recipients with different block pairs still share the queries.
        await UserBlock.create({ blockerUserId: users[0]._id, blockedUserId: users[1]._id });

        recordPushes();
        const forOne = await recordQueries(() => sendPushNotifications(pushTo([users[0]._id.toString()])));
        const sent = recordPushes();
        const forAll = await recordQueries(() => sendPushNotifications(pushTo(users.map((user) => user._id.toString()))));

        // One of each lookup, the same for three recipients as for one.
        assert.deepEqual(
            forOne.filter((query) => !query.startsWith('pushtokens.')),
            ['messages.aggregate', 'notifications.aggregate', 'rooms.find', 'userblocks.find', 'users.find']
        );
        assert.deepEqual(forAll, forOne);
        assert.deepEqual(
            users.map((user) => pushFor(sent, `token-${user.username}`).apns?.payload?.aps.badge),
            [2, 2, 2]
        );
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
        t.mock.method(NotificationService, 'countUnreadByRecipient', async () => {
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
