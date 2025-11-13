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
    refreshTokenHash: {
        type: String,
    },
    refreshTokenExpiresAt: {
        type: Date,
    },
    username: {
        type: String,
        default: '',
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
    lastLogin: {
        type: Date,
        default: Date.now,
    },
    joinedRooms: {
        type: [mongoose.Schema.Types.ObjectId],
        ref: 'Room',
        default: [],
        validate: {
            validator: function (v: mongoose.Types.ObjectId[]) {
                return v.length <= 5;
            },
            message: 'User can only join up to 5 rooms'
        }
    }
});

// Update lastLogin timestamp before saving
userSchema.pre('save', function (next) {
    this.lastLogin = new Date();
    next();
});

export const User = mongoose.model('User', userSchema); 