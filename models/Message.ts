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
messageSchema.index({ roomId: 1, parentMessageId: 1, createdAt: -1 }); // Compound for filtered queries

export const Message = mongoose.model('Message', messageSchema);
