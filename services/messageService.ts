import mongoose from 'mongoose';
import { UserBlock } from '../models/UserBlock.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { AppError, ValidationError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { NotificationService, UserNotifyTarget } from './NotificationService.js';
import { User } from '../models/User.js';
import type { LeanRoom, LeanMessage, LeanUserBlock } from '../types/lean.js';
import type { FormattedMessage } from '../utils/message.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';
import { type RoomRepository, roomRepository as defaultRoomRepo } from '../repositories/roomRepository.js';
import { type MessageRepository, messageRepository as defaultMessageRepo } from '../repositories/messageRepository.js';

export interface CreateMessageInput {
    userId: string;
    roomId: string;
    text: string;
    parentMessageId?: string;
}

export interface CreateMessageResult {
    messageData: FormattedMessage;
    notificationTargets: UserNotifyTarget[];
    isTopLevel: boolean;
    roomType: 'public' | 'private';
    roomParticipants: string[];
}

export interface MessageServiceDeps {
    userRepo: UserRepository;
    roomRepo: RoomRepository;
    messageRepo: MessageRepository;
}

export function createMessageService(deps: MessageServiceDeps) {
    const { userRepo, roomRepo, messageRepo } = deps;

    async function createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
        const roomObjectId = new mongoose.Types.ObjectId(input.roomId);
        const senderObjectId = new mongoose.Types.ObjectId(input.userId);

        const room = await roomRepo.findById(roomObjectId, '_id type participants');

        if (!room) {
            throw new AppError(ErrorCode.ROOM_NOT_FOUND, 'Room not found', 404);
        }

        const senderInRoom = await userRepo.existsWithRoom(input.userId, roomObjectId);
        if (!senderInRoom) {
            throw new AppError(ErrorCode.FORBIDDEN, 'You are not a member of this room', 403);
        }

        let privateRoomOtherParticipantId: mongoose.Types.ObjectId | null = null;
        if ((room.type || 'public') === 'private') {
            const participants = room.participants || [];
            const senderIsParticipant = participants.some((id) => id.equals(senderObjectId));

            if (!senderIsParticipant) {
                throw new AppError(ErrorCode.FORBIDDEN, 'You are not allowed to message in this chat', 403);
            }

            const otherParticipant = participants.find((id) => !id.equals(senderObjectId));
            if (!otherParticipant) {
                throw new ValidationError('Private chat participants are invalid');
            }

            privateRoomOtherParticipantId = otherParticipant;

            const activeBlock = await UserBlock.findOne({
                isActive: true,
                $or: [
                    { blockerUserId: senderObjectId, blockedUserId: otherParticipant },
                    { blockerUserId: otherParticipant, blockedUserId: senderObjectId },
                ],
            }).select('blockerUserId blockedUserId').lean<LeanUserBlock | null>();

            if (activeBlock) {
                const blockedBySender = activeBlock.blockerUserId.toString() === senderObjectId.toString();
                throw new AppError(
                    ErrorCode.USER_BLOCKED,
                    blockedBySender
                        ? 'You blocked this user. Unblock them to send messages.'
                        : 'This user is unavailable for direct messages.',
                    403
                );
            }
        }

        const sanitizedText = sanitizePlainText(input.text || '', {
            maxLength: 2000,
            collapseWhitespace: true,
            escapeHtml: true,
        });

        if (!sanitizedText || sanitizedText.trim().length === 0) {
            throw new ValidationError('Message cannot be empty');
        }

        let parentObjectId: mongoose.Types.ObjectId | null = null;
        if (input.parentMessageId) {
            parentObjectId = validateObjectId(input.parentMessageId, 'parent message ID');

            const parentMessage = await messageRepo.findByIdLean(input.parentMessageId);
            if (!parentMessage) {
                throw new AppError(ErrorCode.NOT_FOUND, 'Parent message not found', 404);
            }

            if (parentMessage.roomId.toString() !== input.roomId) {
                throw new ValidationError('Parent message not in this room');
            }
        }

        const message = await messageRepo.create({
            roomId: roomObjectId,
            userId: senderObjectId,
            text: sanitizedText,
            parentMessageId: parentObjectId,
        });

        if (parentObjectId) {
            await messageRepo.incrementReplyCount(parentObjectId);
        }

        // New top-level DMs should un-hide the chat for both participants
        if (!parentObjectId && privateRoomOtherParticipantId) {
            await User.updateMany(
                { _id: { $in: [senderObjectId, privateRoomOtherParticipantId] } },
                { $pull: { hiddenDirectRooms: roomObjectId } }
            );
        }

        const senderUser = await userRepo.findByIdSelectUsername(input.userId);

        const messageData: FormattedMessage = {
            id: message._id.toString(),
            roomId: message.roomId.toString(),
            userId: message.userId.toString(),
            username: senderUser?.username || '',
            text: message.text,
            createdAt: message.createdAt.getTime(),
            parentMessageId: message.parentMessageId?.toString() || null,
            replyCount: message.replyCount || 0,
        };

        let notificationTargets: UserNotifyTarget[] = [];
        if (parentObjectId) {
            notificationTargets = await NotificationService.createReplyNotification({
                senderId: message.userId.toString(),
                roomId: message.roomId.toString(),
                parentMessageId: parentObjectId.toString(),
                replyMessageId: message._id.toString(),
            });
        }

        return {
            messageData,
            notificationTargets,
            isTopLevel: !parentObjectId,
            roomType: (room.type || 'public') as 'public' | 'private',
            roomParticipants: (room.participants || []).map((id) => id.toString()),
        };
    }

    return { createMessage };
}

const defaultMessageService = createMessageService({
    userRepo: defaultUserRepo,
    roomRepo: defaultRoomRepo,
    messageRepo: defaultMessageRepo,
});

export const createMessage = defaultMessageService.createMessage;
