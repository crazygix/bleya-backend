import mongoose from 'mongoose';

const passkeyCredentialSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    credentialId: {
        type: String,
        required: true,
        unique: true,
    },
    publicKey: {
        type: String,
        required: true,
    },
    counter: {
        type: Number,
        required: true,
        default: 0,
    },
    transports: {
        type: [String],
        default: [],
    },
    deviceType: {
        type: String,
        default: 'unknown',
    },
    backedUp: {
        type: Boolean,
        default: false,
    },
    aaguid: {
        type: String,
        default: '',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastUsedAt: {
        type: Date,
        default: Date.now,
    },
});

passkeyCredentialSchema.index({ userId: 1, credentialId: 1 }, { unique: true });

export const PasskeyCredential = mongoose.model('PasskeyCredential', passkeyCredentialSchema);
