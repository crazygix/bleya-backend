import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import mongoose from 'mongoose';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser, getAuthToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { createHttpServer } from '../../server/server.js';
import { Room } from '../../models/Room.js';
import { User } from '../../models/User.js';
import { PushToken } from '../../models/PushToken.js';
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

    async function startServer(): Promise<void> {
        ({ server } = createHttpServer({ withSocketIO: true }));
        await new Promise<void>((resolve) => server.listen(0, resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
});
