import mongoose from 'mongoose';
import { User } from '../models/User.js';
import type { LeanFullUser, LeanUser, LeanJoinedRoomsUser } from '../types/lean.js';

export interface UserRepository {
    findById(id: string): Promise<mongoose.Document | null>;
    findByIdLean(id: string): Promise<LeanFullUser | null>;
    findByIdSelectJoinedRooms(id: string): Promise<LeanJoinedRoomsUser | null>;
    findByIdSelectUsername(id: string): Promise<Pick<LeanUser, '_id' | 'username'> | null>;
    create(data?: Record<string, unknown>): Promise<mongoose.Document>;
    updateLastLogin(userId: string, lastLogin: Date): Promise<void>;
    findByUsernameLean(username: string): Promise<{ _id: mongoose.Types.ObjectId } | null>;
    findOneAndUpdateByRefreshToken(
        hash: string,
        expiresAfter: Date,
        update: Record<string, unknown>
    ): Promise<{ _id: mongoose.Types.ObjectId } | null>;
    clearRefreshToken(hash: string): Promise<void>;
    addToJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId): Promise<{ modifiedCount: number }>;
    removeFromJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId): Promise<void>;
    existsWithRoom(userId: string, roomId: mongoose.Types.ObjectId): Promise<boolean>;
    findByIds(ids: mongoose.Types.ObjectId[], select: string): Promise<LeanUser[]>;
    findJoinedUserIds(roomId: mongoose.Types.ObjectId): Promise<string[]>;
}

export class MongoUserRepository implements UserRepository {
    async findById(id: string) {
        return User.findById(id);
    }

    async findByIdLean(id: string) {
        return User.findById(id).lean<LeanFullUser | null>();
    }

    async findByIdSelectJoinedRooms(id: string) {
        return User.findById(id).select('joinedRooms').lean<LeanJoinedRoomsUser | null>();
    }

    async findByIdSelectUsername(id: string) {
        return User.findById(id).select('_id username').lean<Pick<LeanUser, '_id' | 'username'> | null>();
    }

    async create(data: Record<string, unknown> = {}) {
        return User.create(data);
    }

    async updateLastLogin(userId: string, lastLogin: Date) {
        await User.updateOne({ _id: userId }, { $set: { lastLogin } });
    }

    async findByUsernameLean(username: string) {
        return User.findOne({ username }).select('_id').lean<{ _id: mongoose.Types.ObjectId } | null>();
    }

    async findOneAndUpdateByRefreshToken(
        hash: string,
        expiresAfter: Date,
        update: Record<string, unknown>
    ): Promise<{ _id: mongoose.Types.ObjectId } | null> {
        const doc = await User.findOneAndUpdate(
            { refreshTokenHash: hash, refreshTokenExpiresAt: { $gt: expiresAfter } },
            update,
            { new: true }
        );
        if (!doc) return null;
        return { _id: doc._id as mongoose.Types.ObjectId };
    }

    async clearRefreshToken(hash: string) {
        await User.findOneAndUpdate(
            { refreshTokenHash: hash },
            { $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' } }
        );
    }

    async addToJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId) {
        return User.updateOne(
            { _id: userId, joinedRooms: { $ne: roomId } },
            { $addToSet: { joinedRooms: roomId } }
        );
    }

    async removeFromJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId) {
        await User.updateOne({ _id: userId }, { $pull: { joinedRooms: roomId } });
    }

    async existsWithRoom(userId: string, roomId: mongoose.Types.ObjectId) {
        const result = await User.exists({ _id: userId, joinedRooms: roomId });
        return !!result;
    }

    async findByIds(ids: mongoose.Types.ObjectId[], select: string) {
        return User.find({ _id: { $in: ids } }).select(select).lean<LeanUser[]>();
    }

    async findJoinedUserIds(roomId: mongoose.Types.ObjectId) {
        const users = await User.find({ joinedRooms: roomId })
            .select('_id')
            .lean<Array<{ _id: mongoose.Types.ObjectId }>>();

        return users.map((user) => user._id.toString());
    }
}

export const userRepository: UserRepository = new MongoUserRepository();
