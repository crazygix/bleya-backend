import mongoose from 'mongoose';

const userBlockSchema = new mongoose.Schema({
    blockerUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    blockedUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
        required: true,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    blockedAt: {
        type: Date,
        default: Date.now,
    },
    unblockedAt: {
        type: Date,
        default: null,
    },
    source: {
        type: String,
        enum: ['user_action'],
        default: 'user_action',
    },
}, {
    timestamps: true,
});

// At most one active block for a given direction.
userBlockSchema.index(
    { blockerUserId: 1, blockedUserId: 1, isActive: 1 },
    {
        unique: true,
        partialFilterExpression: { isActive: true },
    }
);

// Efficient reverse checks (is this user blocked by anyone active).
userBlockSchema.index({ blockedUserId: 1, isActive: 1 });

// Efficient pair checks for DM send validation.
userBlockSchema.index({ blockerUserId: 1, blockedUserId: 1 });

export const UserBlock = mongoose.model('UserBlock', userBlockSchema);
