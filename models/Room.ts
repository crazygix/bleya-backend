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
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt fields
});

export const Room = mongoose.model('Room', roomSchema);

