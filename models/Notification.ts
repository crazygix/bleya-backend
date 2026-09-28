import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
    recipient: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    type: {
        type: String,
        enum: ['reply'],
        required: true,
    },
    room: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
        required: true,
    },
    message: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        required: true,
    },
    thread: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        required: true,
    },
    read: {
        type: Boolean,
        default: false,
    },
    isDismissed: {
        type: Boolean,
        default: false,
    },
}, {
    timestamps: true,
});

// Index for efficient fetching of user's notifications
notificationSchema.index({ recipient: 1, createdAt: -1 });

// Index for counting unread notifications
notificationSchema.index({ recipient: 1, read: 1 });

// Index for fetching active (not dismissed) notifications
notificationSchema.index({ recipient: 1, isDismissed: 1, createdAt: -1 });

// Index for counting unread active notifications
notificationSchema.index({ recipient: 1, isDismissed: 1, read: 1 });

// Cleanup lookups on account deletion and content moderation.
notificationSchema.index({ sender: 1 });
notificationSchema.index({ message: 1 });
notificationSchema.index({ thread: 1 });

export const Notification = mongoose.model('Notification', notificationSchema);
