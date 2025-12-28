import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    description: {
        type: String,
    },
    type: {
        type: String,
        enum: ['public', 'private'],
        default: 'public',
    },
    participants: {
        type: [String], // Array of user IDs for private chats
        default: [],
    },
    participantsHash: {
        type: String, // Unique identifier for private chats (sorted participant IDs joined)
        sparse: true, // Only for private chats
    },
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
});

// Unique index for public rooms by name
roomSchema.index({ name: 1, type: 1 }, { unique: true, sparse: true, partialFilterExpression: { type: 'public' } });

// Unique index for private rooms by participantsHash (ensures only one DM between two users)
// This properly prevents duplicate DMs unlike indexing the array field directly
roomSchema.index({ participantsHash: 1, type: 1 }, { unique: true, sparse: true, partialFilterExpression: { type: 'private' } });

export const Room = mongoose.model('Room', roomSchema);

