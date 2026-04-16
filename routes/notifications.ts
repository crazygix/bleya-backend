import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
    NotificationService,
    PopulatedNotification,
    PopulatedNotificationParticipant,
} from '../services/NotificationService.js';
import { registerPushToken, unregisterPushToken } from '../services/pushNotificationService.js';
import { ValidationError } from '../utils/errors.js';

const router = express.Router();
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const PUSH_PLATFORMS = new Set(['ios', 'android']);

function getParticipantMeta(
    participant: mongoose.Types.ObjectId | PopulatedNotificationParticipant
): { id: string; username?: string } {
    if (participant instanceof mongoose.Types.ObjectId) {
        return { id: participant.toString() };
    }

    return {
        id: participant._id.toString(),
        username: participant.username,
    };
}

function resolveDirectRoomName(
    notification: PopulatedNotification,
    currentUserId: string
): string {
    const room = notification.room;
    const fallbackName = room.name || 'Unknown Room';
    if (room.type !== 'private' || !room.participants) {
        return fallbackName;
    }

    const otherParticipant = room.participants
        .map(getParticipantMeta)
        .find((participant) => participant.id !== currentUserId);

    if (!otherParticipant) {
        return fallbackName;
    }

    return otherParticipant.username || fallbackName;
}

function parsePushToken(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError('Push token is required');
    }

    return value.trim();
}

function parsePushPlatform(value: unknown): 'ios' | 'android' {
    if (typeof value !== 'string' || !PUSH_PLATFORMS.has(value)) {
        throw new ValidationError('Push platform must be "ios" or "android"');
    }

    return value as 'ios' | 'android';
}

router.post('/push/register', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const token = parsePushToken(req.body?.token);
    const platform = parsePushPlatform(req.body?.platform);

    await registerPushToken({
        userId,
        token,
        platform,
    });

    res.json({ success: true });
}));

router.post('/push/unregister', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const token = parsePushToken(req.body?.token);

    await unregisterPushToken({
        userId,
        token,
    });

    res.json({ success: true });
}));

router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const { limit, before } = req.query;

    let parsedLimit = 20;
    if (typeof limit === 'string') {
        const n = parseInt(limit, 10);
        if (!isNaN(n) && n > 0 && n <= 50) {
            parsedLimit = n;
        }
    }

    let parsedBefore: Date | undefined;
    if (typeof before === 'string') {
        const ts = parseInt(before, 10);
        if (!isNaN(ts)) {
            parsedBefore = new Date(ts);
        }
    }

    const result = await NotificationService.getNotifications(userId, parsedLimit, parsedBefore);

    const formattedNotifications = result.notifications.map((notification) => {
        const roomName = resolveDirectRoomName(notification, userId);
        return {
            id: notification._id.toString(),
            sender: {
                id: notification.sender._id.toString(),
                username: notification.sender.username || '',
                profileImageUrl: notification.sender.profileImageUrl || null,
            },
            type: notification.type,
            roomId: notification.room._id.toString(),
            roomName,
            roomType: notification.room.type || 'public',
            messageId: notification.message._id.toString(),
            threadId: notification.thread._id.toString(),
            parentMessageText: notification.thread?.text || null,
            replyText: notification.message?.text || '',
            previewText: notification.message?.text ? notification.message.text.substring(0, 100) : '',
            read: notification.read,
            isDismissed: notification.isDismissed || false,
            createdAt: notification.createdAt.getTime(),
        };
    });

    res.json({
        notifications: formattedNotifications,
        unreadCount: result.unreadCount,
        nextCursor: result.nextCursor ? result.nextCursor.getTime() : null,
    });
}));

router.post('/:id/read', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const { id } = req.params;

    if (!OBJECT_ID_REGEX.test(id)) {
        throw new ValidationError('Invalid notification ID format');
    }

    await NotificationService.markAsRead(id, userId);
    res.json({ success: true });
}));

router.post('/read-all', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    await NotificationService.markAllAsRead(userId);
    res.json({ success: true });
}));

router.post('/:id/dismiss', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const { id } = req.params;

    if (!OBJECT_ID_REGEX.test(id)) {
        throw new ValidationError('Invalid notification ID format');
    }

    await NotificationService.dismissNotification(id, userId);
    res.json({ success: true });
}));

router.post('/dismiss-all', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    await NotificationService.dismissAllNotifications(userId);
    res.json({ success: true });
}));

export default router;
