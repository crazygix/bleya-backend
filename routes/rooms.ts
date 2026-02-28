import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { UserBlock } from '../models/UserBlock.js';
import {
    joinRoomForUser,
    listPublicRooms,
} from '../services/roomService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { validateObjectId } from '../utils/validation.js';
import { toRoomLocation, isPrivateRoomParticipant } from '../utils/room.js';
import { formatMessage, buildUsernameMap } from '../utils/message.js';
import type { LeanRoom, LeanMessage, LeanUser, LeanUserBlock, LeanJoinedRoomsUser, LastMessageAgg } from '../types/lean.js';
import logger from '../utils/logger.js';

const router = express.Router();

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function buildDirectParticipantsHash(currentUserId: string, otherUserId: string): string {
    return [currentUserId, otherUserId].sort().join('_');
}

async function findExistingDirectRoom(currentUserId: string, otherUserId: string): Promise<LeanRoom | null> {
    const participantsHash = buildDirectParticipantsHash(currentUserId, otherUserId);
    return Room.findOne({
        type: 'private',
        participantsHash,
    }).lean<LeanRoom | null>();
}

async function getDirectBlockState(currentUserId: string, otherUserId: string): Promise<{
    isBlockedByMe: boolean;
    isBlockedByOtherUser: boolean;
}> {
    const currentUserObjectId = new mongoose.Types.ObjectId(currentUserId);
    const otherUserObjectId = new mongoose.Types.ObjectId(otherUserId);

    const blocks = await UserBlock.find({
        isActive: true,
        $or: [
            {
                blockerUserId: currentUserObjectId,
                blockedUserId: otherUserObjectId,
            },
            {
                blockerUserId: otherUserObjectId,
                blockedUserId: currentUserObjectId,
            },
        ],
    }).select('_id blockerUserId blockedUserId roomId isActive blockedAt').lean<LeanUserBlock[]>();

    let isBlockedByMe = false;
    let isBlockedByOtherUser = false;

    for (const block of blocks) {
        if (block.blockerUserId.toString() === currentUserId) {
            isBlockedByMe = true;
        } else if (block.blockerUserId.toString() === otherUserId) {
            isBlockedByOtherUser = true;
        }
    }

    return {
        isBlockedByMe,
        isBlockedByOtherUser,
    };
}

function parseSearchQuery(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new ValidationError('search must be a string.');
    }

    const sanitized = sanitizePlainText(value, {
        maxLength: 80,
        collapseWhitespace: true,
        escapeHtml: false,
    });

    return sanitized.length > 0 ? sanitized : undefined;
}

function assertUserHasRoomAccess(
    room: LeanRoom,
    roomObjectId: mongoose.Types.ObjectId,
    user: LeanJoinedRoomsUser,
    userId: string
): void {
    const isJoined = (user.joinedRooms || []).some((joinedRoomId) => joinedRoomId.equals(roomObjectId));
    if (!isJoined) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this room.', 403);
    }

    if (!isPrivateRoomParticipant(room, userId)) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to access this chat.', 403);
    }
}



router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const searchQuery = parseSearchQuery(req.query.search ?? req.query.q);
    const rooms = await listPublicRooms({ searchQuery });
    res.json(rooms);
}));

router.get('/joined', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const user = await User.findById(userId)
        .select('joinedRooms hiddenDirectRooms roomReadPointers')
        .lean<LeanJoinedRoomsUser | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const allJoinedRoomIds = user.joinedRooms || [];
    if (allJoinedRoomIds.length === 0) {
        res.json([]);
        return;
    }

    const roomsRaw = await Room.find({ _id: { $in: allJoinedRoomIds } }).lean<LeanRoom[]>();
    const hiddenDirectRoomIdSet = new Set((user.hiddenDirectRooms || []).map((roomId) => roomId.toString()));

    const rooms = roomsRaw.filter((room) => !(
        room.type === 'private'
        && hiddenDirectRoomIdSet.has(room._id.toString())
    ));

    if (rooms.length === 0) {
        res.json([]);
        return;
    }

    const joinedRoomIds = rooms.map((room) => room._id);

    const lastMessagesRaw = await Message.aggregate([
        { $match: { roomId: { $in: joinedRoomIds }, parentMessageId: null } },
        { $sort: { createdAt: -1 } },
        {
            $group: {
                _id: '$roomId',
                lastMessageText: { $first: '$text' },
                lastMessageTime: { $first: '$createdAt' },
                lastMessageUserId: { $first: '$userId' },
            },
        },
    ]);

    const lastMessages = lastMessagesRaw as LastMessageAgg[];
    const lastMessageMap = new Map(lastMessages.map((msg) => [msg._id.toString(), msg]));
    const currentUserObjectId = new mongoose.Types.ObjectId(userId);

    const lastReadAtByRoomId = new Map<string, Date>();
    for (const pointer of user.roomReadPointers || []) {
        if (!pointer.roomId || !pointer.lastReadAt) {
            continue;
        }

        const roomId = pointer.roomId.toString();
        const currentLastReadAt = lastReadAtByRoomId.get(roomId);
        if (!currentLastReadAt || pointer.lastReadAt > currentLastReadAt) {
            lastReadAtByRoomId.set(roomId, pointer.lastReadAt);
        }
    }

    const unreadMatchConditions = joinedRoomIds.map((roomId) => {
        const lastReadAt = lastReadAtByRoomId.get(roomId.toString());
        const condition: Record<string, unknown> = {
            roomId,
            parentMessageId: null,
            userId: { $ne: currentUserObjectId },
        };
        if (lastReadAt) {
            condition.createdAt = { $gt: lastReadAt };
        }
        return condition;
    });

    const unreadCountByRoomId = new Map<string, number>();
    if (unreadMatchConditions.length > 0) {
        const unreadCounts = await Message.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
            { $match: { $or: unreadMatchConditions } },
            { $group: { _id: '$roomId', count: { $sum: 1 } } },
        ]);
        for (const { _id, count } of unreadCounts) {
            unreadCountByRoomId.set(_id.toString(), count);
        }
    }

    const userIdSet = new Set<string>();

    for (const room of rooms) {
        if (room.type === 'private' && room.participants) {
            for (const participantId of room.participants) {
                const participantIdStr = participantId.toString();
                if (participantIdStr !== userId) {
                    userIdSet.add(participantIdStr);
                }
            }
        }
    }

    for (const msg of lastMessages) {
        if (msg.lastMessageUserId) {
            userIdSet.add(msg.lastMessageUserId.toString());
        }
    }

    const userIds = Array.from(userIdSet).map((id) => new mongoose.Types.ObjectId(id));
    const users = userIds.length > 0
        ? await User.find({ _id: { $in: userIds } }).select('_id username profileImageUrl').lean<LeanUser[]>()
        : [];

    const userMap = new Map(users.map((u) => [u._id.toString(), { username: u.username || '', profileImageUrl: u.profileImageUrl || '' }]));

    const joinedRooms = rooms.map((room) => {
        let roomName = room.name;
        let otherUserId: string | null = null;
        let imageUrl: string | null = room.imageUrl || null;

        if (room.type === 'private' && room.participants) {
            const otherParticipant = room.participants.find((id) => id.toString() !== userId);
            if (otherParticipant) {
                const participantIdStr = otherParticipant.toString();
                const otherUserData = userMap.get(participantIdStr);
                roomName = otherUserData?.username || 'Unknown User';
                imageUrl = otherUserData?.profileImageUrl || null;
                otherUserId = participantIdStr;
            }
        }

        const lastMessage = lastMessageMap.get(room._id.toString());
        const lastMessageTime = lastMessage?.lastMessageTime ? lastMessage.lastMessageTime.getTime() : null;
        const lastMessageUserId = lastMessage?.lastMessageUserId?.toString() || null;
        const roomLocation = toRoomLocation(room);

        return {
            id: room._id.toString(),
            name: roomName,
            type: room.type || 'public',
            cityKey: room.cityKey || null,
            participants: (room.participants || []).map((participant) => participant.toString()),
            otherUserId,
            imageUrl,
            location: roomLocation,
            lastMessageText: lastMessage?.lastMessageText || null,
            lastMessageTime,
            lastMessageUserId,
            lastMessageUsername: lastMessageUserId ? userMap.get(lastMessageUserId.toString())?.username || 'Unknown' : null,
            unreadCount: unreadCountByRoomId.get(room._id.toString()) ?? 0,
        };
    });

    joinedRooms.sort((a, b) => {
        const aTime = a.lastMessageTime || 0;
        const bTime = b.lastMessageTime || 0;
        return bTime - aTime;
    });

    res.json(joinedRooms);
}));

router.post('/:roomId/join', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const response = await joinRoomForUser({
        userId,
        roomId: roomObjectId,
    });

    res.json(response);
}));

router.get('/:roomId/messages', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const { before, limit } = req.query;

    const [room, user] = await Promise.all([
        Room.findById(roomObjectId).select('_id type participants').lean<LeanRoom | null>(),
        User.findById(userId).select('joinedRooms').lean<LeanJoinedRoomsUser | null>(),
    ]);

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
    assertUserHasRoomAccess(room, roomObjectId, user, userId);

    let pageSize = DEFAULT_PAGE_SIZE;
    if (typeof limit === 'string') {
        const parsedLimit = Number.parseInt(limit, 10);
        if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
            pageSize = Math.min(parsedLimit, MAX_PAGE_SIZE);
        }
    }

    const filter: {
        roomId: mongoose.Types.ObjectId;
        parentMessageId: null;
        $or?: Array<{ createdAt: { $lt: Date } } | { createdAt: Date; _id: { $lt: mongoose.Types.ObjectId } }>;
        createdAt?: { $lt: Date };
    } = {
        roomId: roomObjectId,
        parentMessageId: null,
    };

    if (typeof before === 'string') {
        const [timestampStr, idStr] = before.split('_');
        const timestamp = Number(timestampStr);

        if (!Number.isNaN(timestamp)) {
            const beforeDate = new Date(timestamp);
            if (idStr && OBJECT_ID_REGEX.test(idStr)) {
                // Compound cursor: fetched messages before (timestamp, id)
                filter.$or = [
                    { createdAt: { $lt: beforeDate } },
                    { createdAt: beforeDate, _id: { $lt: new mongoose.Types.ObjectId(idStr) } }
                ];
            } else {
                // Legacy cursor fallback (just timestamp)
                filter.createdAt = { $lt: beforeDate };
            }
        }
    }

    const rawMessages = await Message.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageSize + 1)
        .lean<LeanMessage[]>();

    const hasMore = rawMessages.length > pageSize;
    const pageMessages = hasMore ? rawMessages.slice(0, pageSize) : rawMessages;

    const userIds = [...new Set(pageMessages.map((msg) => msg.userId.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));

    const users = userIds.length > 0
        ? await User.find({ _id: { $in: userIds } }).select('_id username').lean<LeanUser[]>()
        : [];

    const usernameMap = buildUsernameMap(users);
    const formattedMessages = pageMessages.reverse().map((msg) => formatMessage(msg, usernameMap));

    let nextCursor: string | null = null;
    if (pageMessages.length > 0) {
        const oldestMessage = pageMessages[pageMessages.length - 1];
        nextCursor = `${oldestMessage.createdAt.getTime()}_${oldestMessage._id.toString()}`;
    }

    res.json({
        messages: formattedMessages,
        pagination: {
            hasMore,
            nextCursor,
        },
    });
}));

router.get('/:roomId/members', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const [room, user] = await Promise.all([
        Room.findById(roomObjectId).select('_id type participants').lean<LeanRoom | null>(),
        User.findById(userId).select('joinedRooms').lean<LeanJoinedRoomsUser | null>(),
    ]);

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
    assertUserHasRoomAccess(room, roomObjectId, user, userId);

    const users = await User.find({ joinedRooms: roomObjectId })
        .select('_id username bio profileImageUrl')
        .lean<LeanUser[]>();

    const members = users.map((user) => ({
        id: user._id.toString(),
        username: user.username || '',
        bio: user.bio || '',
        profileImageUrl: user.profileImageUrl || '',
    }));

    members.sort((a, b) => {
        const usernameComparison = a.username.localeCompare(
            b.username,
            undefined,
            { sensitivity: 'base' }
        );

        if (usernameComparison !== 0) {
            return usernameComparison;
        }

        return a.id.localeCompare(b.id);
    });

    res.json(members);
}));

router.post('/:roomId/leave', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const updateResult = await User.updateOne(
        { _id: userId },
        { $pull: { joinedRooms: roomObjectId } }
    );

    if (updateResult.matchedCount === 0) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    res.json({ message: 'Successfully left room' });
}));

router.post('/:roomId/read', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const room = await Room.findById(roomObjectId).select('_id type participants').lean<LeanRoom | null>();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }
    if (!isPrivateRoomParticipant(room, userId)) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to access this chat.', 403);
    }

    const user = await User.findById(userId).select('joinedRooms').lean<{ joinedRooms: mongoose.Types.ObjectId[] } | null>();
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const isJoined = user.joinedRooms.some((id) => id.equals(roomObjectId));
    if (!isJoined) {
        throw new ValidationError('You are not a member of this room.');
    }

    const now = new Date();

    const updatedExisting = await User.updateOne(
        {
            _id: userId,
            'roomReadPointers.roomId': roomObjectId,
        },
        {
            $set: {
                'roomReadPointers.$.lastReadAt': now,
            },
        }
    );

    if (updatedExisting.matchedCount === 0) {
        const inserted = await User.updateOne(
            {
                _id: userId,
                roomReadPointers: {
                    $not: { $elemMatch: { roomId: roomObjectId } },
                },
            },
            {
                $push: {
                    roomReadPointers: {
                        roomId: roomObjectId,
                        lastReadAt: now,
                    },
                },
            }
        );

        if (inserted.matchedCount === 0) {
            await User.updateOne(
                {
                    _id: userId,
                    'roomReadPointers.roomId': roomObjectId,
                },
                {
                    $set: {
                        'roomReadPointers.$.lastReadAt': now,
                    },
                }
            );
        }
    }

    res.json({
        message: 'Room marked as read',
        lastReadAt: now.getTime(),
    });
}));

router.get('/direct/:otherUserId/status', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't open chat status for yourself.");
    }

    const [otherUserExists, currentUser, room, blockState] = await Promise.all([
        User.exists({ _id: otherUserId }),
        User.findById(currentUserId).select('hiddenDirectRooms').lean<{ hiddenDirectRooms?: mongoose.Types.ObjectId[] } | null>(),
        findExistingDirectRoom(currentUserId, otherUserId),
        getDirectBlockState(currentUserId, otherUserId),
    ]);

    if (!otherUserExists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (!currentUser) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const roomId = room?._id.toString() || null;
    const isDeletedByMe = roomId
        ? (currentUser.hiddenDirectRooms || []).some((id) => id.toString() === roomId)
        : false;

    res.json({
        hasChat: !!room,
        roomId,
        isBlockedByMe: blockState.isBlockedByMe,
        isBlockedByOtherUser: blockState.isBlockedByOtherUser,
        canSendMessage: !blockState.isBlockedByMe && !blockState.isBlockedByOtherUser,
        isDeletedByMe,
    });
}));

router.post('/direct/:otherUserId/delete', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't delete a chat with yourself.");
    }

    const [otherUserExists, room] = await Promise.all([
        User.exists({ _id: otherUserId }),
        findExistingDirectRoom(currentUserId, otherUserId),
    ]);

    if (!otherUserExists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (!room) {
        res.json({
            message: 'No direct chat found.',
            hasChat: false,
            roomId: null,
            deleted: false,
        });
        return;
    }

    await User.updateOne(
        { _id: currentUserId },
        { $addToSet: { hiddenDirectRooms: room._id } }
    );

    logger.info('dm.chat_deleted_for_user', {
        userId: currentUserId,
        otherUserId,
        roomId: room._id.toString(),
    });

    res.json({
        message: 'Chat removed from your list.',
        hasChat: true,
        roomId: room._id.toString(),
        deleted: true,
    });
}));

router.post('/direct/:otherUserId/block', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't block yourself.");
    }

    const [otherUserExists, room] = await Promise.all([
        User.exists({ _id: otherUserId }),
        findExistingDirectRoom(currentUserId, otherUserId),
    ]);

    if (!otherUserExists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (!room) {
        throw new ValidationError('You can only block users you already have a chat with.');
    }

    const blockerUserObjectId = new mongoose.Types.ObjectId(currentUserId);
    const blockedUserObjectId = new mongoose.Types.ObjectId(otherUserId);
    const now = new Date();

    const upsertResult = await UserBlock.updateOne(
        {
            blockerUserId: blockerUserObjectId,
            blockedUserId: blockedUserObjectId,
            isActive: true,
        },
        {
            $setOnInsert: {
                roomId: room._id,
                blockedAt: now,
                source: 'user_action',
                isActive: true,
                unblockedAt: null,
            },
        },
        { upsert: true }
    );

    await User.updateOne(
        { _id: currentUserId },
        { $addToSet: { hiddenDirectRooms: room._id } }
    );

    const alreadyBlocked = upsertResult.upsertedCount === 0;

    logger.info('dm.user_blocked', {
        blockerUserId: currentUserId,
        blockedUserId: otherUserId,
        roomId: room._id.toString(),
        alreadyBlocked,
    });

    res.json({
        message: alreadyBlocked ? 'User already blocked.' : 'User blocked.',
        roomId: room._id.toString(),
        blocked: true,
        alreadyBlocked,
    });
}));

router.post('/direct/:otherUserId/unblock', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't unblock yourself.");
    }

    const otherUserExists = await User.exists({ _id: otherUserId });
    if (!otherUserExists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const blockerUserObjectId = new mongoose.Types.ObjectId(currentUserId);
    const blockedUserObjectId = new mongoose.Types.ObjectId(otherUserId);

    const activeBlocks = await UserBlock.find({
        blockerUserId: blockerUserObjectId,
        blockedUserId: blockedUserObjectId,
        isActive: true,
    }).select('_id roomId').lean<Array<{ _id: mongoose.Types.ObjectId; roomId: mongoose.Types.ObjectId }>>();

    if (activeBlocks.length === 0) {
        res.json({
            message: 'User is not blocked.',
            roomId: null,
            blocked: false,
            alreadyBlocked: false,
        });
        return;
    }

    const now = new Date();
    const activeBlockIds = activeBlocks.map((block) => block._id);
    const roomIds = [...new Set(activeBlocks.map((block) => block.roomId.toString()))]
        .map((roomId) => new mongoose.Types.ObjectId(roomId));

    await UserBlock.updateMany(
        {
            _id: { $in: activeBlockIds },
            isActive: true,
        },
        {
            $set: {
                isActive: false,
                unblockedAt: now,
            },
        }
    );

    if (roomIds.length > 0) {
        await User.updateOne(
            { _id: currentUserId },
            { $pull: { hiddenDirectRooms: { $in: roomIds } } }
        );
    }

    logger.info('dm.user_unblocked', {
        blockerUserId: currentUserId,
        unblockedUserId: otherUserId,
        roomIds: roomIds.map((roomId) => roomId.toString()),
    });

    res.json({
        message: 'User unblocked.',
        roomId: roomIds[0]?.toString() || null,
        blocked: false,
        alreadyBlocked: false,
    });
}));

router.post('/direct/:otherUserId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't message yourself.");
    }

    const [otherUser, currentUser, blockState] = await Promise.all([
        User.findById(otherUserId).select('_id username profileImageUrl').lean<LeanUser | null>(),
        User.findById(currentUserId).select('_id username').lean<LeanUser | null>(),
        getDirectBlockState(currentUserId, otherUserId),
    ]);

    if (!otherUser || !currentUser) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (blockState.isBlockedByMe) {
        throw new AppError(
            ErrorCode.USER_BLOCKED,
            'You blocked this user. Unblock them to message again.',
            403
        );
    }

    if (blockState.isBlockedByOtherUser) {
        throw new AppError(
            ErrorCode.USER_BLOCKED,
            'This user is unavailable for direct messages.',
            403
        );
    }

    const participants = [currentUserId, otherUserId].sort();
    const participantsHash = participants.join('_');

    const room = await Room.findOneAndUpdate(
        {
            type: 'private',
            participantsHash,
        },
        {
            $setOnInsert: {
                name: `DM: ${currentUser.username || currentUserId} & ${otherUser.username || otherUserId}`,
                type: 'private',
                participants: participants.map((id) => new mongoose.Types.ObjectId(id)),
                participantsHash,
            },
        },
        {
            upsert: true,
            new: true,
        }
    );

    if (!room) {
        throw new Error('Failed to create or fetch direct message room');
    }

    const roomObjectId = room._id as mongoose.Types.ObjectId;

    await Promise.all([
        User.updateOne(
            { _id: currentUserId },
            {
                $addToSet: { joinedRooms: roomObjectId },
                $pull: { hiddenDirectRooms: roomObjectId },
            }
        ),
        User.updateOne({ _id: otherUserId }, { $addToSet: { joinedRooms: roomObjectId } }),
    ]);

    res.json({
        message: 'Direct message room ready',
        room: {
            id: room._id.toString(),
            name: otherUser.username || 'Unknown User',
            type: room.type,
            participants: (room.participants || []).map((participant) => participant.toString()),
            imageUrl: otherUser?.profileImageUrl || null,
            otherUserId,
        },
    });
}));

router.get('/:roomId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const [room, user] = await Promise.all([
        Room.findById(roomObjectId).lean<LeanRoom | null>(),
        User.findById(userId).select('joinedRooms').lean<LeanJoinedRoomsUser | null>(),
    ]);

    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
    assertUserHasRoomAccess(room, roomObjectId, user, userId);

    let roomName = room.name;
    let otherUserId: string | null = null;
    let imageUrl: string | null = room.imageUrl || null;

    if (room.type === 'private' && room.participants) {
        const otherParticipant = room.participants.find((id) => id.toString() !== userId);
        if (otherParticipant) {
            const participantIdStr = otherParticipant.toString();
            const otherUser = await User.findById(participantIdStr).select('username profileImageUrl').lean<LeanUser | null>();
            roomName = otherUser?.username || 'Unknown User';
            imageUrl = otherUser?.profileImageUrl || null;
            otherUserId = participantIdStr;
        }
    }

    res.json({
        id: room._id.toString(),
        name: roomName,
        type: room.type || 'public',
        cityKey: room.cityKey || null,
        imageUrl,
        location: toRoomLocation(room),
        participants: (room.participants || []).map((participant) => participant.toString()),
        otherUserId,
    });
}));

export default router;
