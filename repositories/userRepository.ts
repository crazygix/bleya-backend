import mongoose from 'mongoose';
import { User, REFRESH_SESSION_FIELDS } from '../models/User.js';
import type { EnforcementState } from '../utils/enforcement.js';
import type { LeanFullUser, LeanUser, LeanJoinedRoomsUser } from '../types/lean.js';

// The owner of a refresh token, with what a refresh needs to decide whether the
// account may keep its session.
export type RefreshSessionUser = { _id: mongoose.Types.ObjectId } & EnforcementState;

// A refresh token being issued: the hash that is stored and when it expires.
export interface IssuedRefreshToken {
    hash: string;
    expiresAt: Date;
}

export interface UserRepository {
    findById(id: string): Promise<mongoose.Document | null>;
    findByIdLean(id: string): Promise<LeanFullUser | null>;
    findByIdSelectJoinedRooms(id: string): Promise<LeanJoinedRoomsUser | null>;
    findByIdSelectUsername(id: string): Promise<Pick<LeanUser, '_id' | 'username'> | null>;
    findEnforcementState(id: string): Promise<EnforcementState | null>;
    create(data?: Record<string, unknown>): Promise<mongoose.Document>;
    updateLastLogin(userId: string, lastLogin: Date): Promise<void>;
    findByUsernameLean(username: string): Promise<{ _id: mongoose.Types.ObjectId } | null>;
    // Replaces the unexpired current token `hash` with `next`, keeping `hash`
    // as the previous token until `previousValidUntil`.
    rotateRefreshToken(
        hash: string,
        now: Date,
        next: IssuedRefreshToken,
        previousValidUntil: Date
    ): Promise<RefreshSessionUser | null>;
    // Replaces the current token with `next` for a holder of the unexpired
    // previous token `hash`, when the current one was issued at or before
    // `issuedBefore`. The previous token and its expiry stay as they are.
    reissueFromPreviousRefreshToken(
        hash: string,
        now: Date,
        next: IssuedRefreshToken,
        issuedBefore: Date
    ): Promise<RefreshSessionUser | null>;
    // The owner of the unexpired previous token `hash`, when the current one
    // was issued after `issuedAfter`.
    findByRecentPreviousRefreshToken(
        hash: string,
        now: Date,
        issuedAfter: Date
    ): Promise<RefreshSessionUser | null>;
    // Ends the session `hash` belongs to, as its current or unexpired previous
    // token. Returns the id of the user whose session was cleared, if any.
    clearRefreshToken(hash: string, now: Date): Promise<string | null>;
    // Enforcement state of the user whose session a ban/suspension ended.
    findEnforcementByRevokedRefreshToken(hash: string): Promise<EnforcementState | null>;
    addToJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId): Promise<{ modifiedCount: number }>;
    removeFromJoinedRooms(userId: string, roomId: mongoose.Types.ObjectId): Promise<void>;
    existsWithRoom(userId: string, roomId: mongoose.Types.ObjectId): Promise<boolean>;
    findByIds(ids: mongoose.Types.ObjectId[], select: string): Promise<LeanUser[]>;
    findJoinedUserIds(roomId: mongoose.Types.ObjectId): Promise<string[]>;
}

const REFRESH_SESSION_USER_PROJECTION = { _id: 1, status: 1, suspendedUntil: 1, enforcementReason: 1 };

function toRefreshSessionUser(doc: RefreshSessionUser | null): RefreshSessionUser | null {
    if (!doc) return null;
    return {
        _id: doc._id,
        status: doc.status,
        suspendedUntil: doc.suspendedUntil,
        enforcementReason: doc.enforcementReason,
    };
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

    async findEnforcementState(id: string) {
        return User.findById(id)
            .select('status suspendedUntil enforcementReason')
            .lean<EnforcementState | null>();
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

    async rotateRefreshToken(hash: string, now: Date, next: IssuedRefreshToken, previousValidUntil: Date) {
        const doc = await User.findOneAndUpdate(
            { refreshTokenHash: hash, refreshTokenExpiresAt: { $gt: now } },
            {
                $set: {
                    refreshTokenHash: next.hash,
                    refreshTokenExpiresAt: next.expiresAt,
                    refreshTokenIssuedAt: now,
                    previousRefreshTokenHash: hash,
                    previousRefreshTokenExpiresAt: previousValidUntil,
                },
            },
            { new: true, projection: REFRESH_SESSION_USER_PROJECTION }
        ).lean<RefreshSessionUser | null>();
        return toRefreshSessionUser(doc);
    }

    async reissueFromPreviousRefreshToken(hash: string, now: Date, next: IssuedRefreshToken, issuedBefore: Date) {
        const doc = await User.findOneAndUpdate(
            {
                previousRefreshTokenHash: hash,
                previousRefreshTokenExpiresAt: { $gt: now },
                refreshTokenIssuedAt: { $lte: issuedBefore },
            },
            {
                $set: {
                    refreshTokenHash: next.hash,
                    refreshTokenExpiresAt: next.expiresAt,
                    refreshTokenIssuedAt: now,
                },
            },
            { new: true, projection: REFRESH_SESSION_USER_PROJECTION }
        ).lean<RefreshSessionUser | null>();
        return toRefreshSessionUser(doc);
    }

    async findByRecentPreviousRefreshToken(hash: string, now: Date, issuedAfter: Date) {
        const doc = await User.findOne({
            previousRefreshTokenHash: hash,
            previousRefreshTokenExpiresAt: { $gt: now },
            refreshTokenIssuedAt: { $gt: issuedAfter },
        })
            .select(REFRESH_SESSION_USER_PROJECTION)
            .lean<RefreshSessionUser | null>();
        return toRefreshSessionUser(doc);
    }

    async clearRefreshToken(hash: string, now: Date) {
        const doc = await User.findOneAndUpdate(
            {
                $or: [
                    { refreshTokenHash: hash },
                    { previousRefreshTokenHash: hash, previousRefreshTokenExpiresAt: { $gt: now } },
                ],
            },
            { $unset: Object.fromEntries(REFRESH_SESSION_FIELDS.map((field) => [field, ''])) },
            { projection: { _id: 1 } }
        ).lean<{ _id: mongoose.Types.ObjectId } | null>();
        return doc ? doc._id.toString() : null;
    }

    async findEnforcementByRevokedRefreshToken(hash: string) {
        const doc = await User.findOne({ revokedRefreshTokenHash: hash })
            .select('status suspendedUntil enforcementReason')
            .lean<EnforcementState | null>();
        if (!doc) return null;
        return {
            status: doc.status,
            suspendedUntil: doc.suspendedUntil,
            enforcementReason: doc.enforcementReason,
        };
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
