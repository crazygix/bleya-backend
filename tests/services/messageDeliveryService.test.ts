import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CreateMessageResult } from '../../services/messageService.js';
import { createMessageDeliveryService } from '../../services/messageDeliveryService.js';

function buildMessageResult(overrides: Partial<CreateMessageResult> = {}): CreateMessageResult {
    return {
        messageData: {
            id: 'message-1',
            roomId: 'room-1',
            userId: 'sender-1',
            username: 'sender',
            text: 'Hello world',
            createdAt: Date.now(),
            parentMessageId: null,
            replyCount: 0,
        },
        pushType: 'message',
        candidateRecipientUserIds: [],
        isTopLevel: true,
        roomId: 'room-1',
        roomName: 'General',
        roomType: 'public',
        roomParticipants: [],
        threadId: null,
        senderId: 'sender-1',
        senderUsername: 'sender',
        ...overrides,
    };
}

describe('messageDeliveryService', () => {
    it('prepares top-level push only for users not active in the room', async () => {
        const service = createMessageDeliveryService({
            notificationService: {
                createReplyNotifications: async () => [],
            },
        });

        const result = await service.prepareMessageDelivery(
            buildMessageResult({
                pushType: 'message',
                candidateRecipientUserIds: ['active-user', 'offline-user'],
            }),
            {
                isUserActiveInRoom: (userId) => userId === 'active-user',
                isUserActiveInThread: () => false,
            }
        );

        assert.deepEqual(result.replyNotificationTargets, []);
        assert.deepEqual(result.pushRequest, {
            type: 'message',
            recipients: [{ userId: 'offline-user' }],
            roomId: 'room-1',
            roomName: 'General',
            roomType: 'public',
            messageId: 'message-1',
            threadId: null,
            senderId: 'sender-1',
            senderUsername: 'sender',
            messageText: 'Hello world',
        });
    });

    it('prepares reply push and missed-only alerts for users not active in the thread', async () => {
        const service = createMessageDeliveryService({
            notificationService: {
                createReplyNotifications: async (input) => input.recipientUserIds.map((userId) => ({
                    userId,
                    notificationId: `notification-${userId}`,
                })),
            },
        });

        const result = await service.prepareMessageDelivery(
            buildMessageResult({
                pushType: 'reply',
                isTopLevel: false,
                candidateRecipientUserIds: ['active-thread-user', 'missed-user'],
                threadId: 'thread-1',
                messageData: {
                    id: 'reply-1',
                    roomId: 'room-1',
                    userId: 'sender-1',
                    username: 'sender',
                    text: 'Fresh reply',
                    createdAt: Date.now(),
                    parentMessageId: 'thread-1',
                    replyCount: 0,
                },
            }),
            {
                isUserActiveInRoom: () => false,
                isUserActiveInThread: (userId) => userId === 'active-thread-user',
            }
        );

        assert.deepEqual(result.replyNotificationTargets, [{
            userId: 'missed-user',
            notificationId: 'notification-missed-user',
        }]);

        assert.deepEqual(result.pushRequest, {
            type: 'reply',
            recipients: [{
                userId: 'missed-user',
                notificationId: 'notification-missed-user',
            }],
            roomId: 'room-1',
            roomName: 'General',
            roomType: 'public',
            messageId: 'reply-1',
            threadId: 'thread-1',
            senderId: 'sender-1',
            senderUsername: 'sender',
            messageText: 'Fresh reply',
        });
    });

    it('still prepares reply push when alert persistence fails', async () => {
        const service = createMessageDeliveryService({
            notificationService: {
                createReplyNotifications: async () => {
                    throw new Error('db failure');
                },
            },
        });

        const result = await service.prepareMessageDelivery(
            buildMessageResult({
                pushType: 'reply',
                isTopLevel: false,
                candidateRecipientUserIds: ['missed-user'],
                threadId: 'thread-1',
                messageData: {
                    id: 'reply-2',
                    roomId: 'room-1',
                    userId: 'sender-1',
                    username: 'sender',
                    text: 'Reply without alert row',
                    createdAt: Date.now(),
                    parentMessageId: 'thread-1',
                    replyCount: 0,
                },
            }),
            {
                isUserActiveInRoom: () => false,
                isUserActiveInThread: () => false,
            }
        );

        assert.deepEqual(result.replyNotificationTargets, []);
        assert.deepEqual(result.pushRequest, {
            type: 'reply',
            recipients: [{ userId: 'missed-user', notificationId: undefined }],
            roomId: 'room-1',
            roomName: 'General',
            roomType: 'public',
            messageId: 'reply-2',
            threadId: 'thread-1',
            senderId: 'sender-1',
            senderUsername: 'sender',
            messageText: 'Reply without alert row',
        });
    });
});
