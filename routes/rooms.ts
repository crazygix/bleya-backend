import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import {
    joinRoomForUser,
    listPublicRooms,
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
import { ValidationError } from '../utils/errors.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { validateObjectId } from '../utils/validation.js';

const router = express.Router();

function parseSearchQuery(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new ValidationError('Search needs to be text.');
    }

    const sanitized = sanitizePlainText(value, {
        maxLength: 80,
        collapseWhitespace: true,
        escapeHtml: false,
    });

    return sanitized.length > 0 ? sanitized : undefined;
}

router.get('/', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const searchQuery = parseSearchQuery(req.query.search ?? req.query.q);
    const rooms = await listPublicRooms({ searchQuery });
    res.json(rooms);
}));

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
    const members = await getRoomMembersForUser(req.user!.userId, roomObjectId);
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

router.post('/direct/:otherUserId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await openOrCreateDirectRoom(req.user!.userId, req.params.otherUserId);
    res.json(result);
}));

router.get('/:roomId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const roomObjectId = validateObjectId(req.params.roomId, 'room ID');
    const room = await getRoomDetailForUser(req.user!.userId, roomObjectId);
    res.json(room);
}));

export default router;
