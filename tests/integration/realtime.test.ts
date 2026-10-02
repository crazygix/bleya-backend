import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import mongoose from 'mongoose';
import type { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser, getAuthToken } from '../helpers/auth.js';
import { emitAndWait } from '../helpers/socketClient.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { createHttpServer } from '../../server/server.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { PushToken } from '../../models/PushToken.js';
import { deleteMessage, removeUserMessages } from '../../services/moderationService.js';
import {
    resetPushMessagingForTests,
    sendPushNotifications,
    setPushMessagingForTests,
} from '../../services/pushNotificationService.js';

interface Ack {
    ok: boolean;
    message?: { text: string };
    error?: { code: string; message: string };
}

interface MessageRemovedEvent {
    messageId: string;
    roomId: string;
    parentMessageId: string | null;
    userId: string;
    createdAt: number;
}

function connect(baseUrl: string, token: string): Promise<ClientSocket> {
    const socket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        auth: { token },
        forceNew: true,
        reconnection: false,
    });

    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', (error) => {
            socket.close();
            reject(error);
        });
    });
}

function sendWithAck(socket: ClientSocket, payload: Record<string, unknown>): Promise<Ack> {
    return socket.timeout(3000).emitWithAck('send_message', payload) as Promise<Ack>;
}

describe('Realtime', () => {
    let server: http.Server;
    let baseUrl: string;

    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        resetPushMessagingForTests();
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetPushMessagingForTests();
    });

    async function startServer(): Promise<SocketIOServer> {
        const created = createHttpServer({ withSocketIO: true });
        assert.ok(created.io);
        server = created.server;
        await new Promise<void>((resolve) => server.listen(0, resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        return created.io;
    }

    async function stopServer(): Promise<void> {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    it('acknowledges send_message and asks the app to rejoin when not in a room', async () => {
        await startServer();
        const room = await Room.create({ name: 'General', type: 'public' });
        const user = await createTestUser({ username: 'talker', joinedRooms: [room._id as mongoose.Types.ObjectId] });
        const socket = await connect(baseUrl, getAuthToken(user._id.toString()));

        try {
            const errors: Array<{ error: { code: string; message: string } }> = [];
            socket.on('error', (payload) => errors.push(payload));

            const rejected = await sendWithAck(socket, { text: 'too early' });
            assert.equal(rejected.ok, false);
            assert.equal(rejected.error?.code, 'NOT_IN_ROOM');
            // The app auto-rejoins on this phrase.
            assert.match(errors[0].error.message, /Not in a room/);

            await new Promise<void>((resolve) => {
                socket.once('room_joined', () => resolve());
                socket.emit('join_room', { roomId: room._id.toString() });
            });

            const accepted = await sendWithAck(socket, { text: "it's here & now" });
            assert.equal(accepted.ok, true);
            assert.equal(accepted.message?.text, "it's here & now");
        } finally {
            socket.disconnect();
            await stopServer();
        }
    });

    it('refuses a deleted account whose token has not expired yet', async () => {
        await startServer();
        const token = getAuthToken(new mongoose.Types.ObjectId().toString());

        try {
            await assert.rejects(connect(baseUrl, token), /Authentication error: Account not found/);
        } finally {
            await stopServer();
        }
    });

    // The app signs out on the "Account blocked: " prefix and shows the rest,
    // which is the same sentence sign-in and refresh use.
    it('explains a suspension when refusing the connection', async () => {
        await startServer();
        const user = await createTestUser({ username: 'paused' });
        await User.updateOne({ _id: user._id }, {
            status: 'suspended',
            suspendedUntil: new Date('2999-01-02T00:00:00Z'),
            enforcementReason: 'Spam',
        });

        try {
            await assert.rejects(connect(baseUrl, getAuthToken(user._id.toString())), {
                message: 'Account blocked: Your account is suspended until 2999-01-02. Reason: Spam',
            });
        } finally {
            await stopServer();
        }
    });

    it('explains a ban without a reason when refusing the connection', async () => {
        await startServer();
        const user = await createTestUser({ username: 'banned' });
        await User.updateOne({ _id: user._id }, { status: 'banned' });

        try {
            await assert.rejects(connect(baseUrl, getAuthToken(user._id.toString())), {
                message: 'Account blocked: Your account has been banned.',
            });
        } finally {
            await stopServer();
        }
    });

    it('sends pushes to large rooms in batches of at most 500', async () => {
        const batchSizes: number[] = [];
        setPushMessagingForTests({
            sendEach: async (messages) => {
                batchSizes.push(messages.length);
                return { responses: messages.map(() => ({ success: true })) };
            },
        });

        const recipients = Array.from({ length: 1201 }, () => new mongoose.Types.ObjectId());
        await PushToken.insertMany(recipients.map((userId, index) => ({
            userId,
            token: `token-${index}`,
            platform: 'android',
            isActive: true,
        })));

        await sendPushNotifications({
            type: 'message',
            recipients: recipients.map((userId) => ({ userId: userId.toString() })),
            roomId: new mongoose.Types.ObjectId().toString(),
            roomName: 'Big room',
            roomType: 'public',
            messageId: new mongoose.Types.ObjectId().toString(),
            senderId: new mongoose.Types.ObjectId().toString(),
            senderUsername: 'sender',
            messageText: 'hello everyone',
        });

        assert.deepEqual(batchSizes, [500, 500, 201]);
        assert.equal(await PushToken.countDocuments({ lastSuccessAt: { $ne: null } }), 1201);
    });

    describe('moderator removals', () => {
        let io: SocketIOServer;
        const clients: ClientSocket[] = [];

        beforeEach(async () => {
            io = await startServer();
        });

        afterEach(async () => {
            for (const client of clients.splice(0)) {
                client.disconnect();
            }
            await stopServer();
        });

        // Connects a user and records every message_removed their socket gets.
        async function listen(userId: mongoose.Types.ObjectId): Promise<{
            socket: ClientSocket;
            removals: MessageRemovedEvent[];
        }> {
            const socket = await connect(baseUrl, getAuthToken(userId.toString()));
            clients.push(socket);
            const removals: MessageRemovedEvent[] = [];
            socket.on('message_removed', (payload: MessageRemovedEvent) => removals.push(payload));
            return { socket, removals };
        }

        // Each socket receives events in the order they were sent, so once this
        // marker has reached every client, so has every removal sent before it,
        // duplicates included.
        async function flush(): Promise<void> {
            const arrived = clients.map((client) => new Promise<void>((resolve) => {
                client.once('test_flush', () => resolve());
            }));
            io.emit('test_flush');
            await Promise.all(arrived);
        }

        function messageIds(removals: MessageRemovedEvent[]): string[] {
            return removals.map((removal) => removal.messageId).sort();
        }

        it('sends a removed top-level message to its room, its members and Activity, once to each socket', async () => {
            const room = await Room.create({ name: 'General', type: 'public' });
            const roomId = room._id as mongoose.Types.ObjectId;
            const author = await createTestUser({ username: 'author', joinedRooms: [roomId] });
            const reader = await createTestUser({ username: 'reader', joinedRooms: [roomId] });
            const member = await createTestUser({ username: 'member', joinedRooms: [roomId] });
            // Left the room after replying, but the thread is still in their Activity.
            const former = await createTestUser({ username: 'former' });
            const outsider = await createTestUser({ username: 'outsider' });

            const root = await Message.create({ roomId, userId: author._id, text: 'root' });
            const reply = await Message.create({ roomId, userId: former._id, text: 'reply', parentMessageId: root._id });
            const laterReply = await Message.create({ roomId, userId: author._id, text: 'later', parentMessageId: root._id });
            await Notification.create([
                { recipient: reader._id, sender: former._id, type: 'reply', room: roomId, message: reply._id, thread: root._id },
                { recipient: former._id, sender: author._id, type: 'reply', room: roomId, message: laterReply._id, thread: root._id },
            ]);

            // The reader is in the room, a member and an Activity recipient at once.
            const inRoom = await listen(reader._id);
            await emitAndWait(inRoom.socket, 'join_room', { roomId: roomId.toString() });
            const onChatList = await listen(member._id);
            const inActivity = await listen(former._id);
            const elsewhere = await listen(outsider._id);

            await deleteMessage(root._id.toString(), 'admin:test', 'spam');
            await flush();

            const removed: MessageRemovedEvent = {
                messageId: root._id.toString(),
                roomId: roomId.toString(),
                parentMessageId: null,
                userId: author._id.toString(),
                createdAt: root.createdAt.getTime(),
            };
            assert.deepEqual(inRoom.removals, [removed]);
            assert.deepEqual(onChatList.removals, [removed]);
            assert.deepEqual(inActivity.removals, [removed]);
            assert.deepEqual(elsewhere.removals, []);
        });

        it('sends a removed reply only to its room and the Activity it was in', async () => {
            const room = await Room.create({ name: 'General', type: 'public' });
            const roomId = room._id as mongoose.Types.ObjectId;
            const author = await createTestUser({ username: 'author', joinedRooms: [roomId] });
            const replier = await createTestUser({ username: 'replier', joinedRooms: [roomId] });
            const reader = await createTestUser({ username: 'reader', joinedRooms: [roomId] });
            const member = await createTestUser({ username: 'member', joinedRooms: [roomId] });

            const root = await Message.create({ roomId, userId: author._id, text: 'root', replyCount: 1 });
            const reply = await Message.create({ roomId, userId: replier._id, text: 'reply', parentMessageId: root._id });
            await Notification.create({
                recipient: author._id, sender: replier._id, type: 'reply', room: roomId, message: reply._id, thread: root._id,
            });

            const inRoom = await listen(reader._id);
            await emitAndWait(inRoom.socket, 'join_room', { roomId: roomId.toString() });
            const inActivity = await listen(author._id);
            const onChatList = await listen(member._id);

            await deleteMessage(reply._id.toString(), 'admin:test');
            await flush();

            const removed: MessageRemovedEvent = {
                messageId: reply._id.toString(),
                roomId: roomId.toString(),
                parentMessageId: root._id.toString(),
                userId: replier._id.toString(),
                createdAt: reply.createdAt.getTime(),
            };
            assert.deepEqual(inRoom.removals, [removed]);
            assert.deepEqual(inActivity.removals, [removed]);
            assert.deepEqual(onChatList.removals, []);
        });

        it('sends one event per message when removing all of a user\'s messages', async () => {
            const room = await Room.create({ name: 'General', type: 'public' });
            const roomId = room._id as mongoose.Types.ObjectId;
            const spammer = await createTestUser({ username: 'spammer', joinedRooms: [roomId] });
            const author = await createTestUser({ username: 'author', joinedRooms: [roomId] });
            const reader = await createTestUser({ username: 'reader', joinedRooms: [roomId] });
            const member = await createTestUser({ username: 'member', joinedRooms: [roomId] });
            const friend = await createTestUser({ username: 'friend' });
            const directRoom = await Room.create({
                name: 'Direct Room',
                type: 'private',
                participants: [spammer._id, friend._id],
                participantsHash: [spammer._id.toString(), friend._id.toString()].sort().join('_'),
            });

            const root = await Message.create({ roomId, userId: author._id, text: 'root' });
            const [spam1, spam2] = await Message.create([
                { roomId, userId: spammer._id, text: 'spam 1' },
                { roomId, userId: spammer._id, text: 'spam 2' },
            ]);
            const spamReply = await Message.create({
                roomId, userId: spammer._id, text: 'spam reply', parentMessageId: root._id,
            });
            const spamDirect = await Message.create({ roomId: directRoom._id, userId: spammer._id, text: 'spam dm' });
            await Notification.create({
                recipient: author._id, sender: spammer._id, type: 'reply', room: roomId, message: spamReply._id, thread: root._id,
            });

            const inRoom = await listen(reader._id);
            await emitAndWait(inRoom.socket, 'join_room', { roomId: roomId.toString() });
            const onChatList = await listen(member._id);
            const inActivity = await listen(author._id);
            const directPartner = await listen(friend._id);

            const result = await removeUserMessages(spammer._id.toString(), 'admin:test', 'spam');
            assert.equal(result.removed, 4);
            await flush();

            const [spam1Id, spam2Id, spamReplyId] = [spam1, spam2, spamReply].map((message) => message._id.toString());
            // The room's sockets get every removal in it, members outside the
            // room the top-level ones, and Activity the reply it showed.
            assert.deepEqual(messageIds(inRoom.removals), [spam1Id, spam2Id, spamReplyId].sort());
            assert.deepEqual(messageIds(onChatList.removals), [spam1Id, spam2Id].sort());
            assert.deepEqual(messageIds(inActivity.removals), [spam1Id, spam2Id, spamReplyId].sort());
            assert.deepEqual(directPartner.removals, [{
                messageId: spamDirect._id.toString(),
                roomId: directRoom._id.toString(),
                parentMessageId: null,
                userId: spammer._id.toString(),
                createdAt: spamDirect.createdAt.getTime(),
            }]);
        });
    });
});
