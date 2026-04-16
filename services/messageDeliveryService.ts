import { NotificationService, type UserNotifyTarget } from './NotificationService.js';
import {
    type SendPushNotificationsInput,
} from './pushNotificationService.js';
import type { CreateMessageResult } from './messageService.js';
import logger from '../utils/logger.js';

export interface MessagePresenceResolver {
    isUserActiveInRoom(userId: string, roomId: string): boolean;
    isUserActiveInThread(userId: string, threadId: string): boolean;
}

interface ReplyNotificationService {
    createReplyNotifications(input: {
        replyMessageId: string;
        parentMessageId: string;
        senderId: string;
        roomId: string;
        recipientUserIds: string[];
    }): Promise<UserNotifyTarget[]>;
}

export interface MessageDeliveryServiceDeps {
    notificationService: ReplyNotificationService;
}

export interface MessageDeliveryResult {
    replyNotificationTargets: UserNotifyTarget[];
    pushRequest: SendPushNotificationsInput | null;
}

function buildNotificationIdMap(targets: UserNotifyTarget[]): Map<string, string> {
    return new Map(targets.map((target) => [target.userId, target.notificationId]));
}

export function createMessageDeliveryService(deps: MessageDeliveryServiceDeps) {
    const { notificationService } = deps;

    async function prepareMessageDelivery(
        message: CreateMessageResult,
        presenceResolver: MessagePresenceResolver
    ): Promise<MessageDeliveryResult> {
        if (message.pushType === 'message') {
            const pushRecipients = message.candidateRecipientUserIds
                .filter((userId) => !presenceResolver.isUserActiveInRoom(userId, message.roomId))
                .map((userId) => ({ userId }));

            if (pushRecipients.length === 0) {
                return {
                    replyNotificationTargets: [],
                    pushRequest: null,
                };
            }

            return {
                replyNotificationTargets: [],
                pushRequest: {
                    type: 'message',
                    recipients: pushRecipients,
                    roomId: message.roomId,
                    roomName: message.roomName,
                    roomType: message.roomType,
                    messageId: message.messageData.id,
                    threadId: null,
                    senderId: message.senderId,
                    senderUsername: message.senderUsername,
                    messageText: message.messageData.text,
                },
            };
        }

        const threadId = message.threadId;
        if (!threadId) {
            return {
                replyNotificationTargets: [],
                pushRequest: null,
            };
        }

        const missedRecipients = message.candidateRecipientUserIds
            .filter((userId) => !presenceResolver.isUserActiveInThread(userId, threadId));

        if (missedRecipients.length === 0) {
            return {
                replyNotificationTargets: [],
                pushRequest: null,
            };
        }

        let replyNotificationTargets: UserNotifyTarget[] = [];

        try {
            replyNotificationTargets = await notificationService.createReplyNotifications({
                senderId: message.senderId,
                roomId: message.roomId,
                parentMessageId: threadId,
                replyMessageId: message.messageData.id,
                recipientUserIds: missedRecipients,
            });
        } catch (error) {
            logger.error('message_delivery.reply_notification_create.failed', {
                error: error instanceof Error ? error.message : String(error),
                messageId: message.messageData.id,
                roomId: message.roomId,
            });
        }

        const notificationIdByUserId = buildNotificationIdMap(replyNotificationTargets);

        return {
            replyNotificationTargets,
            pushRequest: {
                type: 'reply',
                recipients: missedRecipients.map((userId) => ({
                    userId,
                    notificationId: notificationIdByUserId.get(userId),
                })),
                roomId: message.roomId,
                roomName: message.roomName,
                roomType: message.roomType,
                messageId: message.messageData.id,
                threadId,
                senderId: message.senderId,
                senderUsername: message.senderUsername,
                messageText: message.messageData.text,
            },
        };
    }

    return { prepareMessageDelivery };
}

const defaultMessageDeliveryService = createMessageDeliveryService({
    notificationService: NotificationService,
});

export const prepareMessageDelivery = defaultMessageDeliveryService.prepareMessageDelivery;
