import mongoose from 'mongoose';
import { Message } from '../models/Message.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { recordModerationAction } from './auditService.js';
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

    const deleteReason = typeof reason === 'string'
        ? sanitizePlainText(reason, { maxLength: 500, collapseWhitespace: true, escapeHtml: true })
        : '';

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

    // Drop it from connected clients in the room in real time.
    emitMessageRemoved(roomId, { messageId: id.toString(), roomId });

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
        ? sanitizePlainText(reason, { maxLength: 500, collapseWhitespace: true, escapeHtml: true })
        : '';
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

    await recordModerationAction({
        actorLabel,
        action: 'user_unbanned',
        targetType: 'user',
        targetId: id,
    });

    logger.info('moderation.user_unbanned', { userId: id.toString(), actor: actorLabel });

    return { id: id.toString(), status: 'active', suspendedUntil: null, enforcementReason: '' };
}
