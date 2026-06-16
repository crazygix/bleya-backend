import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { isValidObjectId } from '../utils/validation.js';
import { formatMessage, buildUsernameMap } from '../utils/message.js';
import type { LeanRoom, LeanMessage, LeanUser } from '../types/lean.js';

const router = express.Router();

async function assertCanAccessMessageRoom(userId: string, roomId: mongoose.Types.ObjectId): Promise<void> {
    const [room, hasRoomMembership] = await Promise.all([
        Room.findById(roomId).select('_id type participants').lean<LeanRoom | null>(),
        User.exists({ _id: userId, joinedRooms: roomId }),
    ]);

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    if (!hasRoomMembership) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this room.', 403);
    }

    if ((room.type || 'public') === 'private') {
        const isParticipant = (room.participants || []).some((participantId) => participantId.toString() === userId);
        if (!isParticipant) {
            throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to access this chat.', 403);
        }
    }
}

router.get('/:messageId/thread', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const { messageId } = req.params;

    if (!isValidObjectId(messageId)) {
        throw new ValidationError("That message isn't valid.");
    }

    const parentMessage = await Message.findOne({ _id: messageId, deletedAt: null }).lean<LeanMessage | null>();
    if (!parentMessage) {
        throw new NotFoundError('Message not found', ErrorCode.MESSAGE_NOT_FOUND);
    }
    await assertCanAccessMessageRoom(userId, parentMessage.roomId);

    const replies = await Message.find({ parentMessageId: messageId, deletedAt: null })
        .sort({ createdAt: 1 })
        .lean<LeanMessage[]>();

    const allMessages = [parentMessage, ...replies];
    const userIds = [...new Set(allMessages.map((msg) => msg.userId.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));

    const users = await User.find({ _id: { $in: userIds } })
        .select('_id username')
        .lean<LeanUser[]>();

    const usernameMap = buildUsernameMap(users);

    res.json({
        parentMessage: formatMessage(parentMessage, usernameMap),
        replies: replies.map((msg) => formatMessage(msg, usernameMap)),
    });
}));

router.get('/:messageId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const { messageId } = req.params;

    if (!isValidObjectId(messageId)) {
        throw new ValidationError("That message isn't valid.");
    }

    const message = await Message.findOne({ _id: messageId, deletedAt: null }).lean<LeanMessage | null>();
    if (!message) {
        throw new NotFoundError('Message not found', ErrorCode.MESSAGE_NOT_FOUND);
    }
    await assertCanAccessMessageRoom(userId, message.roomId);

    const user = await User.findById(message.userId).select('_id username').lean<LeanUser | null>();
    const usernameMap = new Map([[message.userId.toString(), user?.username || '']]);

    res.json(formatMessage(message, usernameMap));
}));

export default router;
