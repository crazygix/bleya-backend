import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';
import logger from '../utils/logger.js';

interface CreateReplyNotificationsParams {
    replyMessageId: string;
    parentMessageId: string;
    senderId: string;
    roomId: string;
    recipientUserIds: string[];
}

interface NotificationInsertPayload {
    recipient: mongoose.Types.ObjectId;
    sender: mongoose.Types.ObjectId;
    type: 'reply';
    room: mongoose.Types.ObjectId;
    message: mongoose.Types.ObjectId;
    thread: mongoose.Types.ObjectId;
}

export interface PopulatedNotificationParticipant {
    _id: mongoose.Types.ObjectId;
    username?: string;
}

export interface PopulatedNotificationRoom {
    _id: mongoose.Types.ObjectId;
    name?: string;
    type?: 'public' | 'private';
    participants?: Array<mongoose.Types.ObjectId | PopulatedNotificationParticipant>;
}

export interface PopulatedNotificationUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
    profileImageUrl?: string;
}

export interface PopulatedNotificationMessage {
    _id: mongoose.Types.ObjectId;
    text?: string;
}

export interface PopulatedNotification {
    _id: mongoose.Types.ObjectId;
    recipient: mongoose.Types.ObjectId;
    sender: PopulatedNotificationUser;
    type: 'reply';
    room: PopulatedNotificationRoom;
    message: PopulatedNotificationMessage;
    thread: PopulatedNotificationMessage;
    read: boolean;
    isDismissed?: boolean;
    createdAt: Date;
    updatedAt: Date;
}

type NotificationsQuery = {
    recipient: string;
    isDismissed: false;
    createdAt?: { $lt: Date };
};

export interface ReplyNotificationEvent {
    targetUserId: string;
    payload: {
        id: string;
        recipient: string;
        sender: {
            id: string;
            username: string;
            profileImageUrl: string | null;
        };
        type: 'reply';
        roomId: string;
        roomName: string;
        roomType: 'public' | 'private';
        messageId: string;
        threadId: string;
        parentMessageText: string | null;
        replyText: string;
        previewText: string;
        read: boolean;
        isDismissed: boolean;
        createdAt: number;
        updatedAt: number;
    };
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

export class NotificationService {
    static async createReplyNotifications({
        replyMessageId,
        parentMessageId,
        senderId,
        roomId,
        recipientUserIds,
    }: CreateReplyNotificationsParams): Promise<UserNotifyTarget[]> {
        const notifications: NotificationInsertPayload[] = [];
        const dedupedRecipients = [...new Set(recipientUserIds)].filter((userId) => userId !== senderId);

        for (const targetUserId of dedupedRecipients) {
            notifications.push({
                recipient: new mongoose.Types.ObjectId(targetUserId),
                sender: new mongoose.Types.ObjectId(senderId),
                type: 'reply',
                room: new mongoose.Types.ObjectId(roomId),
                message: new mongoose.Types.ObjectId(replyMessageId),
                thread: new mongoose.Types.ObjectId(parentMessageId),
            });
        }

        if (notifications.length === 0) {
            return [];
        }

        const insertedNotifications = await Notification.insertMany(notifications);
        return insertedNotifications.map((notification) => ({
            userId: notification.recipient.toString(),
            notificationId: notification._id.toString(),
        }));
    }

    /**
     * Loads the given notifications and builds the per-recipient
     * `new_notification` event payloads. The caller is responsible for the
     * actual transport (emitting to each target's user room).
     */
    static async buildReplyNotificationEvents(
        notificationIds: string[]
    ): Promise<ReplyNotificationEvent[]> {
        const objectIds = notificationIds.map((id) => new mongoose.Types.ObjectId(id));
        if (objectIds.length === 0) {
            return [];
        }

        const populatedNotifications = await Notification.find({ _id: { $in: objectIds } })
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

        return populatedNotifications.map((notification) => {
            const targetUserId = notification.recipient.toString();
            const roomName = resolveNotificationRoomName(notification, targetUserId);

            return {
                targetUserId,
                payload: {
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
                },
            };
        });
    }

    static async getNotifications(userId: string, limit = 20, before?: Date): Promise<{
        notifications: PopulatedNotification[];
        nextCursor: Date | null;
        unreadCount: number;
    }> {
        const query: NotificationsQuery = { recipient: userId, isDismissed: false };
        if (before) {
            query.createdAt = { $lt: before };
        }

        const notificationsQuery = Notification.find(query)
            .select('sender type room message thread read isDismissed createdAt')
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('sender', 'username profileImageUrl')
            .populate({
                path: 'room',
                select: 'name type participants',
                populate: {
                    path: 'participants',
                    select: 'username',
                },
            })
            .populate('message', 'text')
            .populate('thread', 'text')
            .maxTimeMS(7000)
            .lean<PopulatedNotification[]>();

        const unreadCountQuery = Notification.countDocuments({
            recipient: userId,
            isDismissed: false,
            read: false,
        }).maxTimeMS(3000);

        const [notificationsResult, unreadCountResult] = await Promise.allSettled([
            notificationsQuery,
            unreadCountQuery,
        ]);

        if (notificationsResult.status === 'rejected') {
            throw notificationsResult.reason;
        }

        const notifications = notificationsResult.value;
        const unreadCount = unreadCountResult.status === 'fulfilled'
            ? unreadCountResult.value
            : notifications.reduce((count, notification) => (
                notification.read ? count : count + 1
            ), 0);

        if (unreadCountResult.status === 'rejected') {
            const reason = unreadCountResult.reason instanceof Error
                ? unreadCountResult.reason.message
                : String(unreadCountResult.reason);

            logger.warn('notifications.unread_count_fallback', {
                userId,
                reason,
            });
        }

        // Check for more
        const lastNotification = notifications[notifications.length - 1];
        const nextCursor = (notifications.length === limit && lastNotification)
            ? lastNotification.createdAt
            : null;

        return {
            notifications,
            nextCursor,
            unreadCount
        };
    }

    static async markAsRead(notificationId: string, userId: string) {
        return Notification.updateOne(
            { _id: notificationId, recipient: userId },
            { $set: { read: true } }
        );
    }

    static async markAllAsRead(userId: string) {
        return Notification.updateMany(
            { recipient: userId, read: false },
            { $set: { read: true } }
        );
    }

    static async dismissNotification(notificationId: string, userId: string) {
        return Notification.updateOne(
            { _id: notificationId, recipient: userId },
            { $set: { isDismissed: true, read: true } } // Also mark as read if dismissed
        );
    }

    static async dismissAllNotifications(userId: string) {
        return Notification.updateMany(
            { recipient: userId, isDismissed: false },
            { $set: { isDismissed: true, read: true } }
        );
    }
}

export interface UserNotifyTarget {
    userId: string;
    notificationId: string;
}
