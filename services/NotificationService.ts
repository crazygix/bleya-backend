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
