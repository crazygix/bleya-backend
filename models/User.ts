import mongoose from 'mongoose';
import { isValidUsername } from '../utils/username.js';

const userSchema = new mongoose.Schema({
    refreshTokenHash: {
        type: String,
        // Excluded from queries by default so it can never leak through a raw
        // user response; the refresh flow selects it explicitly where needed.
        select: false,
    },
    refreshTokenExpiresAt: {
        type: Date,
        select: false,
    },
    username: {
        type: String,
        default: '',
        trim: true,
        validate: {
            validator: function (v: string) {
                // Allow empty string (for existing users without username)
                if (!v || v.length === 0) return true;
                // Username must be 3-30 characters, alphanumeric and underscores only
                return isValidUsername(v);
            },
            message: 'Username must be 3-30 characters and contain only lowercase letters, numbers, and underscores'
        }
    },
    bio: {
        type: String,
        default: '',
    },
    profileImageUrl: {
        type: String,
        default: '',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
    lastLogin: {
        type: Date,
        default: Date.now,
    },
    joinedRooms: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'Room',
        default: [],
    },
    // Per-user hidden direct rooms ("delete chat" is a soft-hide).
    hiddenDirectRooms: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'Room',
        default: [],
    },
    // Per-room read pointers for chat messages.
    // Stores the last time the user has read messages in a given room.
    roomReadPointers: [
        {
            roomId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Room',
                required: true,
            },
            lastReadAt: {
                type: Date,
                required: true,
            },
        },
    ],
    // Moderation enforcement (admin API). 'banned' blocks connect + send
    // indefinitely; 'suspended' blocks until suspendedUntil (null = indefinite).
    status: {
        type: String,
        enum: ['active', 'suspended', 'banned'],
        default: 'active',
    },
    suspendedUntil: {
        type: Date,
        default: null,
    },
    enforcementReason: {
        type: String,
        default: '',
    },
});

// Unique on non-empty usernames only. Sparse alone doesn't work here because
// the schema defaults `username` to '' (present-but-empty), which sparse still
// indexes — causing duplicate-key errors for every user past the first.
userSchema.index(
    { username: 1 },
    { unique: true, partialFilterExpression: { username: { $gt: '' } } },
);

// Index for efficient room member queries (finding users by joinedRooms)
userSchema.index({ joinedRooms: 1 });

// Index for efficient hidden direct room checks.
userSchema.index({ hiddenDirectRooms: 1 });

// Index for efficient per-room read pointer lookups
userSchema.index({ 'roomReadPointers.roomId': 1 });

export const User = mongoose.model('User', userSchema); 
