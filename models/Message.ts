import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
        required: true,
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    text: {
        type: String,
        required: true,
    },
    parentMessageId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        default: null, // null = top-level message, non-null = reply in a thread
    },
    replyCount: {
        type: Number,
        default: 0, // Number of direct replies to this message
    },
    // Moderation soft-delete. When deletedAt is set the message is hidden from
    // every user-facing read path (filtered in each query) but kept for audit and
    // possible restore. Admin views and the moderation queue still see it.
    deletedAt: {
        type: Date,
        default: null,
    },
    deletedBy: {
        type: String,
        default: '',
    },
    deleteReason: {
        type: String,
        default: '',
    },
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
});

// Index for efficient thread queries
messageSchema.index({ parentMessageId: 1, createdAt: 1 });

// Index for efficient room message queries (most common query)
messageSchema.index({ roomId: 1, createdAt: -1 });
// Room pages and previews sort by (createdAt, _id); without _id in the index
// the sort couldn't use it and opening a room scanned its whole history.
messageSchema.index({ roomId: 1, parentMessageId: 1, createdAt: -1, _id: -1 });
// A user's own messages: account deletion and data export.
messageSchema.index({ userId: 1, createdAt: 1 });

export const Message = mongoose.model('Message', messageSchema);
