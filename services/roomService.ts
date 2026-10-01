import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { toRoomLocation, isPrivateRoomParticipant, type RoomLocation } from '../utils/room.js';
import { formatMessage, buildUsernameMap, type FormattedMessage } from '../utils/message.js';
import type {
    LeanRoom,
    LeanMessage,
    LeanUser,
    LeanJoinedRoomsUser,
    LastMessageAgg,
    RoomReadPointer,
} from '../types/lean.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';
import { type RoomRepository, roomRepository as defaultRoomRepo } from '../repositories/roomRepository.js';
import { getActiveBlockPairUserIds } from './blockService.js';

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

    return { joinRoomForUser };
}

const defaultRoomService = createRoomService({
    userRepo: defaultUserRepo,
    roomRepo: defaultRoomRepo,
});

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

// Unread messages per room, as each room's unreadCount in the chat list:
// top-level messages after the user's read pointer that aren't their own, from
// a blocked-pair user, or removed by moderation. Rooms with nothing unread are
// left out.
async function countUnreadMessagesByRoom(
    userId: string,
    roomIds: mongoose.Types.ObjectId[],
    readPointers: RoomReadPointer[] | undefined,
    blockedUserObjectIds: mongoose.Types.ObjectId[]
): Promise<Map<string, number>> {
    const lastReadAtByRoomId = new Map<string, Date>();
    for (const pointer of readPointers || []) {
        if (!pointer.roomId || !pointer.lastReadAt) {
            continue;
        }

        const roomId = pointer.roomId.toString();
        const currentLastReadAt = lastReadAtByRoomId.get(roomId);
        if (!currentLastReadAt || pointer.lastReadAt > currentLastReadAt) {
            lastReadAtByRoomId.set(roomId, pointer.lastReadAt);
        }
    }

    const currentUserObjectId = new mongoose.Types.ObjectId(userId);
    const unreadMatchConditions = roomIds.map((roomId) => {
        const lastReadAt = lastReadAtByRoomId.get(roomId.toString());
        const condition: Record<string, unknown> = {
            roomId,
            parentMessageId: null,
            userId: { $nin: [currentUserObjectId, ...blockedUserObjectIds] },
            deletedAt: null,
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

    return unreadCountByRoomId;
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

    // Mutual block: a blocked-pair user's messages never surface as a preview or
    // count toward unread, same as in the room itself.
    const blockedUserObjectIds = (await getActiveBlockPairUserIds(userId))
        .map((id) => new mongoose.Types.ObjectId(id));

    // Latest visible top-level message per room: one indexed lookup per room
    // ({roomId, parentMessageId, createdAt, _id}) instead of an aggregate that
    // scanned every message in every joined room.
    const latestPerRoom = await Promise.all(joinedRoomIds.map(async (roomId): Promise<LastMessageAgg | null> => {
        const filter: Record<string, unknown> = { roomId, parentMessageId: null, deletedAt: null };
        if (blockedUserObjectIds.length > 0) {
            filter.userId = { $nin: blockedUserObjectIds };
        }

        const latest = await Message.findOne(filter)
            .sort({ createdAt: -1, _id: -1 })
            .select('text createdAt userId')
            .lean<Pick<LeanMessage, 'text' | 'createdAt' | 'userId'> | null>();

        return latest
            ? {
                _id: roomId,
                lastMessageText: latest.text,
                lastMessageTime: latest.createdAt,
                lastMessageUserId: latest.userId,
            }
            : null;
    }));
    const lastMessages = latestPerRoom.filter((message): message is LastMessageAgg => message !== null);

    const lastMessageMap = new Map(lastMessages.map((msg) => [msg._id.toString(), msg]));

    const unreadCountByRoomId = await countUnreadMessagesByRoom(
        userId,
        joinedRoomIds,
        user.roomReadPointers,
        blockedUserObjectIds
    );

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

// DM chats with at least one unread message, as the chat list shows them:
// joined, not hidden, and counted the same way as each room's unreadCount.
// City rooms don't count. Callers that already loaded the user's block pairs
// pass them in to skip that lookup.
export async function countUnreadDirectRoomsForUser(userId: string, blockedUserIds?: string[]): Promise<number> {
    const user = await User.findById(userId)
        .select('joinedRooms hiddenDirectRooms roomReadPointers')
        .lean<LeanJoinedRoomsUser | null>();

    const joinedRoomIds = user?.joinedRooms || [];
    if (!user || joinedRoomIds.length === 0) {
        return 0;
    }

    const hiddenDirectRoomIdSet = new Set((user.hiddenDirectRooms || []).map((roomId) => roomId.toString()));
    const directRooms = await Room.find({ _id: { $in: joinedRoomIds }, type: 'private' })
        .select('_id')
        .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
    const directRoomIds = directRooms
        .map((room) => room._id)
        .filter((roomId) => !hiddenDirectRoomIdSet.has(roomId.toString()));

    if (directRoomIds.length === 0) {
        return 0;
    }

    const blockedUserObjectIds = (blockedUserIds ?? await getActiveBlockPairUserIds(userId))
        .map((id) => new mongoose.Types.ObjectId(id));
    const unreadCountByRoomId = await countUnreadMessagesByRoom(
        userId,
        directRoomIds,
        user.roomReadPointers,
        blockedUserObjectIds
    );

    return [...unreadCountByRoomId.values()].filter((count) => count > 0).length;
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
        userId?: { $nin: mongoose.Types.ObjectId[] };
        $or?: Array<{ createdAt: { $lt: Date } } | { createdAt: Date; _id: { $lt: mongoose.Types.ObjectId } }>;
        createdAt?: { $lt: Date };
    } = {
        roomId: roomObjectId,
        parentMessageId: null,
    };

    // Mutually hide messages authored by anyone in an active block-pair. Applied
    // in the query (not in-memory) so pagination/hasMore stay accurate.
    const blockedUserIds = await getActiveBlockPairUserIds(userId);
    if (blockedUserIds.length > 0) {
        filter.userId = { $nin: blockedUserIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

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

    const rawMessages = await Message.find({ ...filter, deletedAt: null })
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

const DEFAULT_MEMBERS_PAGE_SIZE = 500;
const MAX_MEMBERS_PAGE_SIZE = 1000;

export interface RoomMembersQuery {
    limit?: string;
    offset?: string;
}

function parseBoundedInt(value: string | undefined, fallback: number, max: number): number {
    if (typeof value !== 'string') {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        return fallback;
    }
    return Math.min(parsed, max);
}

export async function getRoomMembersForUser(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId,
    query: RoomMembersQuery = {}
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

    // Hide blocked-pair users from the member list (mutual: applies to both
    // the blocker and the blocked).
    const blockedUserIds = await getActiveBlockPairUserIds(userId);
    const memberFilter: {
        joinedRooms: mongoose.Types.ObjectId;
        _id?: { $nin: mongoose.Types.ObjectId[] };
    } = { joinedRooms: roomObjectId };
    if (blockedUserIds.length > 0) {
        memberFilter._id = { $nin: blockedUserIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    // Sorted by the database (case/accent-insensitive, like the old
    // localeCompare with sensitivity 'base') and bounded, instead of loading
    // every member and sorting on the event loop.
    const limit = Math.max(1, parseBoundedInt(query.limit, DEFAULT_MEMBERS_PAGE_SIZE, MAX_MEMBERS_PAGE_SIZE));
    const offset = parseBoundedInt(query.offset, 0, Number.MAX_SAFE_INTEGER);

    const users = await User.find(memberFilter)
        .select('_id username bio profileImageUrl')
        .collation({ locale: 'en', strength: 1 })
        .sort({ username: 1, _id: 1 })
        .skip(offset)
        .limit(limit)
        .lean<LeanUser[]>();

    return users.map((member) => ({
        id: member._id.toString(),
        username: member.username || '',
        bio: member.bio || '',
        profileImageUrl: member.profileImageUrl || '',
    }));
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
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this room.', 403);
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

export interface RoomJoinViewOptions {
    /**
     * Asked right before the user is added to the room. Returning false means
     * the join is no longer wanted (a newer request from the same connection
     * replaced it), so the room isn't added and RoomJoinSupersededError is
     * thrown instead.
     */
    isStillWanted?: () => boolean;
}

/** A join that was replaced by a newer request before the user was added to the room. */
export class RoomJoinSupersededError extends Error {
    constructor() {
        super('The room join was replaced by a newer request.');
        this.name = 'RoomJoinSupersededError';
    }
}

/**
 * Encapsulates the join_room business logic: validates access, enforces the
 * public-room limit, joins the room if needed, and builds the room view
 * (header + first message page + last-read pointer) that the socket emits.
 */
export async function buildRoomJoinView(
    userId: string,
    roomObjectId: mongoose.Types.ObjectId,
    options: RoomJoinViewOptions = {}
): Promise<RoomJoinView> {
    const roomId = roomObjectId.toString();

    const room = await Room.findById(roomObjectId).lean<LeanRoom | null>();
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    if (!isPrivateRoomParticipant(room, userId)) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to join this chat.', 403);
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
                throw new ValidationError('You can only join up to 5 group chats at a time.');
            }
        }

        if (options.isStillWanted && !options.isStillWanted()) {
            throw new RoomJoinSupersededError();
        }

        await User.updateOne(
            { _id: userId, joinedRooms: { $ne: roomObjectId } },
            { $addToSet: { joinedRooms: roomObjectId } }
        );
    }

    const messageFilter: Record<string, unknown> = {
        roomId: roomObjectId,
        parentMessageId: null,
        deletedAt: null,
    };

    // Mutual block: same filter as the HTTP messages page, so opening a chat
    // over the socket never shows a blocked-pair user's messages.
    const blockedUserIds = await getActiveBlockPairUserIds(userId);
    if (blockedUserIds.length > 0) {
        messageFilter.userId = { $nin: blockedUserIds.map((id) => new mongoose.Types.ObjectId(id)) };
    }

    const rawMessages = await Message.find(messageFilter)
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
