import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ConflictError, ErrorCode } from '../utils/errors.js';

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
router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    // Initialize rooms on first request
    await initializeRooms();

    const rooms = await Room.find().sort({ name: 1 }).lean();
    res.json(rooms.map(room => ({
        id: room._id.toString(),
        name: room.name,
    })));
}));

// Get user's joined rooms
router.get('/joined', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const user = await User.findById(req.user!.userId).populate('joinedRooms').lean();
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    const joinedRooms = (user.joinedRooms || []).map((room: any) => ({
        id: room._id.toString(),
        name: room.name,
    }));

    res.json(joinedRooms);
}));

// Join a room
router.post('/:roomId/join', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { roomId } = req.params;
    const userId = req.user!.userId;

    // Validate room ID format
    if (!roomId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid room ID format');
    }

    // Verify room exists
    const room = await Room.findById(roomId);
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
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
        throw new ValidationError('You can only join up to 5 rooms at a time');
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
}));

// Get room members
router.get('/:roomId/members', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { roomId } = req.params;

    // Validate room ID format
    if (!roomId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid room ID format');
    }

    // Verify room exists
    const room = await Room.findById(roomId);
    if (!room) {
        throw new NotFoundError('Room not found', ErrorCode.ROOM_NOT_FOUND);
    }

    // Find all users who have this room in their joinedRooms
    const roomObjectId = new mongoose.Types.ObjectId(roomId);
    const users = await User.find({
        joinedRooms: roomObjectId
    }).select('_id username phoneNumber profileImageUrl').lean();

    const members = users.map((user: any) => ({
        id: user._id.toString(),
        username: user.username || '',
        phoneNumber: user.phoneNumber,
        profileImageUrl: user.profileImageUrl || '',
    }));

    res.json(members);
}));

// Leave a room
router.post('/:roomId/leave', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { roomId } = req.params;
    const userId = req.user!.userId;

    // Validate room ID format
    if (!roomId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid room ID format');
    }

    // Get user
    const user = await User.findById(userId);
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Remove room from joined rooms
    const roomObjectId = new mongoose.Types.ObjectId(roomId);
    user.joinedRooms = user.joinedRooms.filter(
        (id: mongoose.Types.ObjectId) => !id.equals(roomObjectId)
    );
    await user.save();

    res.json({ message: 'Successfully left room' });
}));

export default router;

