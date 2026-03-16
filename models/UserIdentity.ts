import mongoose from 'mongoose';

const userIdentitySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    provider: {
        type: String,
        required: true,
        enum: ['google', 'apple'],
    },
    providerUserId: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        default: '',
        trim: true,
        lowercase: true,
    },
    emailVerified: {
        type: Boolean,
        default: false,
    },
    isPrivateRelay: {
        type: Boolean,
        default: false,
    },
    linkedAt: {
        type: Date,
        default: Date.now,
    },
    lastUsedAt: {
        type: Date,
        default: Date.now,
    },
});

userIdentitySchema.index({ provider: 1, providerUserId: 1 }, { unique: true });
userIdentitySchema.index({ email: 1, emailVerified: 1 });
userIdentitySchema.index({ userId: 1, provider: 1 }, { unique: true });

export const UserIdentity = mongoose.model('UserIdentity', userIdentitySchema);
