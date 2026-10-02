import mongoose from 'mongoose';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Aps, Message } from 'firebase-admin/messaging';
import { config } from '../config/index.js';
import { PushToken } from '../models/PushToken.js';
import { NotificationService } from './NotificationService.js';
import { countUnreadDirectRoomsByUser } from './roomService.js';
import { getActiveBlockPairUserIdsByUser } from './blockService.js';
import logger from '../utils/logger.js';

export type PushPlatform = 'ios' | 'android';
export type PushNotificationType = 'message' | 'reply';
export type PushTokenDeactivationReason = 'logged_out' | 'account_blocked';

interface RegisterPushTokenInput {
    userId: string;
    token: string;
    platform: PushPlatform;
    // The app keeps the iOS app-icon badge up to date and wants the count in
    // its pushes.
    badge?: boolean;
}

interface UnregisterPushTokenInput {
    userId: string;
    token: string;
}

interface PushRecipient {
    userId: string;
    notificationId?: string;
}

export interface SendPushNotificationsInput {
    type: PushNotificationType;
    recipients: PushRecipient[];
    roomId: string;
    roomName: string;
    roomType: 'public' | 'private';
    messageId: string;
    threadId?: string | null;
    senderId: string;
    senderUsername: string;
    messageText: string;
}

interface PushMessagingClient {
    sendEach(messages: Message[]): Promise<{
        responses: Array<{
            success: boolean;
            error?: {
                code?: string;
                message: string;
            };
        }>;
    }>;
}

interface StoredPushToken {
    _id: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    token: string;
    platform: PushPlatform;
    badge?: boolean;
}

// FCM's sendEach takes at most 500 messages per call; more fails the whole call.
const FCM_MAX_BATCH_SIZE = 500;

// Badge counts stop at 99.
const MAX_APP_BADGE = 99;

// Badges are counted for up to 100 recipients at a time, two chunks at once.
// One count for every recipient of a large city-room push could run past the
// 3-second query limit and leave all of its pushes without a badge.
const BADGE_COUNT_CHUNK_SIZE = 100;
const BADGE_COUNT_CONCURRENCY = 2;

let firebaseApp: App | null = null;
let pushMessagingClient: PushMessagingClient | null = null;

export function setPushMessagingForTests(client: PushMessagingClient | null): void {
    pushMessagingClient = client;
    if (client) {
        firebaseApp = null;
    }
}

export function resetPushMessagingForTests(): void {
    pushMessagingClient = null;
    firebaseApp = null;
}

function hasPushConfig(): boolean {
    return Boolean(
        config.push.firebaseProjectId
        && config.push.firebaseClientEmail
        && config.push.firebasePrivateKey
    );
}

function getFirebaseApp(): App {
    if (firebaseApp) {
        return firebaseApp;
    }

    const existingApp = getApps()[0];
    if (existingApp) {
        firebaseApp = existingApp;
        return firebaseApp;
    }

    firebaseApp = initializeApp({
        credential: cert({
            projectId: config.push.firebaseProjectId,
            clientEmail: config.push.firebaseClientEmail,
            privateKey: config.push.firebasePrivateKey.replace(/\\n/g, '\n'),
        }),
    });

    return firebaseApp;
}

function getPushMessagingClient(): PushMessagingClient | null {
    if (pushMessagingClient) {
        return pushMessagingClient;
    }

    if (!hasPushConfig()) {
        return null;
    }

    return getMessaging(getFirebaseApp());
}

function truncatePreview(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= 100) {
        return trimmed;
    }

    return `${trimmed.substring(0, 100)}...`;
}

function buildNotificationPresentation(input: SendPushNotificationsInput): { title: string; body: string } {
    const preview = truncatePreview(input.messageText);

    if (input.type === 'reply') {
        return {
            title: `${input.senderUsername} replied`,
            body: preview || 'New reply',
        };
    }

    if (input.roomType === 'private') {
        return {
            title: input.senderUsername || input.roomName || 'New message',
            body: preview || 'New message',
        };
    }

    return {
        title: input.roomName || 'New message',
        body: preview
            ? `${input.senderUsername}: ${preview}`
            : `${input.senderUsername} sent a message`,
    };
}

function buildDataPayload(
    input: SendPushNotificationsInput,
    recipient: PushRecipient
): Record<string, string> {
    const payload: Record<string, string> = {
        type: input.type,
        roomId: input.roomId,
        messageId: input.messageId,
        senderId: input.senderId,
    };

    if (input.threadId) {
        payload.threadId = input.threadId;
    }

    if (recipient.notificationId) {
        payload.notificationId = recipient.notificationId;
    }

    return payload;
}

// Only app builds that keep the iOS app-icon badge up to date register with
// `badge: true`. Android launchers show their own notification dots.
function wantsAppBadge(token: StoredPushToken): boolean {
    return token.platform === 'ios' && token.badge === true;
}

// The badges of one chunk of recipients, in one batch of queries. If counting
// fails, their pushes still go out, just without a badge.
async function countChunkAppBadges(userIds: string[]): Promise<Map<string, number>> {
    try {
        const blockedUserIdsByUserId = await getActiveBlockPairUserIdsByUser(userIds);
        const [unreadActivityByUserId, unreadDirectRoomsByUserId] = await Promise.all([
            NotificationService.countUnreadByRecipient(blockedUserIdsByUserId),
            countUnreadDirectRoomsByUser(blockedUserIdsByUserId),
        ]);

        return new Map(userIds.map((userId) => {
            const unread = (unreadActivityByUserId.get(userId) ?? 0) + (unreadDirectRoomsByUserId.get(userId) ?? 0);
            return [userId, Math.min(unread, MAX_APP_BADGE)];
        }));
    } catch (error) {
        logger.warn('push.badge_count.failed', {
            chunkSize: userIds.length,
            error: error instanceof Error ? error.message : String(error),
        });
        return new Map();
    }
}

// The iOS app-icon badge for each given recipient: unread Activity items plus
// DM chats with unread messages, the same number the app shows. City rooms
// don't count. Recipients are counted in chunks, so a failed chunk only costs
// its own recipients their badge.
async function countAppBadges(userIds: string[]): Promise<Map<string, number>> {
    const chunks: string[][] = [];
    for (let start = 0; start < userIds.length; start += BADGE_COUNT_CHUNK_SIZE) {
        chunks.push(userIds.slice(start, start + BADGE_COUNT_CHUNK_SIZE));
    }

    const badgeByUserId = new Map<string, number>();
    let nextChunk = 0;
    // Each worker takes the next chunk once it's done with its last one.
    const countRemainingChunks = async (): Promise<void> => {
        while (nextChunk < chunks.length) {
            const chunk = chunks[nextChunk];
            nextChunk += 1;
            for (const [userId, badge] of await countChunkAppBadges(chunk)) {
                badgeByUserId.set(userId, badge);
            }
        }
    };
    await Promise.all(Array.from({ length: BADGE_COUNT_CONCURRENCY }, countRemainingChunks));

    return badgeByUserId;
}

// iOS plays a sound only when the push names one. Without a badge the icon's
// badge stays as it is.
function buildAps(badge: number | undefined): Aps {
    return badge === undefined ? { sound: 'default' } : { sound: 'default', badge };
}

function isInvalidTokenError(code?: string): boolean {
    return code === 'messaging/registration-token-not-registered'
        || code === 'messaging/invalid-registration-token';
}

type SendEachResponse = Awaited<ReturnType<PushMessagingClient['sendEach']>>;

// One bulk write per batch: a single update for all successes, one per failure.
async function recordSendResults(
    response: SendEachResponse,
    tokens: StoredPushToken[],
    type: PushNotificationType
): Promise<void> {
    const now = new Date();
    const successIds: mongoose.Types.ObjectId[] = [];
    const failureOps: Parameters<typeof PushToken.bulkWrite>[0] = [];

    response.responses.forEach((sendResponse, index) => {
        const token = tokens[index];
        if (!token) {
            return;
        }

        if (sendResponse.success) {
            successIds.push(token._id);
            return;
        }

        const errorCode = sendResponse.error?.code;
        const errorMessage = sendResponse.error?.message || 'Push send failed';

        logger.warn('push.send.failed', {
            userId: token.userId.toString(),
            type,
            code: errorCode,
            error: errorMessage,
        });

        const update: Record<string, unknown> = {
            lastFailureAt: now,
            failureReason: errorCode || errorMessage,
        };
        if (isInvalidTokenError(errorCode)) {
            update.isActive = false;
        }
        failureOps.push({ updateOne: { filter: { _id: token._id }, update: { $set: update } } });
    });

    const ops: Parameters<typeof PushToken.bulkWrite>[0] = [...failureOps];
    if (successIds.length > 0) {
        ops.push({
            updateMany: {
                filter: { _id: { $in: successIds } },
                update: { $set: { lastSuccessAt: now, failureReason: '' }, $unset: { lastFailureAt: '' } },
            },
        });
    }

    if (ops.length > 0) {
        await PushToken.bulkWrite(ops, { ordered: false });
    }
}

export async function registerPushToken(input: RegisterPushTokenInput): Promise<void> {
    const normalizedToken = input.token.trim();
    const now = new Date();

    await PushToken.deleteMany({
        token: normalizedToken,
        userId: { $ne: new mongoose.Types.ObjectId(input.userId) },
    });

    await PushToken.findOneAndUpdate(
        { userId: input.userId },
        {
            $set: {
                token: normalizedToken,
                platform: input.platform,
                isActive: true,
                // Set on every registration: an app build without badge
                // support that registers next must not receive badge counts.
                badge: input.badge === true,
                lastSeenAt: now,
                failureReason: '',
            },
            $unset: {
                lastFailureAt: '',
            },
        },
        {
            upsert: true,
            setDefaultsOnInsert: true,
        }
    );
}

export async function unregisterPushToken(input: UnregisterPushTokenInput): Promise<void> {
    await PushToken.updateOne(
        { userId: input.userId, token: input.token.trim() },
        {
            $set: {
                isActive: false,
                lastFailureAt: new Date(),
                failureReason: 'unregistered',
            },
        }
    );
}

// Stops all pushes to an account, e.g. at logout or when it's banned. Each
// account has one push token, the one its latest sign-in registered. The next
// registration after signing in switches it back on.
export async function deactivatePushTokensForUser(
    userId: string,
    reason: PushTokenDeactivationReason
): Promise<void> {
    await PushToken.updateMany(
        { userId: new mongoose.Types.ObjectId(userId) },
        {
            $set: {
                isActive: false,
                lastFailureAt: new Date(),
                failureReason: reason,
            },
        }
    );
}

export async function sendPushNotifications(input: SendPushNotificationsInput): Promise<void> {
    if (input.recipients.length === 0) {
        return;
    }

    const messagingClient = getPushMessagingClient();
    if (!messagingClient) {
        logger.debug('push.send.skipped_unconfigured', {
            type: input.type,
            recipientCount: input.recipients.length,
        });
        return;
    }

    const recipientUserIds = input.recipients.map((recipient) => new mongoose.Types.ObjectId(recipient.userId));
    const tokens = await PushToken.find({
        userId: { $in: recipientUserIds },
        isActive: true,
    })
        .select('_id userId token platform badge')
        .lean<StoredPushToken[]>();

    if (tokens.length === 0) {
        return;
    }

    const recipientByUserId = new Map(input.recipients.map((recipient) => [recipient.userId, recipient]));
    const badgeUserIds = new Set(
        tokens
            .filter((token) => wantsAppBadge(token) && recipientByUserId.has(token.userId.toString()))
            .map((token) => token.userId.toString())
    );
    const badgeByUserId = await countAppBadges([...badgeUserIds]);
    const presentation = buildNotificationPresentation(input);
    const messages: Message[] = [];
    const tokensInSendOrder: StoredPushToken[] = [];

    for (const token of tokens) {
        const userId = token.userId.toString();
        const recipient = recipientByUserId.get(userId);
        if (!recipient) {
            continue;
        }

        messages.push({
            token: token.token,
            notification: presentation,
            data: buildDataPayload(input, recipient),
            android: {
                priority: 'high',
                // Android 8+ plays the bleya_messages channel's sound. Android 7
                // has no channels and plays the sound named here.
                notification: { channelId: 'bleya_messages', sound: 'default' },
            },
            apns: {
                headers: { 'apns-priority': '10' },
                payload: { aps: buildAps(wantsAppBadge(token) ? badgeByUserId.get(userId) : undefined) },
            },
        });
        tokensInSendOrder.push(token);
    }

    if (messages.length === 0) {
        return;
    }

    for (let start = 0; start < messages.length; start += FCM_MAX_BATCH_SIZE) {
        const batchMessages = messages.slice(start, start + FCM_MAX_BATCH_SIZE);
        const batchTokens = tokensInSendOrder.slice(start, start + FCM_MAX_BATCH_SIZE);

        // A failed batch is logged and skipped; the remaining batches still go out.
        try {
            const response = await messagingClient.sendEach(batchMessages);
            await recordSendResults(response, batchTokens, input.type);
        } catch (error) {
            logger.error('push.send.batch_failed', {
                type: input.type,
                batchSize: batchMessages.length,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
