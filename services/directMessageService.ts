import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { UserBlock } from '../models/UserBlock.js';
import { AppError, NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import logger from '../utils/logger.js';
import type { LeanRoom, LeanUser, LeanUserBlock } from '../types/lean.js';

export interface DirectBlockState {
    isBlockedByMe: boolean;
    isBlockedByOtherUser: boolean;
}

export interface DirectChatStatusDto {
    hasChat: boolean;
    roomId: string | null;
    isBlockedByMe: boolean;
    isBlockedByOtherUser: boolean;
    canSendMessage: boolean;
    isDeletedByMe: boolean;
}

export interface DeleteDirectChatResult {
    message: string;
    hasChat: boolean;
    roomId: string | null;
    deleted: boolean;
}

export interface BlockDirectUserResult {
    message: string;
    roomId: string;
    blocked: boolean;
    alreadyBlocked: boolean;
}

export interface UnblockDirectUserResult {
    message: string;
    roomId: string | null;
    blocked: boolean;
    alreadyBlocked: boolean;
}

export interface OpenDirectRoomResult {
    message: string;
    room: {
        id: string;
        name: string;
        type: 'public' | 'private';
        participants: string[];
        imageUrl: string | null;
        otherUserId: string;
    };
}

export const DIRECT_ROOM_NAME = 'Direct message';

export function buildDirectParticipantsHash(currentUserId: string, otherUserId: string): string {
    return [currentUserId, otherUserId].sort().join('_');
}

async function findExistingDirectRoom(currentUserId: string, otherUserId: string): Promise<LeanRoom | null> {
    const participantsHash = buildDirectParticipantsHash(currentUserId, otherUserId);
    return Room.findOne({
        type: 'private',
        participantsHash,
    }).lean<LeanRoom | null>();
}

export async function getDirectBlockState(
    currentUserId: string,
    otherUserId: string
): Promise<DirectBlockState> {
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

export async function getDirectChatStatus(
    currentUserId: string,
    otherUserId: string
): Promise<DirectChatStatusDto> {
    // Normalized (lowercase) so a mixed-case id can't slip past the self
    // check, the block-state comparison or the participants hash.
    otherUserId = validateObjectId(otherUserId, 'user ID').toString();

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

    return {
        hasChat: !!room,
        roomId,
        isBlockedByMe: blockState.isBlockedByMe,
        isBlockedByOtherUser: blockState.isBlockedByOtherUser,
        canSendMessage: !blockState.isBlockedByMe && !blockState.isBlockedByOtherUser,
        isDeletedByMe,
    };
}

export async function deleteDirectChat(
    currentUserId: string,
    otherUserId: string
): Promise<DeleteDirectChatResult> {
    // Normalized (lowercase) so a mixed-case id can't slip past the self
    // check, the block-state comparison or the participants hash.
    otherUserId = validateObjectId(otherUserId, 'user ID').toString();

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
        return {
            message: 'No direct chat found.',
            hasChat: false,
            roomId: null,
            deleted: false,
        };
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

    return {
        message: 'Chat removed from your list.',
        hasChat: true,
        roomId: room._id.toString(),
        deleted: true,
    };
}

export async function blockDirectUser(
    currentUserId: string,
    otherUserId: string
): Promise<BlockDirectUserResult> {
    // Normalized (lowercase) so a mixed-case id can't slip past the self
    // check, the block-state comparison or the participants hash.
    otherUserId = validateObjectId(otherUserId, 'user ID').toString();

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

    return {
        message: alreadyBlocked ? 'User already blocked.' : 'User blocked.',
        roomId: room._id.toString(),
        blocked: true,
        alreadyBlocked,
    };
}

export async function unblockDirectUser(
    currentUserId: string,
    otherUserId: string
): Promise<UnblockDirectUserResult> {
    // Normalized (lowercase) so a mixed-case id can't slip past the self
    // check, the block-state comparison or the participants hash.
    otherUserId = validateObjectId(otherUserId, 'user ID').toString();

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
    }).select('_id roomId').lean<Array<{ _id: mongoose.Types.ObjectId; roomId?: mongoose.Types.ObjectId | null }>>();

    if (activeBlocks.length === 0) {
        return {
            message: 'User is not blocked.',
            roomId: null,
            blocked: false,
            alreadyBlocked: false,
        };
    }

    const now = new Date();
    const activeBlockIds = activeBlocks.map((block) => block._id);
    // User-level blocks (from a profile or public room) have no roomId.
    const roomIds = [...new Set(activeBlocks
        .filter((block) => block.roomId)
        .map((block) => block.roomId!.toString()))]
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

    return {
        message: 'User unblocked.',
        roomId: roomIds[0]?.toString() || null,
        blocked: false,
        alreadyBlocked: false,
    };
}

export async function openOrCreateDirectRoom(
    currentUserId: string,
    otherUserId: string
): Promise<OpenDirectRoomResult> {
    // Normalized (lowercase) so a mixed-case id can't slip past the self
    // check, the block-state comparison or the participants hash.
    otherUserId = validateObjectId(otherUserId, 'user ID').toString();

    if (otherUserId === currentUserId) {
        throw new ValidationError("You can't message yourself.");
    }

    const [otherUser, currentUser, blockState] = await Promise.all([
        User.findById(otherUserId).select('_id username profileImageUrl').lean<LeanUser | null>(),
        User.findById(currentUserId).select('_id').lean<LeanUser | null>(),
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

    const room = await upsertDirectRoom(participantsHash, participants);

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

    return {
        message: 'Direct message room ready',
        room: {
            id: room._id.toString(),
            name: otherUser.username || 'Unknown User',
            type: room.type as 'public' | 'private',
            participants: (room.participants || []).map((participant) => participant.toString()),
            imageUrl: otherUser?.profileImageUrl || null,
            otherUserId,
        },
    };
}

// The unique {participantsHash, type} index makes two concurrent upserts for
// the same pair collide; the loser reads the winner's room.
async function upsertDirectRoom(participantsHash: string, participants: string[]) {
    try {
        return await Room.findOneAndUpdate(
            {
                type: 'private',
                participantsHash,
            },
        {
            $setOnInsert: {
                // Neutral on purpose: the app shows the other participant's
                // current username, and a stored name would keep a deleted
                // user's handle around.
                name: DIRECT_ROOM_NAME,
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
    } catch (error) {
        if ((error as { code?: unknown }).code === 11000) {
            return Room.findOne({ type: 'private', participantsHash });
        }
        throw error;
    }
}
