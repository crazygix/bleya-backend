import mongoose from 'mongoose';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, Message } from 'firebase-admin/messaging';
import { config } from '../config/index.js';
import { PushToken } from '../models/PushToken.js';
import logger from '../utils/logger.js';

export type PushPlatform = 'ios' | 'android';
export type PushNotificationType = 'message' | 'reply';

interface RegisterPushTokenInput {
    userId: string;
    token: string;
    platform: PushPlatform;
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
}

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

function isInvalidTokenError(code?: string): boolean {
    return code === 'messaging/registration-token-not-registered'
        || code === 'messaging/invalid-registration-token';
}

async function markPushTokenSuccess(id: mongoose.Types.ObjectId): Promise<void> {
    await PushToken.updateOne(
        { _id: id },
        {
            $set: {
                lastSuccessAt: new Date(),
                failureReason: '',
            },
            $unset: {
                lastFailureAt: '',
            },
        }
    );
}

async function markPushTokenFailure(
    token: StoredPushToken,
    code: string | undefined,
    message: string
): Promise<void> {
    const now = new Date();
    const update: Record<string, unknown> = {
        lastFailureAt: now,
        failureReason: code || message,
    };

    if (isInvalidTokenError(code)) {
        update.isActive = false;
    }

    await PushToken.updateOne({ _id: token._id }, { $set: update });
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
        .select('_id userId token platform')
        .lean<StoredPushToken[]>();

    if (tokens.length === 0) {
        return;
    }

    const recipientByUserId = new Map(input.recipients.map((recipient) => [recipient.userId, recipient]));
    const presentation = buildNotificationPresentation(input);
    const messages: Message[] = [];
    const tokensInSendOrder: StoredPushToken[] = [];

    for (const token of tokens) {
        const recipient = recipientByUserId.get(token.userId.toString());
        if (!recipient) {
            continue;
        }

        messages.push({
            token: token.token,
            notification: presentation,
            data: buildDataPayload(input, recipient),
            android: {
                priority: 'high',
                notification: { channelId: 'bleya_messages' },
            },
            apns: { headers: { 'apns-priority': '10' } },
        });
        tokensInSendOrder.push(token);
    }

    if (messages.length === 0) {
        return;
    }

    const response = await messagingClient.sendEach(messages);
    await Promise.all(response.responses.map(async (sendResponse, index) => {
        const token = tokensInSendOrder[index];
        if (!token) {
            return;
        }

        if (sendResponse.success) {
            await markPushTokenSuccess(token._id);
            return;
        }

        const errorCode = sendResponse.error?.code;
        const errorMessage = sendResponse.error?.message || 'Push send failed';

        logger.warn('push.send.failed', {
            userId: token.userId.toString(),
            type: input.type,
            code: errorCode,
            error: errorMessage,
        });

        await markPushTokenFailure(token, errorCode, errorMessage);
    }));
}
