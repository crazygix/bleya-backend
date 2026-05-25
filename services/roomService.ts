import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { toRoomLocation, isPrivateRoomParticipant, type RoomLocation } from '../utils/room.js';
import { formatMessage, buildUsernameMap, type FormattedMessage } from '../utils/message.js';
import type { LeanRoom, LeanMessage, LeanUser, LeanJoinedRoomsUser, LastMessageAgg } from '../types/lean.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';
import { type RoomRepository, roomRepository as defaultRoomRepo } from '../repositories/roomRepository.js';

const MAX_PUBLIC_ROOMS = 5;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ROOM_MESSAGES_PAGE_SIZE = 50;
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

export interface RoomSummaryDto {
    id: string;
    name: string;
    type: 'public' | 'private';
    cityKey: string | null;
    imageUrl: string | null;
    location: RoomLocation | null;
}

export interface JoinRoomResponseDto {
    message: string;
    room: RoomSummaryDto;
}

interface JoinRoomForUserInput {
    userId: string;
    roomId: mongoose.Types.ObjectId;
}

interface ListPublicRoomsInput {
    searchQuery?: string;
}

export function toRoomSummary(room: LeanRoom): RoomSummaryDto {
    return {
        id: room._id.toString(),
        name: room.name,
        type: room.type || 'public',
        cityKey: room.cityKey || null,
        imageUrl: room.imageUrl || null,
        location: toRoomLocation(room),
    };
}

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildPublicRoomFilter(searchQuery?: string): Record<string, unknown> {
    const filter: Record<string, unknown> = { type: 'public' };
    if (searchQuery) {
        filter.name = {
            $regex: new RegExp(escapeRegex(searchQuery), 'i'),
        };
    }

    return filter;
}

export function isPublicRoom(room: { type?: 'public' | 'private' }): boolean {
    return (room.type || 'public') === 'public';
}

export interface RoomServiceDeps {
    userRepo: UserRepository;
    roomRepo: RoomRepository;
}

export function createRoomService(deps: RoomServiceDeps) {
    const { userRepo, roomRepo } = deps;

    async function countJoinedPublicRooms(joinedRoomIds: mongoose.Types.ObjectId[]): Promise<number> {
        return roomRepo.countByFilter({
            _id: { $in: joinedRoomIds },
            type: 'public',
        });
    }

    async function listPublicRooms(input: ListPublicRoomsInput = {}): Promise<RoomSummaryDto[]> {
        const filter = buildPublicRoomFilter(input.searchQuery);
        const rooms = await roomRepo.findPublicRooms(filter, '_id name type cityKey imageUrl geo');
        return rooms.map((room) => toRoomSummary(room));
    }

    async function joinRoomForUser(input: JoinRoomForUserInput): Promise<JoinRoomResponseDto> {
        const room = await roomRepo.findById(input.roomId, '_id name type participants imageUrl cityKey geo');

        if (!room) {
            throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
        }

        if ((room.type || 'public') === 'private') {
            const isParticipant = (room.participants || []).some((participantId) => participantId.equals(input.userId));
            if (!isParticipant) {
                throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to join this chat.', 403);
            }
        }

        const roomSummary = toRoomSummary(room);

        const user = await userRepo.findByIdSelectJoinedRooms(input.userId);

        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        const alreadyJoined = user.joinedRooms.some((id) => id.equals(input.roomId));
        if (alreadyJoined) {
            return {
                message: 'Already joined this room',
                room: roomSummary,
            };
        }

        if (isPublicRoom(room)) {
            const publicRoomCount = await countJoinedPublicRooms(user.joinedRooms);
            if (publicRoomCount >= MAX_PUBLIC_ROOMS) {
                throw new ValidationError('You can only join up to 5 group chats at a time.');
            }
        }

        const addResult = await userRepo.addToJoinedRooms(input.userId, input.roomId);

        if (addResult.modifiedCount === 0) {
            return {
                message: 'Already joined this room',
                room: roomSummary,
            };
        }

        if (isPublicRoom(room)) {
            const updatedUser = await userRepo.findByIdSelectJoinedRooms(input.userId);

            if (!updatedUser) {
                throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
            }

            const updatedPublicCount = await countJoinedPublicRooms(updatedUser.joinedRooms);
            if (updatedPublicCount > MAX_PUBLIC_ROOMS) {
                await userRepo.removeFromJoinedRooms(input.userId, input.roomId);
                throw new ValidationError('You can only join up to 5 group chats at a time.');
            }
        }

        return {
            message: 'Successfully joined room',
            room: roomSummary,
        };
    }

    return { listPublicRooms, joinRoomForUser };
}

const defaultRoomService = createRoomService({
    userRepo: defaultUserRepo,
    roomRepo: defaultRoomRepo,
});

export const listPublicRooms = defaultRoomService.listPublicRooms;
export const joinRoomForUser = defaultRoomService.joinRoomForUser;

// ============================================================
// Room read / query operations (extracted from routes/rooms.ts)
// ============================================================

export interface JoinedRoomDto {
    id: string;
    name: string;
    type: 'public' | 'private';
    cityKey: string | null;
    participants: string[];
    otherUserId: string | null;
    imageUrl: string | null;
    location: RoomLocation | null;
    lastMessageText: string | null;
    lastMessageTime: number | null;
    lastMessageUserId: string | null;
    lastMessageUsername: string | null;
    unreadCount: number;
}

export interface RoomDetailDto {
    id: string;
    name: string;
    type: 'public' | 'private';
    cityKey: string | null;
    imageUrl: string | null;
    location: RoomLocation | null;
    participants: string[];
    otherUserId: string | null;
}

export interface RoomMemberDto {
    id: string;
    username: string;
    bio: string;
    profileImageUrl: string;
}

export interface RoomMessagesPageDto {
    messages: FormattedMessage[];
    pagination: {
        hasMore: boolean;
        nextCursor: string | null;
    };
}

export interface RoomMessagesQuery {
    before?: string;
    limit?: string;
}

export interface MarkRoomReadResult {
    message: string;
    lastReadAt: number;
}

export interface RoomJoinView {
    room: {
        id: string;
        name: string;
        description?: string;
        type: 'public' | 'private';
        cityKey: string | null;
        imageUrl: string | null;
        location: RoomLocation | null;
        participants: string[];
        otherUserId: string | null;
    };
    messages: FormattedMessage[];
    pagination: {
        hasMore: boolean;
        nextCursor: string | null;
    };
    lastReadAt: number | null;
}

export function assertUserHasRoomAccess(
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

export async function getJoinedRoomsForUser(userId: string): Promise<JoinedRoomDto[]> {
    const user = await User.findById(userId)
        .select('joinedRooms hiddenDirectRooms roomReadPointers')
        .lean<LeanJoinedRoomsUser | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const allJoinedRoomIds = user.joinedRooms || [];
    if (allJoinedRoomIds.length === 0) {
        return [];
    }

    const roomsRaw = await Room.find({ _id: { $in: allJoinedRoomIds } }).lean<LeanRoom[]>();
    const hiddenDirectRoomIdSet = new Set((user.hiddenDirectRooms || []).map((roomId) => roomId.toString()));

    const rooms = roomsRaw.filter((room) => !(
        room.type === 'private'
        && hiddenDirectRoomIdSet.has(room._id.toString())
    ));

    if (rooms.length === 0) {
        return [];
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

    const joinedRooms: JoinedRoomDto[] = rooms.map((room) => {
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

    return joinedRooms;
}

export async function getRoomMessagesForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId,
    query: RoomMessagesQuery
): Promise<RoomMessagesPageDto> {
    const { before, limit } = query;

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

    return {
        messages: formattedMessages,
        pagination: {
            hasMore,
            nextCursor,
        },
    };
}

export async function getRoomMembersForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId
): Promise<RoomMemberDto[]> {
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

    const members: RoomMemberDto[] = users.map((member) => ({
        id: member._id.toString(),
        username: member.username || '',
        bio: member.bio || '',
        profileImageUrl: member.profileImageUrl || '',
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

    return members;
}

export async function leaveRoomForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId
): Promise<{ message: string }> {
    const updateResult = await User.updateOne(
        { _id: userId },
        { $pull: { joinedRooms: roomObjectId } }
    );

    if (updateResult.matchedCount === 0) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    return { message: 'Successfully left room' };
}

export async function markRoomReadForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId
): Promise<MarkRoomReadResult> {
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

    return {
        message: 'Room marked as read',
        lastReadAt: now.getTime(),
    };
}

export async function getRoomDetailForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId
): Promise<RoomDetailDto> {
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

    return {
        id: room._id.toString(),
        name: roomName,
        type: room.type || 'public',
        cityKey: room.cityKey || null,
        imageUrl,
        location: toRoomLocation(room),
        participants: (room.participants || []).map((participant) => participant.toString()),
        otherUserId,
    };
}

// ============================================================
// Socket.IO orchestration support (data gathering only; the
// caller performs the actual transport / emits)
// ============================================================

/**
 * Encapsulates the join_room business logic: validates access, enforces the
 * public-room limit, joins the room if needed, and builds the room view
 * (header + first message page + last-read pointer) that the socket emits.
 */
export async function buildRoomJoinView(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId
): Promise<RoomJoinView> {
    const roomId = roomObjectId.toString();

    const room = await Room.findById(roomObjectId).lean<LeanRoom | null>();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    if (!isPrivateRoomParticipant(room, userId)) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to join this chat', 403);
    }

    const userDoc = await User.findById(userId)
        .select('joinedRooms roomReadPointers')
        .lean<LeanJoinedRoomsUser | null>();

    if (!userDoc) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const isAlreadyJoined = userDoc.joinedRooms.some((id) => id.equals(roomObjectId));

    if (!isAlreadyJoined) {
        if ((room.type || 'public') === 'public') {
            const publicRoomCount = await Room.countDocuments({
                _id: { $in: userDoc.joinedRooms },
                type: 'public',
            });

            if (publicRoomCount >= MAX_PUBLIC_ROOMS) {
                throw new ValidationError('You can only join up to 5 group chats at a time');
            }
        }

        await User.updateOne(
            { _id: userId, joinedRooms: { $ne: roomObjectId } },
            { $addToSet: { joinedRooms: roomObjectId } }
        );
    }

    const rawMessages = await Message.find({
        roomId: roomObjectId,
        parentMessageId: null,
    })
        .sort({ createdAt: -1, _id: -1 })
        .limit(ROOM_MESSAGES_PAGE_SIZE + 1)
        .lean<LeanMessage[]>();

    const hasMore = rawMessages.length > ROOM_MESSAGES_PAGE_SIZE;
    const pageMessages = hasMore
        ? rawMessages.slice(0, ROOM_MESSAGES_PAGE_SIZE)
        : rawMessages;

    const userIds = [...new Set(pageMessages.map((msg) => msg.userId.toString()))]
        .map((id) => new mongoose.Types.ObjectId(id));

    const users = userIds.length > 0
        ? await User.find({ _id: { $in: userIds } }).select('_id username').lean<LeanUser[]>()
        : [];

    const usernameMap = buildUsernameMap(users);
    const formattedMessages = pageMessages.reverse().map((msg) => formatMessage(msg, usernameMap));

    const nextCursor = pageMessages.length > 0
        ? `${pageMessages[pageMessages.length - 1].createdAt.getTime()}_${pageMessages[pageMessages.length - 1]._id.toString()}`
        : null;

    let lastReadAt: number | null = null;
    for (const pointer of userDoc.roomReadPointers || []) {
        if (!pointer.lastReadAt || pointer.roomId.toString() !== roomId) {
            continue;
        }

        const pointerTime = pointer.lastReadAt.getTime();
        if (lastReadAt === null || pointerTime > lastReadAt) {
            lastReadAt = pointerTime;
        }
    }

    let roomName = room.name;
    let otherUserId: string | null = null;
    let imageUrl: string | null = room.imageUrl || null;

    if ((room.type || 'public') === 'private' && room.participants) {
        const otherParticipant = room.participants.find((id) => id.toString() !== userId);
        if (otherParticipant) {
            const otherParticipantId = otherParticipant.toString();
            const otherUser = await User.findById(otherParticipantId)
                .select('username profileImageUrl')
                .lean<LeanUser | null>();

            roomName = otherUser?.username || 'Unknown User';
            imageUrl = otherUser?.profileImageUrl || null;
            otherUserId = otherParticipantId;
        }
    }

    return {
        room: {
            id: room._id.toString(),
            name: roomName,
            description: room.description,
            type: room.type || 'public',
            cityKey: room.cityKey || null,
            imageUrl,
            location: toRoomLocation(room),
            participants: (room.participants || []).map((participant) => participant.toString()),
            otherUserId,
        },
        messages: formattedMessages,
        pagination: {
            hasMore,
            nextCursor,
        },
        lastReadAt,
    };
}

/**
 * Resolves the set of user IDs that should receive a room_summary_updated
 * event for a room. Private rooms notify the participants; public rooms
 * notify every joined member.
 */
export async function getRoomSummaryRecipientIds(
    roomId: string,
    roomType: 'public' | 'private',
    roomParticipants: string[]
): Promise<string[]> {
    if (roomType === 'private') {
        return roomParticipants;
    }

    const memberUsers = await User.find({ joinedRooms: new mongoose.Types.ObjectId(roomId) })
        .select('_id')
        .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

    return memberUsers.map((member) => member._id.toString());
}
