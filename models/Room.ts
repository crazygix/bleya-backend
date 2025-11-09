import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true,
    },
    description: {
        type: String,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export const Room = mongoose.model('Room', roomSchema);

