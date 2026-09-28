import crypto from 'crypto';
import mongoose from 'mongoose';
import { BannedIdentity } from '../models/BannedIdentity.js';
import { UserIdentity } from '../models/UserIdentity.js';
import { config } from '../config/index.js';

function hashIdentity(provider: string, providerUserId: string): string {
    return crypto
        .createHmac('sha256', config.identityHashSecret)
        .update(`${provider}:${providerUserId}`)
        .digest('hex');
}

async function identityHashesForUser(userId: string): Promise<string[]> {
    const identities = await UserIdentity.find({ userId: new mongoose.Types.ObjectId(userId) })
        .select('provider providerUserId')
        .lean<Array<{ provider: string; providerUserId: string }>>();
    return identities.map((identity) => hashIdentity(identity.provider, identity.providerUserId));
}

/**
 * Records the user's sign-in identities as banned. `expiresAt` null = permanent
 * (ban); a date = until the suspension ends.
 */
export async function rememberBannedIdentities(userId: string, expiresAt: Date | null): Promise<void> {
    const hashes = await identityHashesForUser(userId);
    await Promise.all(hashes.map((identityHash) => BannedIdentity.updateOne(
        { identityHash },
        { $set: { expiresAt } },
        { upsert: true }
    )));
}

export async function forgetBannedIdentities(userId: string): Promise<void> {
    const hashes = await identityHashesForUser(userId);
    if (hashes.length > 0) {
        await BannedIdentity.deleteMany({ identityHash: { $in: hashes } });
    }
}

export async function isIdentityBanned(provider: string, providerUserId: string): Promise<boolean> {
    const record = await BannedIdentity.findOne({ identityHash: hashIdentity(provider, providerUserId) })
        .select('expiresAt')
        .lean<{ expiresAt?: Date | null } | null>();

    if (!record) {
        return false;
    }

    // The TTL monitor runs about once a minute, so check the date too.
    return !record.expiresAt || record.expiresAt.getTime() > Date.now();
}
