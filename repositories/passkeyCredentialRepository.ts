import mongoose from 'mongoose';
import { PasskeyCredential } from '../models/PasskeyCredential.js';

export interface StoredPasskeyCredential {
    _id?: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    deviceType?: string;
    backedUp?: boolean;
    aaguid?: string;
    createdAt?: Date;
    lastUsedAt?: Date;
}

export interface PasskeyCredentialRepository {
    listForUser(userId: string): Promise<StoredPasskeyCredential[]>;
    findByCredentialId(credentialId: string): Promise<StoredPasskeyCredential | null>;
    create(data: {
        userId: string;
        credentialId: string;
        publicKey: string;
        counter: number;
        transports: string[];
        deviceType: string;
        backedUp: boolean;
        aaguid: string;
    }): Promise<void>;
    updateCounterAndLastUsed(credentialId: string, counter: number): Promise<void>;
    existsForUser(userId: string): Promise<boolean>;
}

export class MongoPasskeyCredentialRepository implements PasskeyCredentialRepository {
    async listForUser(userId: string) {
        return PasskeyCredential.find({ userId: new mongoose.Types.ObjectId(userId) })
            .sort({ createdAt: 1 })
            .lean<StoredPasskeyCredential[]>();
    }

    async findByCredentialId(credentialId: string) {
        return PasskeyCredential.findOne({ credentialId }).lean<StoredPasskeyCredential | null>();
    }

    async create(data: {
        userId: string;
        credentialId: string;
        publicKey: string;
        counter: number;
        transports: string[];
        deviceType: string;
        backedUp: boolean;
        aaguid: string;
    }) {
        await PasskeyCredential.create({
            userId: new mongoose.Types.ObjectId(data.userId),
            credentialId: data.credentialId,
            publicKey: data.publicKey,
            counter: data.counter,
            transports: data.transports,
            deviceType: data.deviceType,
            backedUp: data.backedUp,
            aaguid: data.aaguid,
            createdAt: new Date(),
            lastUsedAt: new Date(),
        });
    }

    async updateCounterAndLastUsed(credentialId: string, counter: number) {
        await PasskeyCredential.updateOne(
            { credentialId },
            { $set: { counter, lastUsedAt: new Date() } }
        );
    }

    async existsForUser(userId: string) {
        const result = await PasskeyCredential.exists({ userId: new mongoose.Types.ObjectId(userId) });
        return !!result;
    }
}

export const passkeyCredentialRepository: PasskeyCredentialRepository = new MongoPasskeyCredentialRepository();
