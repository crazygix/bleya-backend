import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import type { Server as SocketIOServer, Socket as ServerSocket } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { createTestUser } from '../helpers/auth.js';
import { connectSocket, emitAndWait, waitFor } from '../helpers/socketClient.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { createHttpServer } from '../../server/server.js';
import { Room } from '../../models/Room.js';
import { Message } from '../../models/Message.js';
import { Notification } from '../../models/Notification.js';
import { PushToken } from '../../models/PushToken.js';
import { User } from '../../models/User.js';
import { buildRoomJoinView, RoomJoinSupersededError } from '../../services/roomService.js';
import {
    resetPushMessagingForTests,
    setPushMessagingForTests,
} from '../../services/pushNotificationService.js';

interface Ack {
    ok: boolean;
    superseded?: boolean;
    message?: { roomId: string; text: string };
    error?: { code: string; message: string };
}

interface SocketErrorPayload {
    error: { code: string; message: string };
}

const NOT_IN_ROOM = {
    ok: false,
    error: { code: 'NOT_IN_ROOM', message: 'Not in a room. Reopen the chat and try again.' },
};

function emitWithAck(socket: ClientSocket, event: string, payload: Record<string, unknown>): Promise<Ack> {
    return socket.timeout(3000).emitWithAck(event, payload) as Promise<Ack>;
}

// Takes over the server's handler for the next `event` from `client`: runs it,
// calls `whileLoading` once it is waiting on the database, and resolves when
// it has finished. Some events have no reply to wait for, and a connection
// that drops mid-request can't receive one.
function interceptNextEvent(
    io: SocketIOServer,
    client: ClientSocket,
    event: string,
    whileLoading: (serverSocket: ServerSocket) => void = () => {}
): Promise<void> {
    const serverSocket = io.of('/').sockets.get(client.id ?? '');
    assert.ok(serverSocket, 'no server-side socket for this client');
    const [handler] = serverSocket.listeners(event) as Array<(...args: unknown[]) => unknown>;
    assert.ok(handler, `no ${event} handler`);
    serverSocket.off(event, handler);

    return new Promise((resolve, reject) => {
        serverSocket.once(event, (...args: unknown[]) => {
            serverSocket.on(event, handler);
            const handled = Promise.resolve(handler(...args));
            whileLoading(serverSocket);
            handled.then(() => resolve(), reject);
        });
    });
}

describe('Socket rooms', () => {
    let server: http.Server;
    let io: SocketIOServer;
    let baseUrl: string;
    let pushedTokens: string[];
    const clients: ClientSocket[] = [];

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

        pushedTokens = [];
        setPushMessagingForTests({
            sendEach: async (messages) => {
                pushedTokens.push(...messages.map((message) => ('token' in message ? message.token : '')));
                return { responses: messages.map(() => ({ success: true })) };
            },
        });

        const created = createHttpServer({ withSocketIO: true });
        assert.ok(created.io);
        server = created.server;
        io = created.io;
        await new Promise<void>((resolve) => server.listen(0, resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) {
            client.disconnect();
        }
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        resetPushMessagingForTests();
    });

    async function connect(userId: mongoose.Types.ObjectId): Promise<ClientSocket> {
        const client = await connectSocket(baseUrl, userId.toString());
        clients.push(client);
        return client;
    }

    async function publicRoom(name: string): Promise<{ id: string; objectId: mongoose.Types.ObjectId }> {
        const room = await Room.create({ name, type: 'public' });
        const objectId = room._id as mongoose.Types.ObjectId;
        return { id: objectId.toString(), objectId };
    }

    it('stores a send only in the room the socket joined', async () => {
        const roomX = await publicRoom('X');
        const roomY = await publicRoom('Y');
        const user = await createTestUser({ username: 'sender', joinedRooms: [roomX.objectId, roomY.objectId] });
        const socket = await connect(user._id);
        const errors: SocketErrorPayload[] = [];
        socket.on('error', (payload: SocketErrorPayload) => errors.push(payload));

        // Before any join, naming a room doesn't help.
        assert.deepEqual(await emitWithAck(socket, 'send_message', { text: 'too early', roomId: roomX.id }), NOT_IN_ROOM);

        await emitAndWait(socket, 'join_room', { roomId: roomX.id });

        assert.deepEqual(await emitWithAck(socket, 'send_message', { text: 'meant for Y', roomId: roomY.id }), NOT_IN_ROOM);
        // The 'error' event still comes too, for apps that don't read the
        // acknowledgement. It is sent before the acknowledgement.
        assert.deepEqual(errors.map((payload) => payload.error.code), ['NOT_IN_ROOM', 'NOT_IN_ROOM']);
        assert.equal(await Message.countDocuments(), 0);

        const invalid = await emitWithAck(socket, 'send_message', { text: 'hello', roomId: 'not-a-room' });
        assert.deepEqual(invalid.error, { code: 'VALIDATION_ERROR', message: "That room ID isn't valid." });

        const matching = await emitWithAck(socket, 'send_message', { text: 'for X', roomId: roomX.id });
        assert.equal(matching.ok, true);
        assert.equal(matching.message?.roomId, roomX.id);

        const withoutRoomId = await emitWithAck(socket, 'send_message', { text: 'no room id' });
        assert.equal(withoutRoomId.ok, true);
        assert.equal(withoutRoomId.message?.roomId, roomX.id);

        const stored = await Message.find().sort({ createdAt: 1, _id: 1 }).lean();
        assert.deepEqual(
            stored.map((message) => [message.text, message.roomId.toString()]),
            [['for X', roomX.id], ['no room id', roomX.id]]
        );
    });

    it('answers a join through its acknowledgement when one is given', async () => {
        const open = await publicRoom('Open');
        const owner = await createTestUser({ username: 'owner' });
        const friend = await createTestUser({ username: 'friend' });
        const user = await createTestUser({ username: 'joiner' });
        const privateRoom = await Room.create({
            name: 'Direct Room',
            type: 'private',
            participants: [owner._id, friend._id],
            participantsHash: [owner._id.toString(), friend._id.toString()].sort().join('_'),
        });
        const socket = await connect(user._id);

        const events: string[] = [];
        const errors: SocketErrorPayload[] = [];
        socket.on('room_joined', (payload: { room: { id: string } }) => events.push(`room_joined ${payload.room.id}`));
        socket.on('error', (payload: SocketErrorPayload) => errors.push(payload));

        // Success: room_joined first, then the acknowledgement.
        const joined = await emitWithAck(socket, 'join_room', { roomId: open.id });
        events.push(`ack ${JSON.stringify(joined)}`);
        assert.deepEqual(events, [`room_joined ${open.id}`, 'ack {"ok":true}']);

        // A refusal goes to the acknowledgement only.
        const refused = await emitWithAck(socket, 'join_room', { roomId: privateRoom._id.toString() });
        assert.deepEqual(refused, {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'You are not allowed to join this chat.' },
        });

        // Without an acknowledgement, the 'error' event as before. Events reach
        // the socket in order, so one for the refusal above would come first.
        socket.emit('join_room', { roomId: new mongoose.Types.ObjectId().toString() });
        await waitFor(() => errors.length > 0);
        assert.deepEqual(errors, [{ error: { code: 'ROOM_NOT_FOUND', message: 'Room not found' } }]);
    });

    it('lets the later of two quick joins decide the room', async () => {
        const roomX = await publicRoom('X');
        const roomY = await publicRoom('Y');
        // X isn't one of the user's rooms yet, and the overtaken join mustn't add it.
        const user = await createTestUser({ username: 'switcher', joinedRooms: [roomY.objectId] });
        const socket = await connect(user._id);
        const joinedRoomIds: string[] = [];
        socket.on('room_joined', (payload: { room: { id: string } }) => joinedRoomIds.push(payload.room.id));

        const [first, second] = await Promise.all([
            emitWithAck(socket, 'join_room', { roomId: roomX.id }),
            emitWithAck(socket, 'join_room', { roomId: roomY.id }),
        ]);

        assert.deepEqual(first, { ok: false, superseded: true });
        assert.deepEqual(second, { ok: true });
        assert.deepEqual(joinedRoomIds, [roomY.id]);

        const sent = await emitWithAck(socket, 'send_message', { text: 'where am I?' });
        assert.equal(sent.ok, true);
        assert.equal(sent.message?.roomId, roomY.id);

        const stored = await User.findById(user._id).select('joinedRooms').lean();
        assert.deepEqual(stored?.joinedRooms.map((roomId) => roomId.toString()), [roomY.id]);
    });

    it('keeps pushes coming when a leave overtakes a join', async () => {
        const room = await publicRoom('Quick');
        const sender = await createTestUser({ username: 'poster', joinedRooms: [room.objectId] });
        const reader = await createTestUser({ username: 'reader', joinedRooms: [room.objectId] });
        await PushToken.create({ userId: reader._id, token: 'token-reader', platform: 'ios', isActive: true });

        const senderSocket = await connect(sender._id);
        const readerSocket = await connect(reader._id);
        await emitAndWait(senderSocket, 'join_room', { roomId: room.id });

        let readerJoins = 0;
        readerSocket.on('room_joined', () => {
            readerJoins += 1;
        });
        const joining = emitWithAck(readerSocket, 'join_room', { roomId: room.id });
        readerSocket.emit('leave_room');

        assert.deepEqual(await joining, { ok: false, superseded: true });
        assert.equal(readerJoins, 0);

        assert.equal((await emitWithAck(senderSocket, 'send_message', { text: 'anyone here?' })).ok, true);
        await waitFor(() => pushedTokens.includes('token-reader'));
    });

    it('keeps pushes coming when the connection drops during a join', async () => {
        const room = await publicRoom('Dropped');
        const sender = await createTestUser({ username: 'poster', joinedRooms: [room.objectId] });
        const reader = await createTestUser({ username: 'reader', joinedRooms: [room.objectId] });
        await PushToken.create({ userId: reader._id, token: 'token-reader', platform: 'android', isActive: true });

        const senderSocket = await connect(sender._id);
        const readerSocket = await connect(reader._id);
        await emitAndWait(senderSocket, 'join_room', { roomId: room.id });

        // The connection ends while the room is still loading, before room_joined.
        const joinFinished = interceptNextEvent(io, readerSocket, 'join_room', (serverSocket) => {
            serverSocket.disconnect(true);
        });
        readerSocket.emit('join_room', { roomId: room.id });
        await joinFinished;

        assert.equal((await emitWithAck(senderSocket, 'send_message', { text: 'still there?' })).ok, true);
        await waitFor(() => pushedTokens.includes('token-reader'));
    });

    it('keeps reply notifications coming when a close overtakes a thread open', async () => {
        const room = await publicRoom('Threads');
        const author = await createTestUser({ username: 'author', joinedRooms: [room.objectId] });
        const replier = await createTestUser({ username: 'replier', joinedRooms: [room.objectId] });
        const parent = await Message.create({ roomId: room.objectId, userId: author._id, text: 'Parent' });

        const authorSocket = await connect(author._id);
        const replierSocket = await connect(replier._id);
        await emitAndWait(authorSocket, 'join_room', { roomId: room.id });
        await emitAndWait(replierSocket, 'join_room', { roomId: room.id });

        let authorNotifications = 0;
        authorSocket.on('new_notification', () => {
            authorNotifications += 1;
        });

        const openFinished = interceptNextEvent(io, authorSocket, 'open_thread');
        authorSocket.emit('open_thread', { threadId: parent._id.toString() });
        authorSocket.emit('close_thread');
        await openFinished;

        const reply = await emitWithAck(replierSocket, 'send_message', {
            text: 'A reply',
            parentMessageId: parent._id.toString(),
        });
        assert.equal(reply.ok, true);

        await waitFor(() => authorNotifications === 1);
        assert.equal(await Notification.countDocuments({ recipient: author._id }), 1);
    });

    it('drops a thread open that a join overtook', async () => {
        const roomX = await publicRoom('X');
        const roomY = await publicRoom('Y');
        const author = await createTestUser({ username: 'author', joinedRooms: [roomY.objectId] });
        const user = await createTestUser({ username: 'reader', joinedRooms: [roomX.objectId, roomY.objectId] });
        const parent = await Message.create({ roomId: roomY.objectId, userId: author._id, text: 'Parent' });

        const socket = await connect(user._id);
        await emitAndWait(socket, 'join_room', { roomId: roomX.id });
        const errors: SocketErrorPayload[] = [];
        socket.on('error', (payload: SocketErrorPayload) => errors.push(payload));

        // The thread in Y is opened while the socket is still in X, and the
        // join for Y arrives while the thread is being looked up.
        const openFinished = interceptNextEvent(io, socket, 'open_thread');
        socket.emit('open_thread', { threadId: parent._id.toString() });
        const joined = emitWithAck(socket, 'join_room', { roomId: roomY.id });
        await openFinished;

        assert.deepEqual(await joined, { ok: true });
        // No "That reply belongs to a different chat." for the overtaken open.
        assert.deepEqual(errors, []);
    });

    it('adds no room for a join that is no longer wanted', async () => {
        const room = await publicRoom('Skipped');
        const user = await createTestUser({ username: 'undecided' });

        await assert.rejects(
            buildRoomJoinView(user._id.toString(), room.objectId, { isStillWanted: () => false }),
            RoomJoinSupersededError
        );

        const stored = await User.findById(user._id).select('joinedRooms').lean();
        assert.deepEqual(stored?.joinedRooms, []);
    });
});
