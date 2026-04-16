import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser, getAuthToken } from '../helpers/auth.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { createHttpServer } from '../../server/server.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { PushToken } from '../../models/PushToken.js';
import {
    resetPushMessagingForTests,
    setPushMessagingForTests,
} from '../../services/pushNotificationService.js';

interface RecordedPushMessage {
    token?: string;
    notification?: {
        title?: string;
        body?: string;
    };
    data?: Record<string, string>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function connectSocket(baseUrl: string, userId: string): Promise<ClientSocket> {
    const socket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        auth: {
            token: getAuthToken(userId),
        },
        forceNew: true,
        reconnection: false,
    });

    await waitFor(() => socket.connected);
    return socket;
}

function emitAndWait(socket: ClientSocket, event: string, payload: Record<string, unknown>): Promise<void> {
    socket.emit(event, payload);
    return new Promise((resolve) => setTimeout(resolve, 100));
}

describe('Socket push integration', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        stopRateLimiterCleanupForTests();
        resetPushMessagingForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetPushMessagingForTests();
    });

    it('sends top-level public message push only to users not active in the room', async () => {
        const pushes: RecordedPushMessage[] = [];
        setPushMessagingForTests({
            sendEach: async (messages) => {
                pushes.push(...messages);
                return {
                    successCount: messages.length,
                    failureCount: 0,
                    responses: messages.map(() => ({ success: true })),
                };
            },
        });

        const room = await Room.create({ name: 'General', type: 'public' });
        const roomId = room._id as mongoose.Types.ObjectId;
        const sender = await createTestUser({ username: 'sender_public', joinedRooms: [roomId] });
        const activeRecipient = await createTestUser({ username: 'active_public', joinedRooms: [roomId] });
        const offlineRecipient = await createTestUser({ username: 'offline_public', joinedRooms: [roomId] });

        await PushToken.create([
            { userId: activeRecipient._id, token: 'token-active', platform: 'ios', isActive: true },
            { userId: offlineRecipient._id, token: 'token-offline', platform: 'android', isActive: true },
        ]);

        const { server } = createHttpServer({ withSocketIO: true });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const senderSocket = await connectSocket(baseUrl, sender._id.toString());
        const activeSocket = await connectSocket(baseUrl, activeRecipient._id.toString());

        try {
            await emitAndWait(senderSocket, 'join_room', { roomId: roomId.toString() });
            await emitAndWait(activeSocket, 'join_room', { roomId: roomId.toString() });

            senderSocket.emit('send_message', { text: 'Hello everyone' });

            await waitFor(() => pushes.length === 1);
            assert.equal(pushes[0].token, 'token-offline');
            assert.equal(pushes[0].data?.type, 'message');
            assert.equal(pushes[0].data?.roomId, roomId.toString());
        } finally {
            senderSocket.disconnect();
            activeSocket.disconnect();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it('sends top-level private message push to the other participant', async () => {
        const pushes: RecordedPushMessage[] = [];
        setPushMessagingForTests({
            sendEach: async (messages) => {
                pushes.push(...messages);
                return {
                    successCount: messages.length,
                    failureCount: 0,
                    responses: messages.map(() => ({ success: true })),
                };
            },
        });

        const sender = await createTestUser({ username: 'alice' });
        const recipient = await createTestUser({ username: 'bob' });
        const room = await Room.create({
            name: 'Direct Room',
            type: 'private',
            participants: [sender._id, recipient._id],
            participantsHash: [sender._id.toString(), recipient._id.toString()].sort().join('_'),
        });

        await PushToken.create({
            userId: recipient._id,
            token: 'token-dm',
            platform: 'ios',
            isActive: true,
        });

        const { server } = createHttpServer({ withSocketIO: true });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const senderSocket = await connectSocket(baseUrl, sender._id.toString());

        try {
            await emitAndWait(senderSocket, 'join_room', { roomId: room._id.toString() });
            senderSocket.emit('send_message', { text: 'Hey there' });

            await waitFor(() => pushes.length === 1);
            assert.equal(pushes[0].token, 'token-dm');
            assert.equal(pushes[0].notification?.title, 'alice');
        } finally {
            senderSocket.disconnect();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it('skips reply push and alert for users active in the exact thread', async () => {
        const pushes: RecordedPushMessage[] = [];
        setPushMessagingForTests({
            sendEach: async (messages) => {
                pushes.push(...messages);
                return {
                    successCount: messages.length,
                    failureCount: 0,
                    responses: messages.map(() => ({ success: true })),
                };
            },
        });

        const room = await Room.create({ name: 'Threads', type: 'public' });
        const roomId = room._id as mongoose.Types.ObjectId;
        const sender = await createTestUser({ username: 'sender', joinedRooms: [roomId] });
        const activeThreadUser = await createTestUser({ username: 'threaduser', joinedRooms: [roomId] });
        const roomOnlyUser = await createTestUser({ username: 'roomuser', joinedRooms: [roomId] });
        const uninvolvedUser = await createTestUser({ username: 'uninvolved', joinedRooms: [roomId] });

        const parentMessage = await Message.create({
            roomId,
            userId: activeThreadUser._id,
            text: 'Parent message',
            parentMessageId: null,
        });
        await Message.create({
            roomId,
            userId: roomOnlyUser._id,
            text: 'Previous reply',
            parentMessageId: parentMessage._id,
        });

        await PushToken.create([
            { userId: activeThreadUser._id, token: 'token-thread', platform: 'ios', isActive: true },
            { userId: roomOnlyUser._id, token: 'token-room', platform: 'android', isActive: true },
            { userId: uninvolvedUser._id, token: 'token-uninvolved', platform: 'ios', isActive: true },
        ]);

        const { server } = createHttpServer({ withSocketIO: true });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const senderSocket = await connectSocket(baseUrl, sender._id.toString());
        const activeThreadSocket = await connectSocket(baseUrl, activeThreadUser._id.toString());
        const roomOnlySocket = await connectSocket(baseUrl, roomOnlyUser._id.toString());

        let roomOnlyNotificationCount = 0;
        roomOnlySocket.on('new_notification', () => {
            roomOnlyNotificationCount += 1;
        });

        try {
            await emitAndWait(senderSocket, 'join_room', { roomId: roomId.toString() });
            await emitAndWait(activeThreadSocket, 'join_room', { roomId: roomId.toString() });
            await emitAndWait(roomOnlySocket, 'join_room', { roomId: roomId.toString() });
            await emitAndWait(activeThreadSocket, 'open_thread', { threadId: parentMessage._id.toString() });

            senderSocket.emit('send_message', {
                text: 'Fresh reply',
                parentMessageId: parentMessage._id.toString(),
            });

            await waitFor(() => pushes.length === 1);
            await waitFor(() => roomOnlyNotificationCount === 1);

            assert.equal(pushes[0].token, 'token-room');
            assert.equal(pushes[0].data?.type, 'reply');
            assert.equal(pushes[0].data?.threadId, parentMessage._id.toString());

            const activeThreadAlerts = await Notification.countDocuments({ recipient: activeThreadUser._id });
            const roomOnlyAlerts = await Notification.countDocuments({ recipient: roomOnlyUser._id });
            const uninvolvedAlerts = await Notification.countDocuments({ recipient: uninvolvedUser._id });

            assert.equal(activeThreadAlerts, 0);
            assert.equal(roomOnlyAlerts, 1);
            assert.equal(uninvolvedAlerts, 0);
        } finally {
            senderSocket.disconnect();
            activeThreadSocket.disconnect();
            roomOnlySocket.disconnect();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });

    it('returns validation errors for malformed thread and message socket payloads', async () => {
        const room = await Room.create({ name: 'Validation', type: 'public' });
        const roomId = room._id as mongoose.Types.ObjectId;
        const user = await createTestUser({ username: 'validator', joinedRooms: [roomId] });

        const { server } = createHttpServer({ withSocketIO: true });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const socket = await connectSocket(baseUrl, user._id.toString());
        const errors: Array<{ error?: { code?: string; message?: string } }> = [];

        socket.on('error', (payload) => {
            errors.push(payload as { error?: { code?: string; message?: string } });
        });

        try {
            await emitAndWait(socket, 'join_room', { roomId: roomId.toString() });
            socket.emit('open_thread', null);
            socket.emit('send_message', null);

            await waitFor(() => errors.length === 2);

            assert.deepEqual(errors.map((payload) => payload.error?.code), [
                'VALIDATION_ERROR',
                'VALIDATION_ERROR',
            ]);
            assert.deepEqual(errors.map((payload) => payload.error?.message), [
                'open_thread payload must be an object',
                'send_message payload must be an object',
            ]);
        } finally {
            socket.disconnect();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    });
});
