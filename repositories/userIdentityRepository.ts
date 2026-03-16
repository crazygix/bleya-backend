import mongoose from 'mongoose';
import { UserIdentity } from '../models/UserIdentity.js';

export interface StoredUserIdentity {
    _id?: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    provider: 'google' | 'apple';
    providerUserId: string;
    email?: string;
    emailVerified?: boolean;
    isPrivateRelay?: boolean;
    linkedAt?: Date;
    lastUsedAt?: Date;
}

export interface UserIdentityRepository {
    findByProviderIdentity(provider: 'google' | 'apple', providerUserId: string): Promise<StoredUserIdentity | null>;
    findByUserId(userId: string): Promise<StoredUserIdentity[]>;
    findVerifiedByEmail(email: string): Promise<StoredUserIdentity[]>;
    create(data: {
        userId: string;
        provider: 'google' | 'apple';
        providerUserId: string;
        email: string;
        emailVerified: boolean;
        isPrivateRelay: boolean;
    }): Promise<StoredUserIdentity>;
    updateLastUsed(identityId: string): Promise<void>;
}

export class MongoUserIdentityRepository implements UserIdentityRepository {
    async findByProviderIdentity(provider: 'google' | 'apple', providerUserId: string) {
        return UserIdentity.findOne({ provider, providerUserId }).lean<StoredUserIdentity | null>();
    }

    async findByUserId(userId: string) {
        return UserIdentity.find({ userId: new mongoose.Types.ObjectId(userId) })
            .sort({ linkedAt: 1 })
            .lean<StoredUserIdentity[]>();
    }

    async findVerifiedByEmail(email: string) {
        return UserIdentity.find({
            email,
            emailVerified: true,
        }).lean<StoredUserIdentity[]>();
    }

    async create(data: {
        userId: string;
        provider: 'google' | 'apple';
        providerUserId: string;
        email: string;
        emailVerified: boolean;
        isPrivateRelay: boolean;
    }) {
        const created = await UserIdentity.create({
            userId: new mongoose.Types.ObjectId(data.userId),
            provider: data.provider,
            providerUserId: data.providerUserId,
            email: data.email,
            emailVerified: data.emailVerified,
            isPrivateRelay: data.isPrivateRelay,
            linkedAt: new Date(),
            lastUsedAt: new Date(),
        });

        return {
            _id: created._id as mongoose.Types.ObjectId,
            userId: created.userId as mongoose.Types.ObjectId,
            provider: created.provider as 'google' | 'apple',
            providerUserId: created.providerUserId,
            email: created.email,
            emailVerified: created.emailVerified,
            isPrivateRelay: created.isPrivateRelay,
            linkedAt: created.linkedAt,
            lastUsedAt: created.lastUsedAt,
        };
    }

    async updateLastUsed(identityId: string) {
        await UserIdentity.updateOne(
            { _id: new mongoose.Types.ObjectId(identityId) },
            { $set: { lastUsedAt: new Date() } }
        );
    }
}

export const userIdentityRepository: UserIdentityRepository = new MongoUserIdentityRepository();
