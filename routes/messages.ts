// TODO: ARCHITECTURE IMPROVEMENTS
// 1. Extract business logic to services/messageService.ts (see architecture_rules.ts section 9)

import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';

const router = express.Router();

// Get thread replies for a specific message
router.get('/:messageId/thread', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { messageId } = req.params;

    // Validate message ID format
    if (!messageId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid message ID format');
    }

    // Get the parent message
    const parentMessage = await Message.findById(messageId).lean();
    if (!parentMessage) {
        throw new NotFoundError('Message not found', ErrorCode.ROOM_NOT_FOUND);
    }

    // Get all replies to this message
    const replies = await Message.find({ parentMessageId: messageId })
        .sort({ createdAt: 1 })
        .lean();

    // Fetch usernames for all unique user IDs (parent + replies)
    const allMessages = [parentMessage, ...replies];
    const userIds = [...new Set(allMessages.map((msg: any) => msg.userId))];
    const users = await User.find({ _id: { $in: userIds } }).select('_id username').lean();
    const usernameMap = new Map(users.map((u: any) => [u._id.toString(), u.username || '']));

    // Format parent message
    const formattedParent = {
        id: parentMessage._id.toString(),
        roomId: parentMessage.roomId.toString(),
        userId: parentMessage.userId,
        username: usernameMap.get(parentMessage.userId) || '',
        text: parentMessage.text,
        createdAt: parentMessage.createdAt.getTime(),
        parentMessageId: (parentMessage as any).parentMessageId?.toString() || null,
        replyCount: (parentMessage as any).replyCount || 0,
    };

    // Format replies
    const formattedReplies = replies.map((msg: any) => ({
        id: msg._id.toString(),
        roomId: msg.roomId.toString(),
        userId: msg.userId,
        username: usernameMap.get(msg.userId) || '',
        text: msg.text,
        createdAt: msg.createdAt.getTime(),
        parentMessageId: msg.parentMessageId?.toString() || null,
        replyCount: msg.replyCount || 0,
    }));

    res.json({
        parentMessage: formattedParent,
        replies: formattedReplies,
    });
}));

export default router;

