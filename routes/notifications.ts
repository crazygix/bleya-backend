import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotificationService } from '../services/NotificationService.js';

const router = express.Router();

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
        } else {
            // Try parsing ISO string
            const d = new Date(before);
            if (!isNaN(d.getTime())) {
                parsedBefore = d;
            }
        }
    }

    const result = await NotificationService.getNotifications(userId, parsedLimit, parsedBefore);

    // Format for response
    const formattedNotifications = result.notifications.map((n: any) => {
        let roomName = n.room.name;
        if (n.room.type === 'private' && n.room.participants) {
            const otherParticipant = n.room.participants.find((p: any) =>
                (p._id || p).toString() !== userId.toString()
            );
            if (otherParticipant && typeof otherParticipant === 'object') {
                roomName = otherParticipant.username || roomName;
            }
        }

        return {
            id: n._id.toString(),
            sender: {
                id: n.sender._id.toString(),
                username: n.sender.username,
                profileImageUrl: n.sender.profileImageUrl,
            },
            type: n.type,
            roomId: n.room._id.toString(),
            roomName: roomName,
            roomType: n.room.type || 'public',
            messageId: n.message._id.toString(),
            threadId: n.thread._id.toString(),
            parentMessageText: n.thread ? n.thread.text : null,
            replyText: n.message ? n.message.text : '',
            previewText: n.message ? n.message.text.substring(0, 100) : '',
            read: n.read,
            createdAt: n.createdAt.getTime(),
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

    // Basic regex check or use mongoose check
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
        res.status(400).json({ error: 'Invalid ID' });
        return;
    }

    await NotificationService.markAsRead(id, userId);
    res.json({ success: true });
}));

router.post('/read-all', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    await NotificationService.markAllAsRead(userId);
    res.json({ success: true });
}));

export default router;
