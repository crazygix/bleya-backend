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
        validate: {
            validator: function (v: mongoose.Types.ObjectId[]) {
                return v.length <= 5;
            },
            message: 'User can only join up to 5 rooms'
        }
    }
});

export const User = mongoose.model('User', userSchema); 