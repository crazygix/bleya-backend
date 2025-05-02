import mongoose from 'mongoose';
const userSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        unique: true,
    },
    displayName: {
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
    }
});
// Update lastLogin timestamp before saving
userSchema.pre('save', function (next) {
    this.lastLogin = new Date();
    next();
});
export const User = mongoose.model('User', userSchema);
//# sourceMappingURL=User.js.map