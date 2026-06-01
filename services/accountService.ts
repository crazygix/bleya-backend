import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Message } from '../models/Message.js';
import { Room } from '../models/Room.js';
import { UserBlock } from '../models/UserBlock.js';
import { Notification } from '../models/Notification.js';
import { PasskeyCredential } from '../models/PasskeyCredential.js';
import { UserIdentity } from '../models/UserIdentity.js';
import { AuthChallenge } from '../models/AuthChallenge.js';
import { PushToken } from '../models/PushToken.js';
import { deleteFromR2, extractKeyFromUrl } from './r2Service.js';
import { NotFoundError, ErrorCode } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { LeanFullUser, LeanMessage, LeanRoom } from '../types/lean.js';

// ============================================================
// Data export (GDPR right to access)
// ============================================================

export interface ExportedRoom {
    id: string;
    type: 'public' | 'private';
    name: string | null;
    cityKey: string | null;
    otherParticipantIds: string[];
}

export interface UserDataExport {
    exportedAt: number;
    account: {
        id: string;
        username: string;
        bio: string;
        profileImageUrl: string;
        createdAt: number;
        updatedAt: number;
        lastLogin: number;
    };
    linkedProviders: Array<{
        provider: string;
        email: string;
        emailVerified: boolean;
        isPrivateRelay: boolean;
        linkedAt: number | null;
        lastUsedAt: number | null;
    }>;
    passkeys: Array<{
        deviceType: string;
        transports: string[];
        backedUp: boolean;
        createdAt: number | null;
        lastUsedAt: number | null;
    }>;
    pushDevices: Array<{
        platform: string;
        createdAt: number | null;
        lastSeenAt: number | null;
    }>;
    rooms: ExportedRoom[];
    messages: Array<{
        id: string;
        roomId: string;
        text: string;
        parentMessageId: string | null;
        createdAt: number;
    }>;
    blockedUsers: Array<{
        blockedUserId: string;
        blockedAt: number | null;
    }>;
}

export async function exportUserData(userId: string): Promise<UserDataExport> {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(userId).lean<LeanFullUser & {
        joinedRooms?: mongoose.Types.ObjectId[];
    } | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const joinedRoomIds = user.joinedRooms || [];

    const [identities, passkeys, pushTokens, rooms, messages, blocks] = await Promise.all([
        UserIdentity.find({ userId: userObjectId })
            .select('provider email emailVerified isPrivateRelay linkedAt lastUsedAt')
            .lean<Array<{
                provider: string;
                email?: string;
                emailVerified?: boolean;
                isPrivateRelay?: boolean;
                linkedAt?: Date;
                lastUsedAt?: Date;
            }>>(),
        PasskeyCredential.find({ userId: userObjectId })
            .select('deviceType transports backedUp createdAt lastUsedAt')
            .lean<Array<{
                deviceType?: string;
                transports?: string[];
                backedUp?: boolean;
                createdAt?: Date;
                lastUsedAt?: Date;
            }>>(),
        PushToken.find({ userId: userObjectId })
            .select('platform createdAt lastSeenAt')
            .lean<Array<{ platform: string; createdAt?: Date; lastSeenAt?: Date }>>(),
        Room.find({
            $or: [
                { _id: { $in: joinedRoomIds } },
                { type: 'private', participants: userObjectId },
            ],
        }).select('_id type name cityKey participants').lean<LeanRoom[]>(),
        Message.find({ userId: userObjectId })
            .select('_id roomId text parentMessageId createdAt')
            .sort({ createdAt: 1 })
            .lean<LeanMessage[]>(),
        UserBlock.find({ blockerUserId: userObjectId, isActive: true })
            .select('blockedUserId blockedAt')
            .lean<Array<{ blockedUserId: mongoose.Types.ObjectId; blockedAt?: Date }>>(),
    ]);

    return {
        exportedAt: Date.now(),
        account: {
            id: user._id.toString(),
            username: user.username || '',
            bio: user.bio || '',
            profileImageUrl: user.profileImageUrl || '',
            createdAt: user.createdAt.getTime(),
            updatedAt: user.updatedAt.getTime(),
            lastLogin: user.lastLogin.getTime(),
        },
        linkedProviders: identities.map((identity) => ({
            provider: identity.provider,
            email: identity.email || '',
            emailVerified: identity.emailVerified ?? false,
            isPrivateRelay: identity.isPrivateRelay ?? false,
            linkedAt: identity.linkedAt ? identity.linkedAt.getTime() : null,
            lastUsedAt: identity.lastUsedAt ? identity.lastUsedAt.getTime() : null,
        })),
        passkeys: passkeys.map((passkey) => ({
            deviceType: passkey.deviceType || 'unknown',
            transports: passkey.transports || [],
            backedUp: passkey.backedUp ?? false,
            createdAt: passkey.createdAt ? passkey.createdAt.getTime() : null,
            lastUsedAt: passkey.lastUsedAt ? passkey.lastUsedAt.getTime() : null,
        })),
        pushDevices: pushTokens.map((pushToken) => ({
            platform: pushToken.platform,
            createdAt: pushToken.createdAt ? pushToken.createdAt.getTime() : null,
            lastSeenAt: pushToken.lastSeenAt ? pushToken.lastSeenAt.getTime() : null,
        })),
        rooms: rooms.map((room) => ({
            id: room._id.toString(),
            type: room.type || 'public',
            name: room.type === 'private' ? null : (room.name || null),
            cityKey: room.cityKey || null,
            otherParticipantIds: (room.participants || [])
                .map((participantId) => participantId.toString())
                .filter((participantId) => participantId !== userId),
        })),
        messages: messages.map((message) => ({
            id: message._id.toString(),
            roomId: message.roomId.toString(),
            text: message.text,
            parentMessageId: message.parentMessageId?.toString() || null,
            createdAt: message.createdAt.getTime(),
        })),
        blockedUsers: blocks.map((block) => ({
            blockedUserId: block.blockedUserId.toString(),
            blockedAt: block.blockedAt ? block.blockedAt.getTime() : null,
        })),
    };
}

// ============================================================
// Account deletion (GDPR right to erasure) — immediate hard delete
// ============================================================

export interface DeleteAccountResult {
    deleted: true;
    removed: {
        messages: number;
        notifications: number;
        blocks: number;
        passkeys: number;
        identities: number;
        authChallenges: number;
        pushTokens: number;
    };
}

/**
 * Permanently deletes a user and all personal data tied to them. Messages are
 * hard-deleted (not anonymized). Thread integrity is preserved: replies left
 * under a deleted thread root are re-parented to top-level, and reply counts on
 * surviving parents are recomputed. Direct-message rooms are left intact for the
 * other participant (the deleted user's messages in them are removed).
 *
 * Runs without a multi-document transaction (standalone Mongo support); the
 * `replyCount` fix-up recomputes absolute values so a retry after a partial
 * failure cannot corrupt counters.
 */
export async function deleteUserAccount(userId: string): Promise<DeleteAccountResult> {
    const userObjectId = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(userId)
        .select('_id profileImageUrl')
        .lean<{ _id: mongoose.Types.ObjectId; profileImageUrl?: string } | null>();

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Thread roots authored by the user (their top-level messages).
    const userRootIds = await Message.distinct('_id', {
        userId: userObjectId,
        parentMessageId: null,
    }) as mongoose.Types.ObjectId[];
    const userRootIdSet = new Set(userRootIds.map((id) => id.toString()));

    // Parents of the user's replies, excluding the user's own (to-be-deleted)
    // roots — these are the threads whose reply counts need recomputing.
    const replyParentIds = (await Message.distinct('parentMessageId', {
        userId: userObjectId,
        parentMessageId: { $ne: null },
    }) as mongoose.Types.ObjectId[]).filter((id) => !userRootIdSet.has(id.toString()));

    // Re-parent other users' replies that hang under the user's deleted roots
    // up to top-level so they don't become orphans.
    if (userRootIds.length > 0) {
        await Message.updateMany(
            { parentMessageId: { $in: userRootIds }, userId: { $ne: userObjectId } },
            { $set: { parentMessageId: null } }
        );
    }

    // Capture the user's message ids before deletion for notification cleanup.
    const userMessageIds = await Message.distinct('_id', { userId: userObjectId }) as mongoose.Types.ObjectId[];

    const messagesResult = await Message.deleteMany({ userId: userObjectId });

    // Recompute reply counts on surviving parent threads (idempotent).
    for (const parentId of replyParentIds) {
        const remaining = await Message.countDocuments({ parentMessageId: parentId });
        await Message.updateOne({ _id: parentId }, { $set: { replyCount: remaining } });
    }

    // Notifications involving the user, or referencing their now-deleted messages.
    const notificationsResult = await Notification.deleteMany({
        $or: [
            { recipient: userObjectId },
            { sender: userObjectId },
            { message: { $in: userMessageIds } },
            { thread: { $in: userMessageIds } },
        ],
    });

    const blocksResult = await UserBlock.deleteMany({
        $or: [{ blockerUserId: userObjectId }, { blockedUserId: userObjectId }],
    });
    const passkeysResult = await PasskeyCredential.deleteMany({ userId: userObjectId });
    const identitiesResult = await UserIdentity.deleteMany({ userId: userObjectId });
    const challengesResult = await AuthChallenge.deleteMany({ userId: userObjectId });
    const pushTokensResult = await PushToken.deleteMany({ userId: userObjectId });

    // External storage: profile image. deleteFromR2 logs and swallows its own errors.
    if (user.profileImageUrl) {
        const key = extractKeyFromUrl(user.profileImageUrl);
        if (key) {
            await deleteFromR2(key);
        }
    }

    await User.deleteOne({ _id: userObjectId });

    const removed = {
        messages: messagesResult.deletedCount ?? 0,
        notifications: notificationsResult.deletedCount ?? 0,
        blocks: blocksResult.deletedCount ?? 0,
        passkeys: passkeysResult.deletedCount ?? 0,
        identities: identitiesResult.deletedCount ?? 0,
        authChallenges: challengesResult.deletedCount ?? 0,
        pushTokens: pushTokensResult.deletedCount ?? 0,
    };

    logger.info('account.deleted', { userId, ...removed });

    return { deleted: true, removed };
}
