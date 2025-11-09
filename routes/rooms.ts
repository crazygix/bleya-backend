import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';

const router = express.Router();

// Preset rooms - city based
const PRESET_ROOMS = [
    { name: 'Belgrade, Serbia' },
    { name: 'Novi Sad, Serbia' },
    { name: 'Niš, Serbia' },
    { name: 'Kragujevac, Serbia' },
    { name: 'Subotica, Serbia' },
];

// Initialize preset rooms if they don't exist
async function initializeRooms() {
    // Create/update preset rooms
    for (const roomData of PRESET_ROOMS) {
        await Room.findOneAndUpdate(
            { name: roomData.name },
            { $setOnInsert: roomData },
            { upsert: true, new: true }
        );
    }
}

// Get all available rooms
router.get('/', authenticateUser, async (req: AuthRequest, res) => {
    try {
        // Initialize rooms on first request
        await initializeRooms();

        const rooms = await Room.find().sort({ name: 1 }).lean();
        res.json(rooms.map(room => ({
            id: room._id.toString(),
            name: room.name,
        })));
    } catch (error) {
        console.error('Error fetching rooms:', error);
        res.status(500).json({ error: 'Error fetching rooms' });
    }
});

export default router;

