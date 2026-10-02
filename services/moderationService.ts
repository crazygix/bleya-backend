import mongoose from 'mongoose';
import { Message } from '../models/Message.js';
import { Notification } from '../models/Notification.js';
import { Room } from '../models/Room.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { recordModerationAction } from './auditService.js';
import { rememberBannedIdentities, forgetBannedIdentities } from './bannedIdentityService.js';
import { deleteFromR2, extractKeyFromUrl } from './r2Service.js';
import { deactivatePushTokensForUser } from './pushNotificationService.js';
import { getRoomSummaryRecipientIds } from './roomService.js';
import { emitMessageRemoved, disconnectUser } from '../server/socket.js';
import { User, REFRESH_SESSION_FIELDS } from '../models/User.js';
import logger from '../utils/logger.js';
import type { LeanMessage, LeanRoom } from '../types/lean.js';

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

type RemovedMessage = Pick<LeanMessage, '_id' | 'roomId' | 'userId' | 'parentMessageId' | 'createdAt'>;

// Reply notifications quote the reply and its thread root, so removed content
// must take its notifications with it. Returns who lost a notification, by
// removed message id, so their Activity can drop it live too.
async function deleteNotificationsForMessages(
    messageIds: mongoose.Types.ObjectId[]
): Promise<Map<string, Set<string>>> {
    const recipientsByMessageId = new Map<string, Set<string>>();
    if (messageIds.length === 0) {
        return recipientsByMessageId;
    }

    const quotingRemovedContent = {
        $or: [
            { message: { $in: messageIds } },
            { thread: { $in: messageIds } },
        ],
    };
    const notifications = await Notification.find(quotingRemovedContent)
        .select('recipient message thread')
        .lean<Array<{
            recipient: mongoose.Types.ObjectId;
            message: mongoose.Types.ObjectId;
            thread: mongoose.Types.ObjectId;
        }>>();
    await Notification.deleteMany(quotingRemovedContent);

    const removedIds = new Set(messageIds.map((id) => id.toString()));
    for (const notification of notifications) {
        for (const quoted of [notification.message, notification.thread]) {
            const quotedId = quoted.toString();
            if (!removedIds.has(quotedId)) {
                continue;
            }
            const recipients = recipientsByMessageId.get(quotedId) ?? new Set<string>();
            recipients.add(notification.recipient.toString());
            recipientsByMessageId.set(quotedId, recipients);
        }
    }

    return recipientsByMessageId;
}

// Everyone whose chat list shows the room, so a removed top-level message may
// be their preview of it: a DM's participants or a city room's members, the
// same people room_summary_updated goes to.
async function getRoomMemberIds(roomId: mongoose.Types.ObjectId): Promise<string[]> {
    const room = await Room.findById(roomId)
        .select('type participants')
        .lean<Pick<LeanRoom, 'type' | 'participants'> | null>();
    if (!room) {
        return [];
    }

    return getRoomSummaryRecipientIds(
        roomId.toString(),
        room.type || 'public',
        (room.participants || []).map((participant) => participant.toString())
    );
}

// Drops a removed message live, in one emit: from its room's open screens,
// from the chat lists of the room's members when it is top-level, and from the
// Activity of everyone whose notification went with it. Called once the
// removal and the notification clean-up are saved.
function announceMessageRemoval(
    message: RemovedMessage,
    roomMemberIds: readonly string[],
    notificationRecipients: ReadonlyMap<string, ReadonlySet<string>>
): void {
    const messageId = message._id.toString();
    const parentMessageId = message.parentMessageId ? message.parentMessageId.toString() : null;

    emitMessageRemoved(
        {
            messageId,
            roomId: message.roomId.toString(),
            parentMessageId,
            userId: message.userId.toString(),
            createdAt: message.createdAt.getTime(),
        },
        [
            ...(parentMessageId === null ? roomMemberIds : []),
            ...(notificationRecipients.get(messageId) ?? []),
        ]
    );
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

    const roomObjectId = message.roomId as mongoose.Types.ObjectId;
    const roomId = roomObjectId.toString();
    const parentMessageId = (message.parentMessageId as mongoose.Types.ObjectId | null) || null;
    // Read before the message changes, so a failed lookup changes nothing.
    const roomMemberIds = parentMessageId ? [] : await getRoomMemberIds(roomObjectId);

    if (!message.deletedAt) {
        message.deletedAt = new Date();
        message.deletedBy = actorLabel;
        message.deleteReason = deleteReason;
        await message.save();

        if (parentMessageId) {
            await recomputeReplyCount(parentMessageId);
        }
    }

    const notificationRecipients = await deleteNotificationsForMessages([id]);

    announceMessageRemoval(message, roomMemberIds, notificationRecipients);

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
    await deactivatePushTokensForUser(userId.toString(), 'account_blocked');
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

// Applies a ban or suspension and ends the refresh session, previous token
// included. The current token's hash moves to revokedRefreshTokenHash, so a
// refresh with it is answered with the reason instead of a bare 401 (see
// authService.refreshAccessToken). Values are $literal because an aggregation
// pipeline reads strings starting with '$' as field paths.
async function applyEnforcement(
    id: mongoose.Types.ObjectId,
    fields: { status: 'banned' | 'suspended'; enforcementReason: string; suspendedUntil: Date | null }
): Promise<void> {
    await User.updateOne({ _id: id }, [
        {
            $set: {
                status: { $literal: fields.status },
                enforcementReason: { $literal: fields.enforcementReason },
                suspendedUntil: { $literal: fields.suspendedUntil },
                revokedRefreshTokenHash: { $ifNull: ['$refreshTokenHash', '$revokedRefreshTokenHash'] },
            },
        },
        { $unset: [...REFRESH_SESSION_FIELDS] },
    ]);
}

async function assertUserExists(id: mongoose.Types.ObjectId): Promise<void> {
    const exists = await User.exists({ _id: id });
    if (!exists) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
}

// Ban: blocks connect + send indefinitely. Ends the refresh session so it can't
// be renewed, and force-disconnects live sockets. The current
// short-lived access token still works until it expires (revocation is
// deliberately not implemented), but socket messaging is cut immediately.
export async function banUser(userId: string, actorLabel: string, reason?: unknown): Promise<UserEnforcementResult> {
    const id = validateObjectId(userId, 'user ID');
    await assertUserExists(id);

    const enforcementReason = sanitizeReason(reason);
    await applyEnforcement(id, { status: 'banned', enforcementReason, suspendedUntil: null });

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

    await applyEnforcement(id, { status: 'suspended', enforcementReason, suspendedUntil });

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
        {
            $set: { status: 'active', enforcementReason: '', suspendedUntil: null },
            // The ended session stays ended; it just no longer explains itself.
            $unset: { revokedRefreshTokenHash: '' },
        }
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
        .select('_id roomId userId parentMessageId createdAt')
        .lean<RemovedMessage[]>();

    if (messages.length === 0) {
        return { id: id.toString(), removed: 0 };
    }

    // Members of each room with a removed top-level message, read before
    // anything changes, as in deleteMessage.
    const roomMemberIdsByRoomId = new Map<string, string[]>();
    for (const message of messages) {
        const roomId = message.roomId.toString();
        if (!message.parentMessageId && !roomMemberIdsByRoomId.has(roomId)) {
            roomMemberIdsByRoomId.set(roomId, await getRoomMemberIds(message.roomId));
        }
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

    const notificationRecipients = await deleteNotificationsForMessages(messageIds);

    // One event per removed message.
    for (const message of messages) {
        announceMessageRemoval(
            message,
            roomMemberIdsByRoomId.get(message.roomId.toString()) ?? [],
            notificationRecipients
        );
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
