import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { buildSocketCors } from '../utils/cors.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { ErrorCode } from '../utils/errors.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

interface AuthenticatedSocket {
    userId: string;
    roomId?: string;
}

interface EventRateState {
    count: number;
    resetAt: number;
}

interface SocketDataState {
    user?: AuthenticatedSocket;
    eventRateLimits?: Map<string, EventRateState>;
}

type SocketWithState = Socket & { data: SocketDataState };

interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    description?: string;
    type?: 'public' | 'private';
    participants?: mongoose.Types.ObjectId[];
}

interface LeanMessage {
    _id: mongoose.Types.ObjectId;
    roomId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    text: string;
    createdAt: Date;
    parentMessageId?: mongoose.Types.ObjectId | null;
    replyCount?: number;
}

interface LeanUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
}

interface RoomReadPointer {
    roomId: mongoose.Types.ObjectId;
    lastReadAt: Date;
}

interface LeanSocketUser {
    _id: mongoose.Types.ObjectId;
    joinedRooms: mongoose.Types.ObjectId[];
    roomReadPointers?: RoomReadPointer[];
}

const ROOM_MESSAGES_PAGE_SIZE = 50;
const MAX_PUBLIC_ROOMS = 5;
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

const EVENT_RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
    join_room: { max: 20, windowMs: 60_000 },
    send_message: { max: 60, windowMs: 60_000 },
};

function emitSocketError(socket: SocketWithState, code: ErrorCode, message: string): void {
    socket.emit('error', {
        error: {
            code,
            message,
        },
    });
}

function consumeEventBudget(socket: SocketWithState, eventName: keyof typeof EVENT_RATE_LIMITS): boolean {
    const limits = EVENT_RATE_LIMITS[eventName];
    if (!socket.data.eventRateLimits) {
        socket.data.eventRateLimits = new Map();
    }

    const now = Date.now();
    const existing = socket.data.eventRateLimits.get(eventName);

    if (!existing || existing.resetAt <= now) {
        socket.data.eventRateLimits.set(eventName, {
            count: 1,
            resetAt: now + limits.windowMs,
        });
        return true;
    }

    if (existing.count >= limits.max) {
        return false;
    }

    existing.count += 1;
    socket.data.eventRateLimits.set(eventName, existing);
    return true;
}

function parseSocketToken(socket: Socket): string | null {
    const authToken = socket.handshake.auth.token;
    if (typeof authToken === 'string' && authToken.trim().length > 0) {
        return authToken;
    }

    const authorization = socket.handshake.headers.authorization;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
        return authorization.replace('Bearer ', '');
    }

    return null;
}

function requireObjectId(value: string, fieldName: string): mongoose.Types.ObjectId {
    if (!OBJECT_ID_REGEX.test(value)) {
        throw new Error(`Invalid ${fieldName} format`);
    }

    return new mongoose.Types.ObjectId(value);
}

function getSocketUser(socket: SocketWithState): AuthenticatedSocket {
    const user = socket.data.user;
    if (!user) {
        throw new Error('Socket user not initialized');
    }

    return user;
}

export function setupSocketIO(server: HTTPServer) {
    const io = new SocketIOServer(server, {
        cors: buildSocketCors(),
    });

    io.use((rawSocket, next) => {
        const socket = rawSocket as SocketWithState;
        const token = parseSocketToken(socket);

        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        try {
            const decoded = jwt.verify(token, config.jwtSecret);
            if (typeof decoded !== 'object' || decoded === null) {
                return next(new Error('Authentication error: Invalid token payload'));
            }

            const payload = decoded as { userId?: unknown };
            if (typeof payload.userId !== 'string') {
                return next(new Error('Authentication error: Invalid user ID payload'));
            }

            socket.data.user = { userId: payload.userId };
            socket.data.eventRateLimits = new Map();
            next();
        } catch {
            next(new Error('Authentication error: Invalid token'));
        }
    });

    io.on('connection', (rawSocket) => {
        const socket = rawSocket as SocketWithState;
        const user = getSocketUser(socket);

        logger.info('socket.connected', { userId: user.userId, socketId: socket.id });

        const userRoom = `user:${user.userId}`;
        socket.join(userRoom);

        socket.on('join_room', async (data: { roomId: string }) => {
            if (!consumeEventBudget(socket, 'join_room')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many join requests. Please slow down.');
                return;
            }

            try {
                const roomObjectId = requireObjectId(data.roomId, 'room ID');
                const roomId = roomObjectId.toString();

                const room = await Room.findById(roomObjectId).lean<LeanRoom | null>();
                if (!room) {
                    emitSocketError(socket, ErrorCode.ROOM_NOT_FOUND, 'Room not found');
                    return;
                }

                const userDoc = await User.findById(user.userId)
                    .select('joinedRooms roomReadPointers')
                    .lean<LeanSocketUser | null>();

                if (!userDoc) {
                    emitSocketError(socket, ErrorCode.USER_NOT_FOUND, 'User not found');
                    return;
                }

                const isAlreadyJoined = userDoc.joinedRooms.some((id) => id.equals(roomObjectId));

                if (!isAlreadyJoined) {
                    if ((room.type || 'public') === 'public') {
                        const publicRoomCount = await Room.countDocuments({
                            _id: { $in: userDoc.joinedRooms },
                            type: 'public',
                        });

                        if (publicRoomCount >= MAX_PUBLIC_ROOMS) {
                            emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'You can only join up to 5 group chats at a time');
                            return;
                        }
                    }

                    await User.updateOne(
                        { _id: user.userId, joinedRooms: { $ne: roomObjectId } },
                        { $addToSet: { joinedRooms: roomObjectId } }
                    );
                }

                if (user.roomId) {
                    socket.leave(user.roomId);
                }

                socket.join(roomId);
                user.roomId = roomId;

                const rawMessages = await Message.find({
                    roomId: roomObjectId,
                    parentMessageId: null,
                })
                    .sort({ createdAt: -1, _id: -1 })
                    .limit(ROOM_MESSAGES_PAGE_SIZE + 1)
                    .lean<LeanMessage[]>();

                const hasMore = rawMessages.length > ROOM_MESSAGES_PAGE_SIZE;
                const pageMessages = hasMore
                    ? rawMessages.slice(0, ROOM_MESSAGES_PAGE_SIZE)
                    : rawMessages;

                const userIds = [...new Set(pageMessages.map((msg) => msg.userId.toString()))]
                    .map((id) => new mongoose.Types.ObjectId(id));

                const users = userIds.length > 0
                    ? await User.find({ _id: { $in: userIds } }).select('_id username').lean<LeanUser[]>()
                    : [];

                const usernameMap = new Map(users.map((u) => [u._id.toString(), u.username || '']));

                const formattedMessages = pageMessages.reverse().map((msg) => ({
                    id: msg._id.toString(),
                    roomId: msg.roomId.toString(),
                    userId: msg.userId.toString(),
                    username: usernameMap.get(msg.userId.toString()) || '',
                    text: msg.text,
                    createdAt: msg.createdAt.getTime(),
                    parentMessageId: msg.parentMessageId?.toString() || null,
                    replyCount: msg.replyCount || 0,
                }));

                const nextCursor = formattedMessages.length > 0
                    ? formattedMessages[0].createdAt + 1
                    : null;

                let lastReadAt: number | null = null;
                for (const pointer of userDoc.roomReadPointers || []) {
                    if (!pointer.lastReadAt || pointer.roomId.toString() !== roomId) {
                        continue;
                    }

                    const pointerTime = pointer.lastReadAt.getTime();
                    if (lastReadAt === null || pointerTime > lastReadAt) {
                        lastReadAt = pointerTime;
                    }
                }

                let roomName = room.name;
                let otherUserId: string | null = null;

                if ((room.type || 'public') === 'private' && room.participants) {
                    const otherParticipant = room.participants.find((id) => id.toString() !== user.userId);
                    if (otherParticipant) {
                        const otherParticipantId = otherParticipant.toString();
                        const otherUser = await User.findById(otherParticipantId)
                            .select('username')
                            .lean<LeanUser | null>();

                        roomName = otherUser?.username || 'Unknown User';
                        otherUserId = otherParticipantId;
                    }
                }

                socket.emit('room_joined', {
                    room: {
                        id: room._id.toString(),
                        name: roomName,
                        description: room.description,
                        type: room.type || 'public',
                        participants: (room.participants || []).map((participant) => participant.toString()),
                        otherUserId,
                    },
                    messages: formattedMessages,
                    pagination: {
                        hasMore,
                        nextCursor,
                    },
                    lastReadAt,
                });

                socket.to(roomId).emit('user_joined', { userId: user.userId });
                logger.info('socket.room_joined', { userId: user.userId, roomId });
            } catch (error) {
                logger.error('socket.join_room.failed', {
                    userId: user.userId,
                    error: error instanceof Error ? error.message : String(error),
                });
                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, 'Failed to join room');
            }
        });

        socket.on('send_message', async (data: { text: string; parentMessageId?: string }) => {
            if (!consumeEventBudget(socket, 'send_message')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many messages. Please slow down.');
                return;
            }

            try {
                if (!user.roomId) {
                    emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Not in a room');
                    return;
                }

                const roomObjectId = requireObjectId(user.roomId, 'room ID');
                const senderObjectId = requireObjectId(user.userId, 'user ID');

                const sanitizedText = sanitizePlainText(data.text || '', {
                    maxLength: 2000,
                    collapseWhitespace: true,
                    escapeHtml: true,
                });

                if (!sanitizedText || sanitizedText.trim().length === 0) {
                    emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Message cannot be empty');
                    return;
                }

                let parentObjectId: mongoose.Types.ObjectId | null = null;
                if (data.parentMessageId) {
                    if (!OBJECT_ID_REGEX.test(data.parentMessageId)) {
                        emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Invalid parent message ID format');
                        return;
                    }

                    parentObjectId = new mongoose.Types.ObjectId(data.parentMessageId);
                    const parentMessage = await Message.findById(parentObjectId).lean<LeanMessage | null>();

                    if (!parentMessage) {
                        emitSocketError(socket, ErrorCode.NOT_FOUND, 'Parent message not found');
                        return;
                    }

                    if (parentMessage.roomId.toString() !== user.roomId) {
                        emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Parent message not in this room');
                        return;
                    }
                }

                const message = new Message({
                    roomId: roomObjectId,
                    userId: senderObjectId,
                    text: sanitizedText,
                    parentMessageId: parentObjectId,
                });

                await message.save();

                if (parentObjectId) {
                    await Message.updateOne(
                        { _id: parentObjectId },
                        { $inc: { replyCount: 1 } }
                    );
                }

                const senderUser = await User.findById(senderObjectId).select('username').lean<LeanUser | null>();
                const username = senderUser?.username || '';

                const messageData = {
                    id: message._id.toString(),
                    roomId: message.roomId.toString(),
                    userId: message.userId.toString(),
                    username,
                    text: message.text,
                    createdAt: message.createdAt.getTime(),
                    parentMessageId: message.parentMessageId?.toString() || null,
                    replyCount: message.replyCount,
                };

                io.to(user.roomId).emit('new_message', messageData);

                const summaryPayload = {
                    roomId: messageData.roomId,
                    lastMessageText: messageData.text,
                    lastMessageTime: messageData.createdAt,
                    lastMessageUserId: messageData.userId,
                    lastMessageUsername: messageData.username,
                };

                const memberUsers = await User.find({ joinedRooms: roomObjectId })
                    .select('_id')
                    .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

                for (const member of memberUsers) {
                    io.to(`user:${member._id.toString()}`).emit('room_summary_updated', summaryPayload);
                }

                logger.info('socket.message_sent', {
                    userId: user.userId,
                    roomId: user.roomId,
                    parentMessageId: parentObjectId?.toString() || null,
                });
            } catch (error) {
                logger.error('socket.send_message.failed', {
                    userId: user.userId,
                    roomId: user.roomId,
                    error: error instanceof Error ? error.message : String(error),
                });
                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, 'Failed to send message');
            }
        });

        socket.on('leave_room', async () => {
            if (!user.roomId) {
                return;
            }

            const roomId = user.roomId;
            user.roomId = undefined;

            socket.to(roomId).emit('user_left', { userId: user.userId });
            socket.leave(roomId);

            const room = await Room.findById(roomId).select('name').lean<{ name?: string } | null>();
            logger.info('socket.room_left', {
                userId: user.userId,
                roomId,
                roomName: room?.name,
            });
        });

        socket.on('disconnect', () => {
            if (user.roomId) {
                socket.to(user.roomId).emit('user_left', { userId: user.userId });
            }

            logger.info('socket.disconnected', { userId: user.userId, socketId: socket.id });
        });
    });

    return io;
}
