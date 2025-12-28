import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import mongoose from 'mongoose';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ConflictError, ErrorCode } from '../utils/errors.js';

// Helper function to count public rooms for a user
async function countPublicRooms(userId: string): Promise<number> {
    const user = await User.findById(userId).populate('joinedRooms').lean();
    if (!user) return 0;

    const publicRooms = (user.joinedRooms || []).filter((room: any) => {
        return !room.type || room.type === 'public';
    });

    return publicRooms.length;
}

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
            { name: roomData.name, type: 'public' }, // Query by both name and type
            {
                $setOnInsert: {
                    ...roomData,
                    type: 'public' // Explicitly set type to ensure proper indexing
                }
            },
            { upsert: true, new: true }
        );
    }
}

// Get all available public rooms (excludes private DMs)
router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    // Initialize rooms on first request
    await initializeRooms();

    // Only return public rooms - private DMs should not appear in the join dialog
    const rooms = await Room.find({ type: { $ne: 'private' } }).sort({ name: 1 }).lean();
    res.json(rooms.map(room => ({
        id: room._id.toString(),
        name: room.name,
        type: room.type || 'public', // Include type for safety
    })));
}));

// Get user's joined rooms (both public and private)
router.get('/joined', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const userId = req.user!.userId;
    const user = await User.findById(userId).populate('joinedRooms').lean();
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Collect all participant IDs from private rooms for bulk fetch (avoids N+1 queries)
    const participantIds = new Set<string>();
    (user.joinedRooms || []).forEach((room: any) => {
        if (room.type === 'private' && room.participants) {
            room.participants.forEach((id: string) => {
                if (id !== userId) participantIds.add(id);
            });
        }
    });

    // Bulk fetch all participants in a single query
    const participantUsers = await User.find({
        _id: { $in: Array.from(participantIds) }
    }).select('_id username').lean();

    // Create a map for quick lookup
    const userMap = new Map(
        participantUsers.map((u: any) => [u._id.toString(), u.username])
    );

    // Map rooms with pre-fetched user data
    const joinedRooms = (user.joinedRooms || []).map((room: any) => {
        let roomName = room.name;
        let otherUserId = null;

        // For private chats, get the other user's info from pre-fetched map
        if (room.type === 'private' && room.participants) {
            const otherParticipantId = room.participants.find((id: string) => id !== userId);
            if (otherParticipantId) {
                roomName = userMap.get(otherParticipantId) || 'Unknown User';
                otherUserId = otherParticipantId;
            }
        }

        return {
            id: room._id.toString(),
            name: roomName,
            type: room.type || 'public',
            participants: room.participants || [],
            otherUserId: otherUserId,
        };
    });

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

    const roomObjectId = new mongoose.Types.ObjectId(roomId);

    // Get user with populated rooms to check count and avoid race condition
    const user = await User.findById(userId).populate('joinedRooms');
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Check if already joined
    if (user.joinedRooms.some((id: mongoose.Types.ObjectId) => id.equals(roomObjectId))) {
        return res.json({
            message: 'Already joined this room',
            room: {
                id: room._id.toString(),
                name: room.name,
            }
        });
    }

    // Check if user has reached the limit for public rooms (5 max)
    // Use already-populated data to avoid race condition
    const publicRoomCount = (user.joinedRooms as any[]).filter((r: any) => {
        return !r.type || r.type === 'public';
    }).length;

    if (publicRoomCount >= 5) {
        throw new ValidationError('You can only join up to 5 group chats at a time');
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

// Create or get direct message room with another user
router.post('/direct/:otherUserId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { otherUserId } = req.params;
    const currentUserId = req.user!.userId;

    // Validate other user ID format
    if (!otherUserId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid user ID format');
    }

    // Can't create DM with yourself
    if (otherUserId === currentUserId) {
        throw new ValidationError('Cannot create direct message with yourself');
    }

    // Verify other user exists
    const otherUser = await User.findById(otherUserId);
    if (!otherUser) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Get current user
    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Sort participant IDs to ensure consistent ordering
    const participants = [currentUserId, otherUserId].sort();

    // Create hash for unique constraint (prevents duplicate DMs even with concurrent requests)
    const participantsHash = participants.join('_');

    // Use atomic findOneAndUpdate with upsert to handle concurrent requests gracefully
    // This prevents race conditions where both requests try to create the same room
    const room = await Room.findOneAndUpdate(
        {
            type: 'private',
            participantsHash: participantsHash,
        },
        {
            $setOnInsert: {
                name: `DM: ${currentUser.username || currentUserId} & ${otherUser.username || otherUserId}`,
                type: 'private',
                participants: participants,
                participantsHash: participantsHash,
            },
        },
        {
            upsert: true, // Create if doesn't exist
            new: true, // Return the document after update/insert
        }
    );

    const roomObjectId = room._id as mongoose.Types.ObjectId;

    // Use atomic operations to add room to both users' joined rooms (prevents race conditions)
    // $addToSet ensures no duplicates even with concurrent requests
    await Promise.all([
        User.updateOne(
            { _id: currentUserId },
            { $addToSet: { joinedRooms: roomObjectId } }
        ),
        User.updateOne(
            { _id: otherUserId },
            { $addToSet: { joinedRooms: roomObjectId } }
        )
    ]);

    res.json({
        message: 'Direct message room ready',
        room: {
            id: room._id.toString(),
            name: otherUser.username || 'Unknown User',
            type: room.type,
            participants: room.participants,
            otherUserId: otherUserId,
        }
    });
}));

export default router;