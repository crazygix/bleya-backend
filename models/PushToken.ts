import mongoose from 'mongoose';

const pushTokenSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
    },
    token: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    platform: {
        type: String,
        enum: ['ios', 'android'],
        required: true,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    lastSeenAt: {
        type: Date,
        default: Date.now,
    },
    lastSuccessAt: {
        type: Date,
        default: null,
    },
    lastFailureAt: {
        type: Date,
        default: null,
    },
    failureReason: {
        type: String,
        default: '',
    },
}, {
    timestamps: true,
});

pushTokenSchema.index({ userId: 1, isActive: 1 });

export const PushToken = mongoose.model('PushToken', pushTokenSchema);
