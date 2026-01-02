import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    roomId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
        required: true,
    },
    userId: {
        type: String,
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
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
});

// Index for efficient thread queries
messageSchema.index({ parentMessageId: 1, createdAt: 1 });

export const Message = mongoose.model('Message', messageSchema);

