import mongoose from 'mongoose';

const authChallengeSchema = new mongoose.Schema({
    ceremony: {
        type: String,
        required: true,
        enum: ['passkey-registration', 'passkey-authentication'],
    },
    challenge: {
        type: String,
        required: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 5 * 60,
    },
});

export const AuthChallenge = mongoose.model('AuthChallenge', authChallengeSchema);
