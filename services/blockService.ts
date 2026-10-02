import mongoose from 'mongoose';
import { UserBlock } from '../models/UserBlock.js';
import { User } from '../models/User.js';
import { ValidationError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import logger from '../utils/logger.js';
import type { LeanUserBlock } from '../types/lean.js';

// User-level block (not tied to a DM room) so a user can be blocked from a public
// room, a message, or a profile where no direct chat exists. Enforcement is
// pair-based (messageService checks blocker/blocked regardless of roomId), so this
// is respected everywhere DM blocks are.

export interface BlockResult {
    blocked: boolean;
    alreadyBlocked: boolean;
}

export async function blockUser(currentUserId: string, targetUserId: string): Promise<BlockResult> {
    const targetId = validateObjectId(targetUserId, 'user ID');
    if (targetId.toString() === currentUserId) {
        throw new ValidationError("You can't block yourself.");
    }

    const exists = await User.exists({ _id: targetId });
    if (!exists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const result = await UserBlock.updateOne(
        {
            blockerUserId: new mongoose.Types.ObjectId(currentUserId),
            blockedUserId: targetId,
            isActive: true,
        },
        {
            $setOnInsert: {
                blockedAt: new Date(),
                source: 'user_action',
                isActive: true,
                unblockedAt: null,
            },
        },
        { upsert: true }
    );

    const alreadyBlocked = result.upsertedCount === 0;
    logger.info('user.blocked', {
        blockerUserId: currentUserId,
        blockedUserId: targetId.toString(),
        alreadyBlocked,
    });

    return { blocked: true, alreadyBlocked };
}

export async function unblockUser(currentUserId: string, targetUserId: string): Promise<BlockResult> {
    const targetId = validateObjectId(targetUserId, 'user ID');
    if (targetId.toString() === currentUserId) {
        throw new ValidationError("You can't unblock yourself.");
    }

    await UserBlock.updateMany(
        {
            blockerUserId: new mongoose.Types.ObjectId(currentUserId),
            blockedUserId: targetId,
            isActive: true,
        },
        { $set: { isActive: false, unblockedAt: new Date() } }
    );

    logger.info('user.unblocked', {
        blockerUserId: currentUserId,
        blockedUserId: targetId.toString(),
    });

    return { blocked: false, alreadyBlocked: false };
}

// Returns the userIds the given user is in an active block-pair with, in either
// direction (they blocked someone, or someone blocked them). Blocking is mutual:
// neither party sees the other's messages, members entry, or notifications, so
// every visibility surface excludes this set rather than just the blocker's own.
export async function getActiveBlockPairUserIds(userId: string): Promise<string[]> {
    const blockPairUserIdsByUserId = await getActiveBlockPairUserIdsByUser([userId]);
    return blockPairUserIdsByUserId.get(userId) ?? [];
}

// The same for several users in one query, keyed by userId. Every given user
// has an entry, empty when they have no block pairs.
export async function getActiveBlockPairUserIdsByUser(userIds: string[]): Promise<Map<string, string[]>> {
    const otherUserIdsByUserId = new Map(userIds.map((userId) => [userId, new Set<string>()]));
    if (otherUserIdsByUserId.size === 0) {
        return new Map();
    }

    const userObjectIds = [...otherUserIdsByUserId.keys()].map((userId) => new mongoose.Types.ObjectId(userId));
    const blocks = await UserBlock.find({
        isActive: true,
        $or: [
            { blockerUserId: { $in: userObjectIds } },
            { blockedUserId: { $in: userObjectIds } },
        ],
    }).select('blockerUserId blockedUserId').lean<LeanUserBlock[]>();

    for (const block of blocks) {
        const blockerId = block.blockerUserId.toString();
        const blockedId = block.blockedUserId.toString();
        otherUserIdsByUserId.get(blockerId)?.add(blockedId);
        otherUserIdsByUserId.get(blockedId)?.add(blockerId);
    }

    return new Map([...otherUserIdsByUserId].map(([userId, otherUserIds]) => [userId, [...otherUserIds]]));
}
