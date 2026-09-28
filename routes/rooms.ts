import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import {
    joinRoomForUser,
    getJoinedRoomsForUser,
    getRoomMessagesForUser,
    getRoomMembersForUser,
    leaveRoomForUser,
    markRoomReadForUser,
    getRoomDetailForUser,
} from '../services/roomService.js';
import {
    getDirectChatStatus,
    deleteDirectChat,
    blockDirectUser,
    unblockDirectUser,
    openOrCreateDirectRoom,
} from '../services/directMessageService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import { validateObjectId } from '../utils/validation.js';

const router = express.Router();

// Opening a DM creates a room and adds it to both users' lists; cap it so one
// account can't spray DMs at everyone.
const directRoomLimiter = createRateLimiter({
    name: 'rooms.direct-open',
    limit: config.isProduction ? 60 : 1000,
});

router.get('/joined', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const rooms = await getJoinedRoomsForUser(req.user!.userId);
    res.json(rooms);
}));

router.post('/:roomId/join', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const response = await joinRoomForUser({
        userId: req.user!.userId,
        roomId: roomObjectId,
    });

    res.json(response);
}));

router.get('/:roomId/messages', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const { before, limit } = req.query;

    const page = await getRoomMessagesForUser(req.user!.userId, roomObjectId, {
        before: typeof before === 'string' ? before : undefined,
        limit: typeof limit === 'string' ? limit : undefined,
    });

    res.json(page);
}));

router.get('/:roomId/members', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const { limit, offset } = req.query;
    const members = await getRoomMembersForUser(req.user!.userId, roomObjectId, {
        limit: typeof limit === 'string' ? limit : undefined,
        offset: typeof offset === 'string' ? offset : undefined,
    });
    res.json(members);
}));

router.post('/:roomId/leave', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const result = await leaveRoomForUser(req.user!.userId, roomObjectId);
    res.json(result);
}));

router.post('/:roomId/read', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const result = await markRoomReadForUser(req.user!.userId, roomObjectId);
    res.json(result);
}));

router.get('/direct/:otherUserId/status', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const status = await getDirectChatStatus(req.user!.userId, req.params.otherUserId);
    res.json(status);
}));

router.post('/direct/:otherUserId/delete', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await deleteDirectChat(req.user!.userId, req.params.otherUserId);
    res.json(result);
}));

router.post('/direct/:otherUserId/block', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await blockDirectUser(req.user!.userId, req.params.otherUserId);
    res.json(result);
}));

router.post('/direct/:otherUserId/unblock', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await unblockDirectUser(req.user!.userId, req.params.otherUserId);
    res.json(result);
}));

router.post('/direct/:otherUserId', authenticateUser, directRoomLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await openOrCreateDirectRoom(req.user!.userId, req.params.otherUserId);
    res.json(result);
}));

router.get('/:roomId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const room = await getRoomDetailForUser(req.user!.userId, roomObjectId);
    res.json(room);
}));

export default router;
