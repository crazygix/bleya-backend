import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';

const router = express.Router();

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const MAX_PUBLIC_ROOMS = 5;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    type?: 'public' | 'private';
    participants?: mongoose.Types.ObjectId[];
}

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
    phoneNumber?: string;
    profileImageUrl?: string;
}

interface RoomReadPointer {
    roomId: mongoose.Types.ObjectId;
    lastReadAt?: Date | null;
}

interface LeanJoinedRoomsUser {
    joinedRooms: mongoose.Types.ObjectId[];
    roomReadPointers?: RoomReadPointer[];
}

interface LastMessageAgg {
    _id: mongoose.Types.ObjectId;
    lastMessageText?: string;
    lastMessageTime?: Date;
    lastMessageUserId?: mongoose.Types.ObjectId;
}

function validateObjectId(id: string, fieldName: string): mongoose.Types.ObjectId {
    if (!OBJECT_ID_REGEX.test(id)) {
        throw new ValidationError(`Invalid ${fieldName} format`);
    }
    return new mongoose.Types.ObjectId(id);
}

router.get('/', authenticateUser, asyncHandler(async (_req: AuthRequest, res: express.Response) => {
    const rooms = await Room.find({ type: 'public' })
        .sort({ name: 1 })
        .lean<LeanRoom[]>();

    res.json(rooms.map((room) => ({
        id: room._id.toString(),
        name: room.name,
        type: room.type || 'public',
    })));
}));

router.get('/joined', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const user = await User.findById(userId)
        .select('joinedRooms roomReadPointers')
        .lean<LeanJoinedRoomsUser | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const joinedRoomIds = user.joinedRooms || [];
    if (joinedRoomIds.length === 0) {
        res.json([]);
        return;
    }

    const rooms = await Room.find({ _id: { $in: joinedRoomIds } }).lean<LeanRoom[]>();

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

    const unreadCountEntries = await Promise.all(joinedRoomIds.map(async (roomId) => {
        const roomIdStr = roomId.toString();
        const roomLastReadAt = lastReadAtByRoomId.get(roomIdStr);

        const unreadFilter: {
            roomId: mongoose.Types.ObjectId;
            parentMessageId: null;
            userId: { $ne: mongoose.Types.ObjectId };
            createdAt?: { $gt: Date };
        } = {
            roomId,
            parentMessageId: null,
            userId: { $ne: currentUserObjectId },
        };

        if (roomLastReadAt) {
            unreadFilter.createdAt = { $gt: roomLastReadAt };
        }

        const unreadCount = await Message.countDocuments(unreadFilter);
        return [roomIdStr, unreadCount] as const;
    }));
    const unreadCountByRoomId = new Map<string, number>(unreadCountEntries);

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
        ? await User.find({ _id: { $in: userIds } }).select('_id username').lean<LeanUser[]>()
        : [];

    const userMap = new Map(users.map((u) => [u._id.toString(), u.username || '']));

    const joinedRooms = rooms.map((room) => {
        let roomName = room.name;
        let otherUserId: string | null = null;

        if (room.type === 'private' && room.participants) {
            const otherParticipant = room.participants.find((id) => id.toString() !== userId);
            if (otherParticipant) {
                const participantIdStr = otherParticipant.toString();
                roomName = userMap.get(participantIdStr) || 'Unknown User';
                otherUserId = participantIdStr;
            }
        }

        const lastMessage = lastMessageMap.get(room._id.toString());
        const lastMessageTime = lastMessage?.lastMessageTime ? lastMessage.lastMessageTime.getTime() : null;
        const lastMessageUserId = lastMessage?.lastMessageUserId?.toString() || null;

        return {
            id: room._id.toString(),
            name: roomName,
            type: room.type || 'public',
            participants: (room.participants || []).map((participant) => participant.toString()),
            otherUserId,
            lastMessageText: lastMessage?.lastMessageText || null,
            lastMessageTime,
            lastMessageUserId,
            lastMessageUsername: lastMessageUserId ? userMap.get(lastMessageUserId) || 'Unknown' : null,
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

    const room = await Room.findById(roomObjectId).select('_id name type').lean<Pick<LeanRoom, '_id' | 'name' | 'type'> | null>();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    const user = await User.findById(userId).select('joinedRooms').lean<{ joinedRooms: mongoose.Types.ObjectId[] } | null>();
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const alreadyJoined = user.joinedRooms.some((id) => id.equals(roomObjectId));
    if (alreadyJoined) {
        res.json({
            message: 'Already joined this room',
            room: {
                id: room._id.toString(),
                name: room.name,
            },
        });
        return;
    }

    if ((room.type || 'public') === 'public') {
        const publicRoomCount = await Room.countDocuments({
            _id: { $in: user.joinedRooms },
            type: 'public',
        });

        if (publicRoomCount >= MAX_PUBLIC_ROOMS) {
            throw new ValidationError('You can only join up to 5 group chats at a time.');
        }
    }

    const addResult = await User.updateOne(
        { _id: userId, joinedRooms: { $ne: roomObjectId } },
        { $addToSet: { joinedRooms: roomObjectId } }
    );

    if (addResult.modifiedCount === 0) {
        res.json({
            message: 'Already joined this room',
            room: {
                id: room._id.toString(),
                name: room.name,
            },
        });
        return;
    }

    if ((room.type || 'public') === 'public') {
        const updatedUser = await User.findById(userId).select('joinedRooms').lean<{ joinedRooms: mongoose.Types.ObjectId[] } | null>();
        if (!updatedUser) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        const updatedPublicCount = await Room.countDocuments({
            _id: { $in: updatedUser.joinedRooms },
            type: 'public',
        });

        if (updatedPublicCount > MAX_PUBLIC_ROOMS) {
            await User.updateOne(
                { _id: userId },
                { $pull: { joinedRooms: roomObjectId } }
            );
            throw new ValidationError('You can only join up to 5 group chats at a time.');
        }
    }

    res.json({
        message: 'Successfully joined room',
        room: {
            id: room._id.toString(),
            name: room.name,
        },
    });
}));

router.get('/:roomId/messages', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const { before, limit } = req.query;

    const room = await Room.findById(roomObjectId).select('_id').lean();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

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

    const usernameMap = new Map(users.map((u) => [u._id.toString(), u.username || '']));

    const formattedMessages = pageMessages.reverse().map((msg) => ({
        id: msg._id.toString(),
        roomId: msg.roomId.toString(),
        userId: msg.userId.toString(),
        username: usernameMap.get(msg.userId.toString()) || '',
        text: msg.text,
        createdAt: msg.createdAt.getTime(),
        parentMessageId: msg.parentMessageId?.toString() || null,
        replyCount: msg.replyCount || 0,
    }));

    // Generate next cursor from the oldest message (which is at index 0 after reverse, 
    // or last index of pageMessages before reverse).
    // Actually, pageMessages is sorted DESC. So the last item in pageMessages is the oldest.
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
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const room = await Room.findById(roomObjectId).select('_id').lean();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    const users = await User.find({ joinedRooms: roomObjectId })
        .select('_id username phoneNumber profileImageUrl')
        .lean<LeanUser[]>();

    res.json(users.map((user) => ({
        id: user._id.toString(),
        username: user.username || '',
        phoneNumber: user.phoneNumber,
        profileImageUrl: user.profileImageUrl || '',
    })));
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

    const room = await Room.findById(roomObjectId).select('_id').lean();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
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

router.post('/direct/:otherUserId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const { otherUserId } = req.params;

    validateObjectId(otherUserId, 'user ID');

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't message yourself.");
    }

    const [otherUser, currentUser] = await Promise.all([
        User.findById(otherUserId).select('_id username').lean<LeanUser | null>(),
        User.findById(currentUserId).select('_id username').lean<LeanUser | null>(),
    ]);

    if (!otherUser || !currentUser) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
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
        User.updateOne({ _id: currentUserId }, { $addToSet: { joinedRooms: roomObjectId } }),
        User.updateOne({ _id: otherUserId }, { $addToSet: { joinedRooms: roomObjectId } }),
    ]);

    res.json({
        message: 'Direct message room ready',
        room: {
            id: room._id.toString(),
            name: otherUser.username || 'Unknown User',
            type: room.type,
            participants: (room.participants || []).map((participant) => participant.toString()),
            otherUserId,
        },
    });
}));

export default router;
