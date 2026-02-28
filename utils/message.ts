import mongoose from 'mongoose';
import type { LeanMessage, LeanUser } from '../types/lean.js';
import { User } from '../models/User.js';

export interface FormattedMessage {
    id: string;
    roomId: string;
    userId: string;
    username: string;
    text: string;
    createdAt: number;
    parentMessageId: string | null;
    replyCount: number;
}

export function formatMessage(
    msg: LeanMessage,
    usernameMap: Map<string, string>
): FormattedMessage {
    return {
        id: msg._id.toString(),
        roomId: msg.roomId.toString(),
        userId: msg.userId.toString(),
        username: usernameMap.get(msg.userId.toString()) || '',
        text: msg.text,
        createdAt: msg.createdAt.getTime(),
        parentMessageId: msg.parentMessageId?.toString() || null,
        replyCount: msg.replyCount || 0,
    };
}

export function buildUsernameMap(
    users: Array<Pick<LeanUser, '_id' | 'username'>>
): Map<string, string> {
    return new Map(users.map((u) => [u._id.toString(), u.username || '']));
}

export async function fetchUsernameMap(
    userIds: string[]
): Promise<Map<string, string>> {
    if (userIds.length === 0) {
        return new Map();
    }

    const objectIds = userIds.map((id) => new mongoose.Types.ObjectId(id));
    const users = await User.find({ _id: { $in: objectIds } })
        .select('_id username')
        .lean<Array<Pick<LeanUser, '_id' | 'username'>>>();

    return buildUsernameMap(users);
}
