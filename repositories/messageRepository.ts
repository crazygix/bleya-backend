import mongoose from 'mongoose';
import { Message } from '../models/Message.js';
import type { LeanMessage } from '../types/lean.js';

export interface MessageRepository {
    create(data: {
        roomId: mongoose.Types.ObjectId;
        userId: mongoose.Types.ObjectId;
        text: string;
        parentMessageId: mongoose.Types.ObjectId | null;
    }): Promise<{
        _id: mongoose.Types.ObjectId;
        roomId: mongoose.Types.ObjectId;
        userId: mongoose.Types.ObjectId;
        text: string;
        createdAt: Date;
        parentMessageId: mongoose.Types.ObjectId | null;
        replyCount: number;
    }>;
    findByIdLean(id: string): Promise<LeanMessage | null>;
    incrementReplyCount(id: mongoose.Types.ObjectId): Promise<void>;
}

export class MongoMessageRepository implements MessageRepository {
    async create(data: {
        roomId: mongoose.Types.ObjectId;
        userId: mongoose.Types.ObjectId;
        text: string;
        parentMessageId: mongoose.Types.ObjectId | null;
    }) {
        const message = new Message(data);
        await message.save();
        return {
            _id: message._id as mongoose.Types.ObjectId,
            roomId: message.roomId as mongoose.Types.ObjectId,
            userId: message.userId as mongoose.Types.ObjectId,
            text: message.text as string,
            createdAt: message.createdAt as Date,
            parentMessageId: (message.parentMessageId as mongoose.Types.ObjectId | null) || null,
            replyCount: (message.replyCount as number) || 0,
        };
    }

    async findByIdLean(id: string) {
        return Message.findById(id).lean<LeanMessage | null>();
    }

    async incrementReplyCount(id: mongoose.Types.ObjectId) {
        await Message.updateOne({ _id: id }, { $inc: { replyCount: 1 } });
    }
}

export const messageRepository: MessageRepository = new MongoMessageRepository();
