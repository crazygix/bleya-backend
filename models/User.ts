import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        unique: true,
    },
    code: {
        type: String,
    },
    codeExpiresAt: {
        type: Date,
    },
    refreshTokenHash: {
        type: String,
    },
    refreshTokenExpiresAt: {
        type: Date,
    },
    username: {
        type: String,
        default: '',
        trim: true,
        lowercase: true,
        validate: {
            validator: function (v: string) {
                // Allow empty string (for existing users without username)
                if (!v || v.length === 0) return true;
                // Username must be 3-30 characters, alphanumeric and underscores only
                return /^[a-z0-9_]{3,30}$/.test(v);
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
    }
});

// Create unique sparse index on username (allows multiple empty usernames, but enforces uniqueness for non-empty)
userSchema.index({ username: 1 }, { unique: true, sparse: true });

export const User = mongoose.model('User', userSchema); 