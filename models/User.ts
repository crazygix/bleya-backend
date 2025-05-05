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
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastLogin: {
        type: Date,
        default: Date.now,
    }
});

// Update lastLogin timestamp before saving
userSchema.pre('save', function (next) {
    this.lastLogin = new Date();
    next();
});

export const User = mongoose.model('User', userSchema); 