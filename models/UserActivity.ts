import mongoose from 'mongoose';

// One record per user per UTC day on which they used the app (an authenticated
// request, a socket connection or a sign-in). Counts of these give daily,
// weekly and monthly active users and how many new users come back. Platform
// and app version are those of the day's first request. Each record is deleted
// automatically at retainUntil (config.analytics.retentionDays after the day),
// and with the user's account; the daily totals in DailyStat outlive them.
const userActivitySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    // Midnight UTC of the day.
    day: {
        type: Date,
        required: true,
    },
    platform: {
        type: String,
    },
    appVersion: {
        type: String,
    },
    retainUntil: {
        type: Date,
    },
}, {
    timestamps: { createdAt: true, updatedAt: false },
});

userActivitySchema.index({ userId: 1, day: 1 }, { unique: true });
userActivitySchema.index({ day: 1, userId: 1 });
userActivitySchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });

export const UserActivity = mongoose.model('UserActivity', userActivitySchema);
