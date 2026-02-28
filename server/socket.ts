import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import {
    NotificationService,
    PopulatedNotification,
    PopulatedNotificationParticipant,
} from '../services/NotificationService.js';
import { createMessage } from '../services/messageService.js';
import { buildSocketCors } from '../utils/cors.js';
import { ErrorCode, AppError } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { toRoomLocation, isPrivateRoomParticipant } from '../utils/room.js';
import { formatMessage, buildUsernameMap } from '../utils/message.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import type { LeanRoom, LeanMessage, LeanUser, LeanJoinedRoomsUser } from '../types/lean.js';
import type { FormattedMessage } from '../utils/message.js';

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

const ROOM_MESSAGES_PAGE_SIZE = 50;
const MAX_PUBLIC_ROOMS = 5;

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

function getSocketUser(socket: SocketWithState): AuthenticatedSocket {
    const user = socket.data.user;
    if (!user) {
        throw new Error('Socket user not initialized');
    }

    return user;
}

function resolveNotificationRoomName(
    notification: PopulatedNotification,
    targetUserId: string
): string {
    const fallbackName = notification.room.name || 'Unknown Room';
    if (notification.room.type !== 'private' || !notification.room.participants) {
        return fallbackName;
    }

    const otherParticipant = notification.room.participants.find((participant) => {
        if (participant instanceof mongoose.Types.ObjectId) {
            return participant.toString() !== targetUserId;
        }
        return participant._id.toString() !== targetUserId;
    });

    if (!otherParticipant || otherParticipant instanceof mongoose.Types.ObjectId) {
        return fallbackName;
    }

    return (otherParticipant as PopulatedNotificationParticipant).username || fallbackName;
}

async function emitReplyNotifications(
    io: SocketIOServer,
    targets: { notificationId: string }[]
): Promise<void> {
    const notificationIds = targets.map((t) => new mongoose.Types.ObjectId(t.notificationId));
    if (notificationIds.length === 0) return;

    const populatedNotifications = await Notification.find({ _id: { $in: notificationIds } })
        .select('recipient sender type room message thread read isDismissed createdAt updatedAt')
        .populate('sender', 'username profileImageUrl')
        .populate({
            path: 'room',
            select: 'name type participants',
            populate: { path: 'participants', select: 'username' },
        })
        .populate('message', 'text')
        .populate('thread', 'text')
        .lean<PopulatedNotification[]>();

    for (const notification of populatedNotifications) {
        const targetUserId = notification.recipient.toString();
        const roomName = resolveNotificationRoomName(notification, targetUserId);

        io.to(`user:${targetUserId}`).emit('new_notification', {
            id: notification._id.toString(),
            recipient: targetUserId,
            sender: {
                id: notification.sender._id.toString(),
                username: notification.sender.username || 'Unknown',
                profileImageUrl: notification.sender.profileImageUrl || null,
            },
            type: notification.type,
            roomId: notification.room._id.toString(),
            roomName,
            roomType: notification.room.type || 'public',
            messageId: notification.message._id.toString(),
            threadId: notification.thread._id.toString(),
            parentMessageText: notification.thread.text || null,
            replyText: notification.message.text || '',
            previewText: notification.message.text ? notification.message.text.substring(0, 100) : '',
            read: notification.read,
            isDismissed: notification.isDismissed || false,
            createdAt: notification.createdAt.getTime(),
            updatedAt: notification.updatedAt.getTime(),
        });
    }
}

async function emitRoomSummaryUpdate(
    io: SocketIOServer,
    roomId: string,
    messageData: FormattedMessage,
    roomType: 'public' | 'private',
    roomParticipants: string[]
): Promise<void> {
    const summaryPayload = {
        roomId: messageData.roomId,
        lastMessageText: messageData.text,
        lastMessageTime: messageData.createdAt,
        lastMessageUserId: messageData.userId,
        lastMessageUsername: messageData.username,
    };

    if (roomType === 'private') {
        for (const participantId of roomParticipants) {
            io.to(`user:${participantId}`).emit('room_summary_updated', summaryPayload);
        }
    } else {
        const memberUsers = await User.find({ joinedRooms: new mongoose.Types.ObjectId(roomId) })
            .select('_id')
            .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

        for (const member of memberUsers) {
            io.to(`user:${member._id.toString()}`).emit('room_summary_updated', summaryPayload);
        }
    }
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
                const roomObjectId = validateObjectId(data.roomId, 'room ID');
                const roomId = roomObjectId.toString();

                const room = await Room.findById(roomObjectId).lean<LeanRoom | null>();
                if (!room) {
                    emitSocketError(socket, ErrorCode.ROOM_NOT_FOUND, 'Room not found');
                    return;
                }

                if (!isPrivateRoomParticipant(room, user.userId)) {
                    emitSocketError(socket, ErrorCode.FORBIDDEN, 'You are not allowed to join this chat');
                    return;
                }

                const userDoc = await User.findById(user.userId)
                    .select('joinedRooms roomReadPointers')
                    .lean<LeanJoinedRoomsUser | null>();

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

                const usernameMap = buildUsernameMap(users);
                const formattedMessages = pageMessages.reverse().map((msg) => formatMessage(msg, usernameMap));

                const nextCursor = pageMessages.length > 0
                    ? `${pageMessages[pageMessages.length - 1].createdAt.getTime()}_${pageMessages[pageMessages.length - 1]._id.toString()}`
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
                let imageUrl: string | null = room.imageUrl || null;

                if ((room.type || 'public') === 'private' && room.participants) {
                    const otherParticipant = room.participants.find((id) => id.toString() !== user.userId);
                    if (otherParticipant) {
                        const otherParticipantId = otherParticipant.toString();
                        const otherUser = await User.findById(otherParticipantId)
                            .select('username profileImageUrl')
                            .lean<LeanUser | null>();

                        roomName = otherUser?.username || 'Unknown User';
                        imageUrl = otherUser?.profileImageUrl || null;
                        otherUserId = otherParticipantId;
                    }
                }

                socket.emit('room_joined', {
                    room: {
                        id: room._id.toString(),
                        name: roomName,
                        description: room.description,
                        type: room.type || 'public',
                        cityKey: room.cityKey || null,
                        imageUrl,
                        location: toRoomLocation(room),
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

                const result = await createMessage({
                    userId: user.userId,
                    roomId: user.roomId,
                    text: data.text,
                    parentMessageId: data.parentMessageId,
                });

                io.to(user.roomId).emit('new_message', result.messageData);

                if (result.notificationTargets.length > 0) {
                    try {
                        await emitReplyNotifications(io, result.notificationTargets);
                    } catch (err) {
                        logger.error('socket.notification.failed', {
                            error: err instanceof Error ? err.message : String(err),
                            messageId: result.messageData.id,
                        });
                    }
                }

                if (result.isTopLevel) {
                    await emitRoomSummaryUpdate(
                        io,
                        user.roomId,
                        result.messageData,
                        result.roomType,
                        result.roomParticipants
                    );
                }

                logger.info('socket.message_sent', {
                    userId: user.userId,
                    roomId: user.roomId,
                    parentMessageId: data.parentMessageId || null,
                });
            } catch (error) {
                if (error instanceof AppError) {
                    emitSocketError(socket, error.code, error.message);
                    return;
                }
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
