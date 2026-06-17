import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import {
    NotificationService,
    type UserNotifyTarget,
} from '../services/NotificationService.js';
import { prepareMessageDelivery } from '../services/messageDeliveryService.js';
import { createMessage } from '../services/messageService.js';
import { buildRoomJoinView, getRoomSummaryRecipientIds } from '../services/roomService.js';
import { sendPushNotifications } from '../services/pushNotificationService.js';
import { buildSocketCors } from '../utils/cors.js';
import { ErrorCode, AppError, ValidationError } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { isUserBlockedFromActing, type EnforcementState } from '../utils/enforcement.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import type { LeanMessage } from '../types/lean.js';
import type { FormattedMessage } from '../utils/message.js';

interface AuthenticatedSocket {
    userId: string;
    roomId?: string;
    threadId?: string;
}

interface EventRateState {
    count: number;
    resetAt: number;
}

interface SocketDataState {
    user?: AuthenticatedSocket;
    eventRateLimits?: Map<string, EventRateState>;
}

interface SocketPresence {
    roomId?: string;
    threadId?: string;
}

type SocketWithState = Socket & { data: SocketDataState };

const userPresenceBySocketId = new Map<string, Map<string, SocketPresence>>();

const EVENT_RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
    join_room: { max: 20, windowMs: 60_000 },
    send_message: { max: 60, windowMs: 60_000 },
    open_thread: { max: 120, windowMs: 60_000 },
    close_thread: { max: 120, windowMs: 60_000 },
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

function parseRequiredSocketString(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError(`${fieldName} is required`);
    }

    return value.trim();
}

function parseOptionalSocketString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError(`${fieldName} isn't valid.`);
    }

    return value.trim();
}

function parseSocketObjectPayload(value: unknown, eventName: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError("We couldn't process that request. Please try again.");
    }

    return value as Record<string, unknown>;
}

function parseJoinRoomPayload(value: unknown): { roomId: string } {
    const payload = parseSocketObjectPayload(value, 'join_room');
    return {
        roomId: parseRequiredSocketString(payload.roomId, 'Room ID'),
    };
}

function parseOpenThreadPayload(value: unknown): { threadId: string } {
    const payload = parseSocketObjectPayload(value, 'open_thread');
    return {
        threadId: parseRequiredSocketString(payload.threadId, 'Thread ID'),
    };
}

function parseSendMessagePayload(value: unknown): { text: string; parentMessageId?: string } {
    const payload = parseSocketObjectPayload(value, 'send_message');
    return {
        text: parseRequiredSocketString(payload.text, 'Message text'),
        parentMessageId: parseOptionalSocketString(payload.parentMessageId, 'Parent message ID'),
    };
}

function setSocketPresence(userId: string, socketId: string, presence: SocketPresence): void {
    const userPresence = userPresenceBySocketId.get(userId) || new Map<string, SocketPresence>();
    userPresence.set(socketId, presence);
    userPresenceBySocketId.set(userId, userPresence);
}

function clearSocketPresence(userId: string, socketId: string): void {
    const userPresence = userPresenceBySocketId.get(userId);
    if (!userPresence) {
        return;
    }

    userPresence.delete(socketId);
    if (userPresence.size === 0) {
        userPresenceBySocketId.delete(userId);
    }
}

function isUserActiveInRoom(userId: string, roomId: string): boolean {
    const userPresence = userPresenceBySocketId.get(userId);
    if (!userPresence) {
        return false;
    }

    for (const presence of userPresence.values()) {
        if (presence.roomId === roomId) {
            return true;
        }
    }

    return false;
}

function isUserActiveInThread(userId: string, threadId: string): boolean {
    const userPresence = userPresenceBySocketId.get(userId);
    if (!userPresence) {
        return false;
    }

    for (const presence of userPresence.values()) {
        if (presence.threadId === threadId) {
            return true;
        }
    }

    return false;
}

async function emitReplyNotifications(
    io: SocketIOServer,
    targets: UserNotifyTarget[]
): Promise<void> {
    const events = await NotificationService.buildReplyNotificationEvents(
        targets.map((target) => target.notificationId)
    );

    for (const event of events) {
        io.to(`user:${event.targetUserId}`).emit('new_notification', event.payload);
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

    const recipientIds = await getRoomSummaryRecipientIds(roomId, roomType, roomParticipants);
    for (const recipientId of recipientIds) {
        io.to(`user:${recipientId}`).emit('room_summary_updated', summaryPayload);
    }
}

// Module-level reference to the live Socket.IO server so HTTP-triggered actions
// (admin moderation, bans) can push real-time events. Null until setupSocketIO runs
// (e.g. in tests), so all helpers below are no-ops until then.
let ioRef: SocketIOServer | null = null;

// Push a removal so connected clients drop a moderated message immediately.
export function emitMessageRemoved(roomId: string, payload: { messageId: string; roomId: string }): void {
    ioRef?.to(roomId).emit('message_removed', payload);
}

// Force-disconnect all of a user's live sockets (used when banning/suspending).
export function disconnectUser(userId: string): void {
    ioRef?.in(`user:${userId}`).disconnectSockets(true);
}

export function setupSocketIO(server: HTTPServer) {
    const io = new SocketIOServer(server, {
        cors: buildSocketCors(),
    });
    ioRef = io;

    io.use(async (rawSocket, next) => {
        const socket = rawSocket as SocketWithState;
        const token = parseSocketToken(socket);

        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        let userId: string;
        try {
            const decoded = jwt.verify(token, config.jwtSecret);
            if (typeof decoded !== 'object' || decoded === null) {
                return next(new Error('Authentication error: Invalid token payload'));
            }

            const payload = decoded as { userId?: unknown };
            if (typeof payload.userId !== 'string') {
                return next(new Error('Authentication error: Invalid user ID payload'));
            }
            userId = payload.userId;
        } catch {
            return next(new Error('Authentication error: Invalid token'));
        }

        // Block banned/suspended users from connecting. This message is
        // deliberately NOT prefixed with "Authentication error" so the mobile
        // client treats it as a hard rejection rather than looping on token
        // refresh (the refresh would succeed and reconnect into the same ban).
        try {
            const enforcementDoc = await User.findById(userId)
                .select('status suspendedUntil enforcementReason')
                .lean();
            if (enforcementDoc) {
                const enforcement = isUserBlockedFromActing(enforcementDoc as EnforcementState);
                if (enforcement.blocked) {
                    // Stable "Account blocked:" prefix so the mobile client treats
                    // this as a hard ban (show + log out), distinct from the
                    // "Authentication error" prefix it uses to trigger token refresh.
                    return next(new Error(`Account blocked: ${enforcement.reason || 'Your account is not allowed to connect.'}`));
                }
            }
        } catch {
            return next(new Error('Authentication error: Invalid token'));
        }

        socket.data.user = { userId };
        socket.data.eventRateLimits = new Map();
        next();
    });

    io.on('connection', (rawSocket) => {
        const socket = rawSocket as SocketWithState;
        const user = getSocketUser(socket);

        setSocketPresence(user.userId, socket.id, {});

        logger.info('socket.connected', { userId: user.userId, socketId: socket.id });

        const userRoom = `user:${user.userId}`;
        socket.join(userRoom);

        socket.on('join_room', async (data: unknown) => {
            if (!consumeEventBudget(socket, 'join_room')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many join requests. Please slow down.');
                return;
            }

            try {
                const payload = parseJoinRoomPayload(data);
                const roomObjectId = validateObjectId(payload.roomId, 'room ID');
                const roomId = roomObjectId.toString();

                const view = await buildRoomJoinView(user.userId, roomObjectId);

                if (user.roomId) {
                    socket.leave(user.roomId);
                }

                socket.join(roomId);
                user.roomId = roomId;
                user.threadId = undefined;
                setSocketPresence(user.userId, socket.id, {
                    roomId,
                    threadId: undefined,
                });

                socket.emit('room_joined', {
                    room: view.room,
                    messages: view.messages,
                    pagination: view.pagination,
                    lastReadAt: view.lastReadAt,
                });

                socket.to(roomId).emit('user_joined', { userId: user.userId });
                logger.info('socket.room_joined', { userId: user.userId, roomId });
            } catch (error) {
                if (error instanceof AppError) {
                    emitSocketError(socket, error.code, error.message);
                    return;
                }

                logger.error('socket.join_room.failed', {
                    userId: user.userId,
                    error: error instanceof Error ? error.message : String(error),
                });
                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, "We couldn't open that chat. Please try again.");
            }
        });

        socket.on('open_thread', async (data: unknown) => {
            if (!consumeEventBudget(socket, 'open_thread')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many thread events. Please slow down.');
                return;
            }

            try {
                const payload = parseOpenThreadPayload(data);

                if (!user.roomId) {
                    emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Open a chat first.');
                    return;
                }

                const threadObjectId = validateObjectId(payload.threadId, 'thread ID');
                const threadMessage = await Message.findById(threadObjectId)
                    .select('_id roomId parentMessageId')
                    .lean<Pick<LeanMessage, '_id' | 'roomId' | 'parentMessageId'> | null>();

                if (!threadMessage) {
                    emitSocketError(socket, ErrorCode.MESSAGE_NOT_FOUND, 'Thread not found');
                    return;
                }

                if (threadMessage.parentMessageId) {
                    emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'You can only open a thread on a main message.');
                    return;
                }

                if (threadMessage.roomId.toString() !== user.roomId) {
                    emitSocketError(socket, ErrorCode.FORBIDDEN, 'That reply belongs to a different chat.');
                    return;
                }

                user.threadId = threadObjectId.toString();
                setSocketPresence(user.userId, socket.id, {
                    roomId: user.roomId,
                    threadId: user.threadId,
                });
            } catch (error) {
                if (error instanceof AppError) {
                    emitSocketError(socket, error.code, error.message);
                    return;
                }

                logger.error('socket.open_thread.failed', {
                    userId: user.userId,
                    roomId: user.roomId,
                    error: error instanceof Error ? error.message : String(error),
                });
                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, "We couldn't open that thread. Please try again.");
            }
        });

        socket.on('close_thread', () => {
            if (!consumeEventBudget(socket, 'close_thread')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many thread events. Please slow down.');
                return;
            }

            user.threadId = undefined;
            setSocketPresence(user.userId, socket.id, {
                roomId: user.roomId,
                threadId: undefined,
            });
        });

        socket.on('send_message', async (data: unknown) => {
            if (!consumeEventBudget(socket, 'send_message')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many messages. Please slow down.');
                return;
            }

            try {
                const payload = parseSendMessagePayload(data);

                if (!user.roomId) {
                    emitSocketError(socket, ErrorCode.VALIDATION_ERROR, 'Open a chat first.');
                    return;
                }

                const result = await createMessage({
                    userId: user.userId,
                    roomId: user.roomId,
                    text: payload.text,
                    parentMessageId: payload.parentMessageId,
                });

                io.to(user.roomId).emit('new_message', result.messageData);

                if (result.isTopLevel) {
                    await emitRoomSummaryUpdate(
                        io,
                        user.roomId,
                        result.messageData,
                        result.roomType,
                        result.roomParticipants
                    );
                }

                try {
                    const deliveryResult = await prepareMessageDelivery(result, {
                        isUserActiveInRoom,
                        isUserActiveInThread,
                    });

                    if (deliveryResult.replyNotificationTargets.length > 0) {
                        await emitReplyNotifications(io, deliveryResult.replyNotificationTargets);
                    }

                    if (deliveryResult.pushRequest) {
                        await sendPushNotifications(deliveryResult.pushRequest);
                    }
                } catch (error) {
                    logger.error('socket.push_dispatch.failed', {
                        userId: user.userId,
                        roomId: user.roomId,
                        messageId: result.messageData.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                logger.info('socket.message_sent', {
                    userId: user.userId,
                    roomId: user.roomId,
                    parentMessageId: payload.parentMessageId || null,
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
                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, "We couldn't send that message. Please try again.");
            }
        });

        socket.on('leave_room', async () => {
            if (!user.roomId) {
                return;
            }

            const roomId = user.roomId;
            user.roomId = undefined;
            user.threadId = undefined;
            setSocketPresence(user.userId, socket.id, {});

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

            clearSocketPresence(user.userId, socket.id);
            logger.info('socket.disconnected', { userId: user.userId, socketId: socket.id });
        });
    });

    return io;
}
