import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';

const router = express.Router();

interface LeanMessage {
    _id: mongoose.Types.ObjectId;
    roomId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    text: string;
    createdAt: Date;
    parentMessageId?: mongoose.Types.ObjectId | null;
    replyCount?: number;
}

interface LeanUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
}

router.get('/:messageId/thread', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { messageId } = req.params;

    if (!messageId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid message ID format');
    }

    const parentMessage = await Message.findById(messageId).lean<LeanMessage | null>();
    if (!parentMessage) {
        throw new NotFoundError('Message not found', ErrorCode.ROOM_NOT_FOUND);
    }

    const replies = await Message.find({ parentMessageId: messageId })
        .sort({ createdAt: 1 })
        .lean<LeanMessage[]>();

    const allMessages = [parentMessage, ...replies];
    const userIds = [...new Set(allMessages.map((msg) => msg.userId.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));

    const users = await User.find({ _id: { $in: userIds } })
        .select('_id username')
        .lean<LeanUser[]>();

    const usernameMap = new Map(users.map((u) => [u._id.toString(), u.username || '']));

    const formattedParent = {
        id: parentMessage._id.toString(),
        roomId: parentMessage.roomId.toString(),
        userId: parentMessage.userId.toString(),
        username: usernameMap.get(parentMessage.userId.toString()) || '',
        text: parentMessage.text,
        createdAt: parentMessage.createdAt.getTime(),
        parentMessageId: parentMessage.parentMessageId?.toString() || null,
        replyCount: parentMessage.replyCount || 0,
    };

    const formattedReplies = replies.map((msg) => ({
        id: msg._id.toString(),
        roomId: msg.roomId.toString(),
        userId: msg.userId.toString(),
        username: usernameMap.get(msg.userId.toString()) || '',
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

router.get('/:messageId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { messageId } = req.params;

    if (!messageId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid message ID format');
    }

    const message = await Message.findById(messageId).lean<LeanMessage | null>();
    if (!message) {
        throw new NotFoundError('Message not found', ErrorCode.ROOM_NOT_FOUND);
    }

    const user = await User.findById(message.userId).select('_id username').lean<LeanUser | null>();

    res.json({
        id: message._id.toString(),
        roomId: message.roomId.toString(),
        userId: message.userId.toString(),
        username: user?.username || '',
        text: message.text,
        createdAt: message.createdAt.getTime(),
        parentMessageId: message.parentMessageId?.toString() || null,
        replyCount: message.replyCount || 0,
    });
}));

export default router;
