import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import mongoose from 'mongoose';

const router = express.Router();

// Preset rooms - city based
const PRESET_ROOMS = [
    { name: 'Belgrade, Serbia' },
    { name: 'Novi Sad, Serbia' },
    { name: 'Niš, Serbia' },
    { name: 'Kraljevo, Serbia' },
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

// Get user's joined rooms
router.get('/joined', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const user = await User.findById(req.user!.userId).populate('joinedRooms').lean();
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const joinedRooms = (user.joinedRooms || []).map((room: any) => ({
            id: room._id.toString(),
            name: room.name,
        }));

        res.json(joinedRooms);
    } catch (error) {
        console.error('Error fetching joined rooms:', error);
        res.status(500).json({ error: 'Error fetching joined rooms' });
    }
});

// Join a room
router.post('/:roomId/join', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user!.userId;

        // Verify room exists
        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }

        // Get user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if already joined
        const roomObjectId = new mongoose.Types.ObjectId(roomId);
        if (user.joinedRooms.some((id: mongoose.Types.ObjectId) => id.equals(roomObjectId))) {
            return res.json({
                message: 'Already joined this room',
                room: {
                    id: room._id.toString(),
                    name: room.name,
                }
            });
        }

        // Check if user has reached the limit
        if (user.joinedRooms.length >= 5) {
            return res.status(400).json({
                error: 'You can only join up to 5 rooms at a time'
            });
        }

        // Add room to joined rooms
        user.joinedRooms.push(roomObjectId);
        await user.save();

        res.json({
            message: 'Successfully joined room',
            room: {
                id: room._id.toString(),
                name: room.name,
            }
        });
    } catch (error) {
        console.error('Error joining room:', error);
        res.status(500).json({ error: 'Error joining room' });
    }
});

// Leave a room
router.post('/:roomId/leave', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const { roomId } = req.params;
        const userId = req.user!.userId;

        // Get user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Remove room from joined rooms
        const roomObjectId = new mongoose.Types.ObjectId(roomId);
        user.joinedRooms = user.joinedRooms.filter(
            (id: mongoose.Types.ObjectId) => !id.equals(roomObjectId)
        );
        await user.save();

        res.json({ message: 'Successfully left room' });
    } catch (error) {
        console.error('Error leaving room:', error);
        res.status(500).json({ error: 'Error leaving room' });
    }
});

export default router;

