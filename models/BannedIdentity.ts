import mongoose from 'mongoose';

// Remembers the sign-in identities (Apple/Google subject) of banned or
// suspended accounts so deleting the account and signing up again doesn't
// evade enforcement. Only a keyed hash is stored — never the raw provider id,
// email or any link to the deleted account.
const bannedIdentitySchema = new mongoose.Schema({
    identityHash: {
        type: String,
        required: true,
        unique: true,
    },
    // null = permanent (ban). A date = ends with the suspension; the TTL index
    // below removes the record once it passes.
    expiresAt: {
        type: Date,
        default: null,
    },
}, {
    timestamps: true,
});

// TTL: documents whose expiresAt is not a date (null) never expire.
bannedIdentitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BannedIdentity = mongoose.model('BannedIdentity', bannedIdentitySchema);
