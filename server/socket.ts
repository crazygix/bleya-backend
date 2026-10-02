import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import {
    NotificationService,
    type UserNotifyTarget,
} from '../services/NotificationService.js';
import { prepareMessageDelivery } from '../services/messageDeliveryService.js';
import { createMessage } from '../services/messageService.js';
import {
    buildRoomJoinView,
    getRoomSummaryRecipientIds,
    RoomJoinSupersededError,
} from '../services/roomService.js';
import { sendPushNotifications } from '../services/pushNotificationService.js';
import { buildSocketCors } from '../utils/cors.js';
import { ErrorCode, AppError, ValidationError } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { describeEnforcementForUser, type EnforcementState } from '../utils/enforcement.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import type { LeanMessage } from '../types/lean.js';
import type { FormattedMessage } from '../utils/message.js';

interface AuthenticatedSocket {
    userId: string;
    roomId?: string;
    threadId?: string;
    // Expiry (ms since epoch) of the access token the socket connected with.
    tokenExpiresAt?: number;
}

interface EventRateState {
    count: number;
    resetAt: number;
}

interface SocketDataState {
    user?: AuthenticatedSocket;
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

// Event budgets are per user, shared by all of that user's sockets, so opening
// extra connections doesn't multiply the message or join allowance.
const eventBudgetsByUserId = new Map<string, Map<string, EventRateState>>();
const EVENT_BUDGET_SWEEP_INTERVAL_MS = 60_000;
let eventBudgetSweeper: NodeJS.Timeout | null = null;

function startEventBudgetSweeper(): void {
    if (eventBudgetSweeper) {
        return;
    }

    eventBudgetSweeper = setInterval(() => {
        const now = Date.now();
        for (const [userId, budgets] of eventBudgetsByUserId) {
            for (const [eventName, state] of budgets) {
                if (state.resetAt <= now) {
                    budgets.delete(eventName);
                }
            }
            if (budgets.size === 0) {
                eventBudgetsByUserId.delete(userId);
            }
        }
    }, EVENT_BUDGET_SWEEP_INTERVAL_MS);
    eventBudgetSweeper.unref();
}

// Socket.IO's own connection-error message prefixes are a protocol with the
// mobile client: "Authentication error" => refresh the token and reconnect,
// "Account blocked:" => log out. Anything that is neither (like a database
// outage) must use a different prefix so the app just retries later.
const SERVER_UNAVAILABLE_ERROR = 'Server unavailable: please try again shortly.';

// The app auto-rejoins its current room when an error message contains
// "Not in a room" (e.g. a message sent right after a reconnect), and doesn't
// show it — so keep that phrase in this text.
const NOT_IN_ROOM_MESSAGE = 'Not in a room. Reopen the chat and try again.';

// Acknowledgement for a join_room that a newer join_room, a leave_room or a
// disconnect overtook while the room was loading.
const SUPERSEDED_JOIN_RESPONSE = { ok: false, superseded: true } as const;

function emitSocketError(socket: SocketWithState, code: ErrorCode, message: string): void {
    socket.emit('error', {
        error: {
            code,
            message,
        },
    });
}

function consumeEventBudget(userId: string, eventName: keyof typeof EVENT_RATE_LIMITS): boolean {
    const limits = EVENT_RATE_LIMITS[eventName];
    let budgets = eventBudgetsByUserId.get(userId);
    if (!budgets) {
        budgets = new Map();
        eventBudgetsByUserId.set(userId, budgets);
    }

    const now = Date.now();
    const existing = budgets.get(eventName);

    if (!existing || existing.resetAt <= now) {
        budgets.set(eventName, {
            count: 1,
            resetAt: now + limits.windowMs,
        });
        return true;
    }

    if (existing.count >= limits.max) {
        return false;
    }

    existing.count += 1;
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

function parseSendMessagePayload(value: unknown): { text: string; roomId?: string; parentMessageId?: string } {
    const payload = parseSocketObjectPayload(value, 'send_message');
    const text = parseRequiredSocketString(payload.text, 'Message text');
    const roomId = parseOptionalSocketString(payload.roomId, 'Room ID');
    return {
        text,
        // Normalized, so it compares equal to the id of the room the socket joined.
        roomId: roomId === undefined ? undefined : validateObjectId(roomId, 'room ID').toString(),
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
    roomParticipants: string[],
    excludedUserIds: string[] = []
): Promise<void> {
    const summaryPayload = {
        roomId: messageData.roomId,
        lastMessageText: messageData.text,
        lastMessageTime: messageData.createdAt,
        lastMessageUserId: messageData.userId,
        lastMessageUsername: messageData.username,
    };

    const recipientIds = await getRoomSummaryRecipientIds(roomId, roomType, roomParticipants);
    const excluded = new Set(excludedUserIds);
    for (const recipientId of recipientIds) {
        // Don't surface a blocked-pair user's message as the room-list preview.
        if (excluded.has(recipientId)) {
            continue;
        }
        io.to(`user:${recipientId}`).emit('room_summary_updated', summaryPayload);
    }
}

// Module-level reference to the live Socket.IO server so HTTP-triggered actions
// (admin moderation, bans) can push real-time events. Null until setupSocketIO runs
// (e.g. in tests), so all helpers below are no-ops until then.
let ioRef: SocketIOServer | null = null;

// A moderated message that was removed. parentMessageId is set when it is a
// thread reply, and is null for a top-level message (whose open thread view
// should then close). userId is its author and createdAt its creation time in
// ms, the same values message and chat-list payloads carry.
export interface MessageRemovedPayload {
    messageId: string;
    roomId: string;
    parentMessageId: string | null;
    userId: string;
    createdAt: number;
}

// Push a removal so connected clients drop a moderated message immediately:
// sockets in its room, plus every socket of `alsoToUserIds` (chat lists and
// Activity outside the room). It must stay a single emit, so a socket that is
// in several of these rooms still gets it once: the app lowers a parent's
// reply count on every delivery.
export function emitMessageRemoved(payload: MessageRemovedPayload, alsoToUserIds: Iterable<string> = []): void {
    if (!ioRef) {
        return;
    }

    const targets = new Set<string>([payload.roomId]);
    for (const userId of alsoToUserIds) {
        targets.add(`user:${userId}`);
    }
    ioRef.to([...targets]).emit('message_removed', payload);
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
        let tokenExpiresAt: number | undefined;
        try {
            const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
            if (typeof decoded !== 'object' || decoded === null) {
                return next(new Error('Authentication error: Invalid token payload'));
            }

            const payload = decoded as { userId?: unknown; exp?: unknown };
            if (typeof payload.userId !== 'string') {
                return next(new Error('Authentication error: Invalid user ID payload'));
            }
            userId = payload.userId;
            tokenExpiresAt = typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
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
            if (!enforcementDoc) {
                // Deleted account: its still-unexpired token must not connect.
                return next(new Error('Authentication error: Account not found'));
            }

            const explanation = describeEnforcementForUser(enforcementDoc as EnforcementState);
            if (explanation) {
                // Stable "Account blocked:" prefix so the mobile client treats
                // this as a hard ban (show + log out), distinct from the
                // "Authentication error" prefix it uses to trigger token refresh.
                // The rest is the same sentence sign-in and refresh show.
                return next(new Error(`Account blocked: ${explanation}`));
            }
        } catch (error) {
            // A lookup failure is our problem, not the token's. Using the
            // "Authentication error" prefix here made the app refresh (or log
            // out) during a database blip.
            logger.error('socket.handshake.enforcement_lookup_failed', {
                userId,
                error: error instanceof Error ? error.message : String(error),
            });
            return next(new Error(SERVER_UNAVAILABLE_ERROR));
        }

        socket.data.user = { userId, tokenExpiresAt };
        next();
    });

    startEventBudgetSweeper();

    io.on('connection', (rawSocket) => {
        const socket = rawSocket as SocketWithState;
        const user = getSocketUser(socket);

        // Newest connection wins: beyond the per-user cap, drop the oldest
        // sockets (presence maps keep insertion order).
        const existingSocketIds = [...(userPresenceBySocketId.get(user.userId)?.keys() || [])];
        const excess = existingSocketIds.length + 1 - config.socket.maxConnectionsPerUser;
        for (const staleSocketId of existingSocketIds.slice(0, Math.max(0, excess))) {
            io.sockets.sockets.get(staleSocketId)?.disconnect(true);
            clearSocketPresence(user.userId, staleSocketId);
        }

        setSocketPresence(user.userId, socket.id, {});

        logger.info('socket.connected', { userId: user.userId, socketId: socket.id });

        const userRoom = `user:${user.userId}`;
        socket.join(userRoom);

        // Optionally end the socket when its access token expires, so a session
        // can't outlive the token it was opened with (see config.socket).
        let tokenExpiryTimer: NodeJS.Timeout | null = null;
        if (config.socket.enforceTokenExpiry && user.tokenExpiresAt) {
            tokenExpiryTimer = setTimeout(() => {
                emitSocketError(socket, ErrorCode.TOKEN_EXPIRED, 'Authentication error: session expired');
                socket.disconnect(true);
            }, Math.max(0, user.tokenExpiresAt - Date.now()));
        }

        // Last request wins on this socket. join_room, leave_room and a
        // disconnect each start a new room request; those, open_thread and
        // close_thread each start a new thread request. A handler that waited
        // on the database applies its result only while it is still the latest
        // request of its kind on a connected socket, so a slow join or thread
        // open can't move the socket back to an old room or mark the user
        // present after they moved on or went away.
        let latestRoomRequest = 0;
        let latestThreadRequest = 0;

        socket.on('join_room', async (data: unknown, ack?: unknown) => {
            const request = ++latestRoomRequest;
            latestThreadRequest += 1;
            const isLatestJoin = (): boolean => request === latestRoomRequest && socket.connected;

            // Optional acknowledgement: clients that pass a callback get the
            // outcome there ({ok: true} after room_joined, or {ok: false, error})
            // instead of an 'error' event.
            const respond = typeof ack === 'function'
                ? (ack as (response: Record<string, unknown>) => void)
                : null;
            const fail = (code: ErrorCode, message: string): void => {
                if (respond) {
                    respond({ ok: false, error: { code, message } });
                } else {
                    emitSocketError(socket, code, message);
                }
            };

            if (!consumeEventBudget(user.userId, 'join_room')) {
                fail(ErrorCode.TOO_MANY_REQUESTS, 'Too many join requests. Please slow down.');
                return;
            }

            try {
                const payload = parseJoinRoomPayload(data);
                const roomObjectId = validateObjectId(payload.roomId, 'room ID');
                const roomId = roomObjectId.toString();

                const view = await buildRoomJoinView(user.userId, roomObjectId, {
                    isStillWanted: isLatestJoin,
                });

                // A newer request arrived while the room was loading and decides
                // the room now, so this join changes nothing.
                if (!isLatestJoin()) {
                    respond?.(SUPERSEDED_JOIN_RESPONSE);
                    return;
                }

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
                respond?.({ ok: true });

                logger.info('socket.room_joined', { userId: user.userId, roomId });
            } catch (error) {
                if (!(error instanceof AppError || error instanceof RoomJoinSupersededError)) {
                    logger.error('socket.join_room.failed', {
                        userId: user.userId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                // The outcome of an overtaken join no longer matters to the app.
                if (!isLatestJoin()) {
                    respond?.(SUPERSEDED_JOIN_RESPONSE);
                    return;
                }

                if (error instanceof AppError) {
                    fail(error.code, error.message);
                    return;
                }

                fail(ErrorCode.INTERNAL_ERROR, "We couldn't open that chat. Please try again.");
            }
        });

        socket.on('open_thread', async (data: unknown) => {
            const request = ++latestThreadRequest;
            const isLatestOpen = (): boolean => request === latestThreadRequest && socket.connected;

            if (!consumeEventBudget(user.userId, 'open_thread')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many thread events. Please slow down.');
                return;
            }

            try {
                const payload = parseOpenThreadPayload(data);

                if (!user.roomId) {
                    emitSocketError(socket, ErrorCode.NOT_IN_ROOM, NOT_IN_ROOM_MESSAGE);
                    return;
                }

                const threadObjectId = validateObjectId(payload.threadId, 'thread ID');
                const threadMessage = await Message.findById(threadObjectId)
                    .select('_id roomId parentMessageId')
                    .lean<Pick<LeanMessage, '_id' | 'roomId' | 'parentMessageId'> | null>();

                // Overtaken while the thread was looked up: drop it quietly, so
                // a thread the app already left isn't marked open again.
                if (!isLatestOpen()) {
                    return;
                }

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
                if (!(error instanceof AppError)) {
                    logger.error('socket.open_thread.failed', {
                        userId: user.userId,
                        roomId: user.roomId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                // Overtaken requests are dropped quietly, failures included.
                if (!isLatestOpen()) {
                    return;
                }

                if (error instanceof AppError) {
                    emitSocketError(socket, error.code, error.message);
                    return;
                }

                emitSocketError(socket, ErrorCode.INTERNAL_ERROR, "We couldn't open that thread. Please try again.");
            }
        });

        socket.on('close_thread', () => {
            // Overtakes an open_thread that is still loading, even when this
            // close_thread is over the rate limit itself.
            latestThreadRequest += 1;

            if (!consumeEventBudget(user.userId, 'close_thread')) {
                emitSocketError(socket, ErrorCode.TOO_MANY_REQUESTS, 'Too many thread events. Please slow down.');
                return;
            }

            user.threadId = undefined;
            setSocketPresence(user.userId, socket.id, {
                roomId: user.roomId,
                threadId: undefined,
            });
        });

        socket.on('send_message', async (data: unknown, ack?: unknown) => {
            // Optional acknowledgement: clients that pass a callback learn whether
            // the message was stored before clearing their draft. Errors are still
            // also emitted as an 'error' event for clients that don't use acks.
            const respond = typeof ack === 'function'
                ? (ack as (response: Record<string, unknown>) => void)
                : null;
            const fail = (code: ErrorCode, message: string): void => {
                emitSocketError(socket, code, message);
                respond?.({ ok: false, error: { code, message } });
            };

            if (!consumeEventBudget(user.userId, 'send_message')) {
                fail(ErrorCode.TOO_MANY_REQUESTS, 'Too many messages. Please slow down.');
                return;
            }

            // The room is captured before any await: the user can switch or leave
            // rooms while the message is being stored.
            const roomId = user.roomId;

            try {
                const payload = parseSendMessagePayload(data);

                if (!roomId) {
                    fail(ErrorCode.NOT_IN_ROOM, NOT_IN_ROOM_MESSAGE);
                    return;
                }

                // Newer apps say which chat the message is for. If this socket
                // is in another room, refuse it instead of posting it there; the
                // app rejoins its chat and sends again.
                if (payload.roomId && payload.roomId !== roomId) {
                    logger.warn('socket.send_message.room_mismatch', {
                        userId: user.userId,
                        roomId,
                        requestedRoomId: payload.roomId,
                    });
                    fail(ErrorCode.NOT_IN_ROOM, NOT_IN_ROOM_MESSAGE);
                    return;
                }

                const result = await createMessage({
                    userId: user.userId,
                    roomId,
                    text: payload.text,
                    parentMessageId: payload.parentMessageId,
                });

                respond?.({ ok: true, message: result.messageData });

                // Mutual block: exclude blocked-pair users from the live broadcast
                // (.except on their personal `user:<id>` room). An empty list
                // excludes no one.
                io.to(result.roomId)
                    .except(result.blockedPairUserIds.map((id) => `user:${id}`))
                    .emit('new_message', result.messageData);

                if (result.isTopLevel) {
                    await emitRoomSummaryUpdate(
                        io,
                        result.roomId,
                        result.messageData,
                        result.roomType,
                        result.roomParticipants,
                        result.blockedPairUserIds
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
                        roomId: result.roomId,
                        messageId: result.messageData.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }

                logger.info('socket.message_sent', {
                    userId: user.userId,
                    roomId: result.roomId,
                    parentMessageId: payload.parentMessageId || null,
                });
            } catch (error) {
                if (error instanceof AppError) {
                    fail(error.code, error.message);
                    return;
                }
                logger.error('socket.send_message.failed', {
                    userId: user.userId,
                    roomId,
                    error: error instanceof Error ? error.message : String(error),
                });
                fail(ErrorCode.INTERNAL_ERROR, "We couldn't send that message. Please try again.");
            }
        });

        // Synchronous on purpose: no database work here, so nothing can fail
        // outside the handler's control.
        socket.on('leave_room', () => {
            // Overtakes a join_room or open_thread that is still loading, also
            // before the first join completes (a join followed by a quick leave).
            latestRoomRequest += 1;
            latestThreadRequest += 1;

            if (!user.roomId) {
                return;
            }

            const roomId = user.roomId;
            user.roomId = undefined;
            user.threadId = undefined;
            setSocketPresence(user.userId, socket.id, {});

            socket.leave(roomId);

            logger.info('socket.room_left', { userId: user.userId, roomId });
        });

        socket.on('disconnect', () => {
            // Nothing still loading may mark this socket present once it's gone.
            latestRoomRequest += 1;
            latestThreadRequest += 1;

            if (tokenExpiryTimer) {
                clearTimeout(tokenExpiryTimer);
            }

            clearSocketPresence(user.userId, socket.id);
            logger.info('socket.disconnected', { userId: user.userId, socketId: socket.id });
        });
    });

    return io;
}
