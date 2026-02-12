import express from 'express';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import {
    FIXED_DISCOVERY_RADIUS_KM,
    getNearbyRoomsForUser,
    joinRoomForUser,
    listPublicRooms,
} from '../services/roomService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { sanitizePlainText } from '../utils/sanitize.js';

const router = express.Router();

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const DEFAULT_DISCOVERY_LIMIT = 20;
const MAX_DISCOVERY_LIMIT = 50;

interface GeoPoint {
    type?: 'Point';
    coordinates?: number[];
}

interface LeanRoom {
    _id: mongoose.Types.ObjectId;
    name: string;
    type?: 'public' | 'private';
    participants?: mongoose.Types.ObjectId[];
    cityKey?: string;
    imageUrl?: string;
    geo?: GeoPoint;
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

function parseCoordinate(value: unknown, fieldName: string): number {
    if (typeof value !== 'string') {
        throw new ValidationError(`${fieldName} is required.`);
    }

    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        throw new ValidationError(`${fieldName} must be a number.`);
    }

    return parsed;
}

function parseLimit(value: unknown, defaultValue: number, min: number, max: number): number {
    if (typeof value !== 'string' || value.trim().length === 0) {
        return defaultValue;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) {
        throw new ValidationError('limit must be an integer.');
    }

    if (parsed < min || parsed > max) {
        throw new ValidationError(`limit must be between ${min} and ${max}.`);
    }

    return parsed;
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

function toRoomLocation(room: { geo?: GeoPoint }): { latitude: number; longitude: number } | null {
    const coordinates = room.geo?.coordinates;
    if (!coordinates || coordinates.length < 2) {
        return null;
    }

    const [longitude, latitude] = coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
        return null;
    }

    return { latitude, longitude };
}

router.get('/nearby', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const latitude = parseCoordinate(req.query.latitude ?? req.query.lat, 'latitude');
    const longitude = parseCoordinate(req.query.longitude ?? req.query.lng, 'longitude');
    const searchQuery = parseSearchQuery(req.query.search ?? req.query.q);

    if (latitude < -90 || latitude > 90) {
        throw new ValidationError('latitude must be between -90 and 90.');
    }

    if (longitude < -180 || longitude > 180) {
        throw new ValidationError('longitude must be between -180 and 180.');
    }

    const radiusKm = FIXED_DISCOVERY_RADIUS_KM;
    const limit = parseLimit(req.query.limit, DEFAULT_DISCOVERY_LIMIT, 1, MAX_DISCOVERY_LIMIT);

    const response = await getNearbyRoomsForUser({
        userId,
        latitude,
        longitude,
        radiusKm,
        limit,
        searchQuery,
    });

    res.json(response);
}));

router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const searchQuery = parseSearchQuery(req.query.search ?? req.query.q);
    const rooms = await listPublicRooms({ searchQuery });
    res.json(rooms);
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
        User.findById(otherUserId).select('_id username profileImageUrl').lean<LeanUser | null>(),
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
            imageUrl: otherUser?.profileImageUrl || null,
            otherUserId,
        },
    });
}));

router.get('/:roomId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');

    const room = await Room.findById(roomObjectId).lean<LeanRoom | null>();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

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
