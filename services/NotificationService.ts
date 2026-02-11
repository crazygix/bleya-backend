import mongoose from 'mongoose';
import { Notification } from '../models/Notification.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';

interface CreateReplyNotificationParams {
    replyMessageId: string;
    parentMessageId: string;
    senderId: string;
    roomId: string;
}

export class NotificationService {
    static async createReplyNotification({
        replyMessageId,
        parentMessageId,
        senderId,
        roomId,
    }: CreateReplyNotificationParams): Promise<UserNotifyTarget[]> {
        const parentMessage = await Message.findById(parentMessageId);
        if (!parentMessage) {
            return [];
        }

        const targets = new Set<string>();

        // 1. Notify the author of the parent message (if not the sender)
        if (parentMessage.userId.toString() !== senderId) {
            targets.add(parentMessage.userId.toString());
        }

        // 2. Notify other participants in the thread?
        // For now, let's stick to just the parent message author to avoid noise,
        // or we could check who else replied.
        // Let's also notify people who have replied to this thread previously.
        const otherReplies = await Message.find({
            parentMessageId,
            userId: { $ne: senderId }, // Exclude current sender
        }).distinct('userId'); // Get unique user IDs

        for (const userId of otherReplies) {
            if (userId.toString() !== senderId) {
                targets.add(userId.toString());
            }
        }

        const notifications: any[] = [];
        const resultTargets: UserNotifyTarget[] = [];

        for (const targetUserId of targets) {
            // Check if user is still in the room? (Optimization, maybe not strictly necessary but good practice)
            // We can assume they are interested if they participated.

            const notification = new Notification({
                recipient: targetUserId,
                sender: senderId,
                type: 'reply',
                room: roomId,
                message: replyMessageId,
                thread: parentMessageId,
            });
            notifications.push(notification);
            resultTargets.push({ userId: targetUserId, notification });
        }

        if (notifications.length > 0) {
            await Notification.insertMany(notifications);
        }

        return resultTargets;
    }

    static async getNotifications(userId: string, limit = 20, before?: Date) {
        const query: any = { recipient: userId };
        if (before) {
            query.createdAt = { $lt: before };
        }

        const notifications = await Notification.find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .populate('sender', 'username profileImageUrl')
            .populate('room', 'name type')
            .populate('message', 'text') // The reply content
            .lean();

        // Check for more
        const lastNotification = notifications[notifications.length - 1];
        const nextCursor = lastNotification ? lastNotification.createdAt : null;

        // Count unread
        const unreadCount = await Notification.countDocuments({ recipient: userId, read: false });

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
}

export interface UserNotifyTarget {
    userId: string;
    notification: any;
}
