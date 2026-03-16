import mongoose from 'mongoose';
import { AuthChallenge } from '../models/AuthChallenge.js';

export interface StoredAuthChallenge {
    _id: mongoose.Types.ObjectId;
    ceremony: 'passkey-registration' | 'passkey-authentication';
    challenge: string;
    userId?: mongoose.Types.ObjectId;
    createdAt?: Date;
}

export interface AuthChallengeRepository {
    create(data: {
        ceremony: 'passkey-registration' | 'passkey-authentication';
        challenge: string;
        userId?: string;
    }): Promise<StoredAuthChallenge>;
    findById(challengeId: string): Promise<StoredAuthChallenge | null>;
    deleteById(challengeId: string): Promise<void>;
}

export class MongoAuthChallengeRepository implements AuthChallengeRepository {
    async create(data: {
        ceremony: 'passkey-registration' | 'passkey-authentication';
        challenge: string;
        userId?: string;
    }) {
        const created = await AuthChallenge.create({
            ceremony: data.ceremony,
            challenge: data.challenge,
            ...(data.userId ? { userId: new mongoose.Types.ObjectId(data.userId) } : {}),
        });

        return {
            _id: created._id as mongoose.Types.ObjectId,
            ceremony: created.ceremony as 'passkey-registration' | 'passkey-authentication',
            challenge: created.challenge,
            userId: created.userId as mongoose.Types.ObjectId | undefined,
            createdAt: created.createdAt,
        };
    }

    async findById(challengeId: string) {
        return AuthChallenge.findById(new mongoose.Types.ObjectId(challengeId)).lean<StoredAuthChallenge | null>();
    }

    async deleteById(challengeId: string) {
        await AuthChallenge.deleteOne({ _id: new mongoose.Types.ObjectId(challengeId) });
    }
}

export const authChallengeRepository: AuthChallengeRepository = new MongoAuthChallengeRepository();
