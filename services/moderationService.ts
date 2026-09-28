import mongoose from 'mongoose';
import { Message } from '../models/Message.js';
import { Notification } from '../models/Notification.js';
import { PushToken } from '../models/PushToken.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { recordModerationAction } from './auditService.js';
import { rememberBannedIdentities, forgetBannedIdentities } from './bannedIdentityService.js';
import { deleteFromR2, extractKeyFromUrl } from './r2Service.js';
import { emitMessageRemoved, disconnectUser } from '../server/socket.js';
import { User } from '../models/User.js';
import logger from '../utils/logger.js';

export interface MessageModerationResult {
    id: string;
    roomId: string;
    deleted: boolean;
}

// Recompute a parent's reply count from the non-deleted replies so soft-deleting
// or restoring a reply keeps the visible count accurate.
async function recomputeReplyCount(parentMessageId: mongoose.Types.ObjectId): Promise<void> {
    const count = await Message.countDocuments({ parentMessageId, deletedAt: null });
    await Message.updateOne({ _id: parentMessageId }, { $set: { replyCount: count } });
}

// Reply notifications quote the reply and its thread root, so removed content
// must take its notifications with it.
async function deleteNotificationsForMessages(messageIds: mongoose.Types.ObjectId[]): Promise<void> {
    if (messageIds.length === 0) {
        return;
    }

    await Notification.deleteMany({
        $or: [
            { message: { $in: messageIds } },
            { thread: { $in: messageIds } },
        ],
    });
}

export async function deleteMessage(
    messageId: string,
    actorLabel: string,
    reason?: unknown
): Promise<MessageModerationResult> {
    const id = validateObjectId(messageId, 'message ID');

    const message = await Message.findById(id);
    if (!message) {
        throw new NotFoundError('Message not found', ErrorCode.MESSAGE_NOT_FOUND);
    }

    const deleteReason = sanitizeReason(reason);

    const roomId = (message.roomId as mongoose.Types.ObjectId).toString();
    const parentMessageId = (message.parentMessageId as mongoose.Types.ObjectId | null) || null;

    if (!message.deletedAt) {
        message.deletedAt = new Date();
        message.deletedBy = actorLabel;
        message.deleteReason = deleteReason;
        await message.save();

        if (parentMessageId) {
            await recomputeReplyCount(parentMessageId);
        }
    }

    await deleteNotificationsForMessages([id]);

    // Drop it from connected clients in the room in real time.
    emitMessageRemoved(roomId, {
        messageId: id.toString(),
        roomId,
        parentMessageId: parentMessageId ? parentMessageId.toString() : null,
    });

    await recordModerationAction({
        actorLabel,
        action: 'message_deleted',
        targetType: 'message',
        targetId: id,
        reason: deleteReason,
        metadata: { roomId },
    });

    logger.info('moderation.message_deleted', { messageId: id.toString(), actor: actorLabel });

    return { id: id.toString(), roomId, deleted: true };
}

export async function restoreMessage(
    messageId: string,
    actorLabel: string
): Promise<MessageModerationResult> {
    const id = validateObjectId(messageId, 'message ID');

    const message = await Message.findById(id);
    if (!message) {
        throw new NotFoundError('Message not found', ErrorCode.MESSAGE_NOT_FOUND);
    }

    const roomId = (message.roomId as mongoose.Types.ObjectId).toString();
    const parentMessageId = (message.parentMessageId as mongoose.Types.ObjectId | null) || null;

    if (message.deletedAt) {
        await Message.updateOne(
            { _id: id },
            { $set: { deletedAt: null, deletedBy: '', deleteReason: '' } }
        );

        if (parentMessageId) {
            await recomputeReplyCount(parentMessageId);
        }
    }

    await recordModerationAction({
        actorLabel,
        action: 'message_restored',
        targetType: 'message',
        targetId: id,
        metadata: { roomId },
    });

    logger.info('moderation.message_restored', { messageId: id.toString(), actor: actorLabel });

    return { id: id.toString(), roomId, deleted: false };
}

// ---------------------------------------------------------------------------
// User enforcement (ban / suspend / unban)
// ---------------------------------------------------------------------------

export interface UserEnforcementResult {
    id: string;
    status: string;
    suspendedUntil: number | null;
    enforcementReason: string;
}

function sanitizeReason(reason: unknown): string {
    return typeof reason === 'string'
        ? sanitizePlainText(reason, { maxLength: 500, collapseWhitespace: true })
        : '';
}

// A banned/suspended user must stop receiving pushes right away; the app
// re-registers its token after the next successful sign-in.
async function deactivatePushTokens(userId: mongoose.Types.ObjectId): Promise<void> {
    await PushToken.updateMany({ userId }, { $set: { isActive: false, failureReason: 'account_blocked' } });
}

function parseSuspendedUntil(value: unknown): Date | null {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    let date: Date;
    if (typeof value === 'number') {
        date = new Date(value);
    } else if (typeof value === 'string') {
        date = new Date(value);
    } else {
        throw new ValidationError('suspendedUntil must be a date string or a timestamp.');
    }
    if (Number.isNaN(date.getTime())) {
        throw new ValidationError('suspendedUntil is not a valid date.');
    }
    return date;
}

async function assertUserExists(id: mongoose.Types.ObjectId): Promise<void> {
    const exists = await User.exists({ _id: id });
    if (!exists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
}

// Ban: blocks connect + send indefinitely. Clears the refresh-token hash so the
// session can't be renewed, and force-disconnects live sockets. The current
// short-lived access token still works until it expires (revocation is
// deliberately not implemented), but socket messaging is cut immediately.
export async function banUser(userId: string, actorLabel: string, reason?: unknown): Promise<UserEnforcementResult> {
    const id = validateObjectId(userId, 'user ID');
    await assertUserExists(id);

    const enforcementReason = sanitizeReason(reason);
    await User.updateOne(
        { _id: id },
        {
            $set: { status: 'banned', enforcementReason, suspendedUntil: null },
            $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
        }
    );

    disconnectUser(id.toString());
    await deactivatePushTokens(id);
    await rememberBannedIdentities(id.toString(), null);

    await recordModerationAction({
        actorLabel,
        action: 'user_banned',
        targetType: 'user',
        targetId: id,
        reason: enforcementReason,
    });

    logger.info('moderation.user_banned', { userId: id.toString(), actor: actorLabel });

    return { id: id.toString(), status: 'banned', suspendedUntil: null, enforcementReason };
}

export async function suspendUser(
    userId: string,
    actorLabel: string,
    reason?: unknown,
    suspendedUntilInput?: unknown
): Promise<UserEnforcementResult> {
    const id = validateObjectId(userId, 'user ID');
    await assertUserExists(id);

    const enforcementReason = sanitizeReason(reason);
    const suspendedUntil = parseSuspendedUntil(suspendedUntilInput);

    await User.updateOne(
        { _id: id },
        {
            $set: { status: 'suspended', enforcementReason, suspendedUntil },
            $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' },
        }
    );

    disconnectUser(id.toString());
    await deactivatePushTokens(id);
    // Deleting the account and signing up again must not end a suspension early.
    await rememberBannedIdentities(id.toString(), suspendedUntil);

    await recordModerationAction({
        actorLabel,
        action: 'user_suspended',
        targetType: 'user',
        targetId: id,
        reason: enforcementReason,
        metadata: { suspendedUntil: suspendedUntil ? suspendedUntil.getTime() : null },
    });

    logger.info('moderation.user_suspended', { userId: id.toString(), actor: actorLabel });

    return {
        id: id.toString(),
        status: 'suspended',
        suspendedUntil: suspendedUntil ? suspendedUntil.getTime() : null,
        enforcementReason,
    };
}

export async function unbanUser(userId: string, actorLabel: string): Promise<UserEnforcementResult> {
    const id = validateObjectId(userId, 'user ID');
    await assertUserExists(id);

    await User.updateOne(
        { _id: id },
        { $set: { status: 'active', enforcementReason: '', suspendedUntil: null } }
    );
    await forgetBannedIdentities(id.toString());

    await recordModerationAction({
        actorLabel,
        action: 'user_unbanned',
        targetType: 'user',
        targetId: id,
    });

    logger.info('moderation.user_unbanned', { userId: id.toString(), actor: actorLabel });

    return { id: id.toString(), status: 'active', suspendedUntil: null, enforcementReason: '' };
}

// ---------------------------------------------------------------------------
// Profile and bulk content removal
// ---------------------------------------------------------------------------

export const CLEARABLE_PROFILE_FIELDS = ['username', 'bio', 'avatar'] as const;
type ClearableProfileField = (typeof CLEARABLE_PROFILE_FIELDS)[number];

export interface ClearProfileResult {
    id: string;
    cleared: ClearableProfileField[];
}

function parseProfileFields(value: unknown): ClearableProfileField[] {
    if (value === undefined || value === null) {
        return [...CLEARABLE_PROFILE_FIELDS];
    }
    if (!Array.isArray(value) || value.length === 0) {
        throw new ValidationError(`fields must be a non-empty array of: ${CLEARABLE_PROFILE_FIELDS.join(', ')}.`);
    }
    const allowed = new Set<string>(CLEARABLE_PROFILE_FIELDS);
    for (const field of value) {
        if (typeof field !== 'string' || !allowed.has(field)) {
            throw new ValidationError(`fields must be a non-empty array of: ${CLEARABLE_PROFILE_FIELDS.join(', ')}.`);
        }
    }
    return [...new Set(value as ClearableProfileField[])];
}

/**
 * Removes abusive profile content. A cleared username makes the app ask the user
 * to pick a new one at their next sign-in; the avatar file is deleted from R2.
 */
export async function clearUserProfile(
    userId: string,
    actorLabel: string,
    fieldsInput?: unknown,
    reason?: unknown
): Promise<ClearProfileResult> {
    const id = validateObjectId(userId, 'user ID');
    const fields = parseProfileFields(fieldsInput);

    const user = await User.findById(id).select('profileImageUrl').lean<{ profileImageUrl?: string } | null>();
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (fields.includes('username')) update.username = '';
    if (fields.includes('bio')) update.bio = '';
    if (fields.includes('avatar')) update.profileImageUrl = '';
    await User.updateOne({ _id: id }, { $set: update });

    if (fields.includes('avatar') && user.profileImageUrl) {
        const key = extractKeyFromUrl(user.profileImageUrl);
        if (key) {
            await deleteFromR2(key);
        }
    }

    const cleanReason = sanitizeReason(reason);
    await recordModerationAction({
        actorLabel,
        action: 'user_profile_cleared',
        targetType: 'user',
        targetId: id,
        reason: cleanReason,
        metadata: { fields },
    });

    logger.info('moderation.user_profile_cleared', { userId: id.toString(), fields, actor: actorLabel });

    return { id: id.toString(), cleared: fields };
}

export interface RemoveUserMessagesResult {
    id: string;
    removed: number;
}

/**
 * Soft-deletes every visible message a user has posted (optionally only in one
 * room), like deleteMessage does for a single one.
 */
export async function removeUserMessages(
    userId: string,
    actorLabel: string,
    reason?: unknown,
    roomIdInput?: unknown
): Promise<RemoveUserMessagesResult> {
    const id = validateObjectId(userId, 'user ID');
    await assertUserExists(id);

    const filter: Record<string, unknown> = { userId: id, deletedAt: null };
    if (roomIdInput !== undefined && roomIdInput !== null && roomIdInput !== '') {
        if (typeof roomIdInput !== 'string') {
            throw new ValidationError('roomId must be a string.');
        }
        filter.roomId = validateObjectId(roomIdInput, 'room ID');
    }

    const messages = await Message.find(filter)
        .select('_id roomId parentMessageId')
        .lean<Array<{ _id: mongoose.Types.ObjectId; roomId: mongoose.Types.ObjectId; parentMessageId?: mongoose.Types.ObjectId | null }>>();

    if (messages.length === 0) {
        return { id: id.toString(), removed: 0 };
    }

    const deleteReason = sanitizeReason(reason);
    const messageIds = messages.map((message) => message._id);
    await Message.updateMany(
        { _id: { $in: messageIds }, deletedAt: null },
        { $set: { deletedAt: new Date(), deletedBy: actorLabel, deleteReason } }
    );

    const parentIds = new Map<string, mongoose.Types.ObjectId>();
    for (const message of messages) {
        if (message.parentMessageId) {
            parentIds.set(message.parentMessageId.toString(), message.parentMessageId);
        }
    }
    for (const parentId of parentIds.values()) {
        await recomputeReplyCount(parentId);
    }

    await deleteNotificationsForMessages(messageIds);

    for (const message of messages) {
        emitMessageRemoved(message.roomId.toString(), {
            messageId: message._id.toString(),
            roomId: message.roomId.toString(),
            parentMessageId: message.parentMessageId ? message.parentMessageId.toString() : null,
        });
    }

    await recordModerationAction({
        actorLabel,
        action: 'user_messages_removed',
        targetType: 'user',
        targetId: id,
        reason: deleteReason,
        metadata: { count: messages.length, roomId: filter.roomId ? String(filter.roomId) : null },
    });

    logger.info('moderation.user_messages_removed', { userId: id.toString(), count: messages.length, actor: actorLabel });

    return { id: id.toString(), removed: messages.length };
}
