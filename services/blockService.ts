import mongoose from 'mongoose';
import { UserBlock } from '../models/UserBlock.js';
import { User } from '../models/User.js';
import { ValidationError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import logger from '../utils/logger.js';

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
