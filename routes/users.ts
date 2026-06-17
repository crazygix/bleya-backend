import express from 'express';
import multer from 'multer';
import path from 'path';
import mongoose from 'mongoose';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { UserBlock } from '../models/UserBlock.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ValidationError } from '../utils/errors.js';
import {
    getUserProfile,
    getPublicProfile,
    updateProfile,
    updateProfileImage,
} from '../services/userService.js';
import { exportUserData, deleteUserAccount } from '../services/accountService.js';
import { moderateImage } from '../services/imageModerationService.js';
import { blockUser, unblockUser } from '../services/blockService.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { config } from '../config/index.js';
import type { LeanUser } from '../types/lean.js';

const router = express.Router();

const PROD = config.isProduction;

// The data export is expensive and returns the user's entire dataset — throttle
// it tightly to blunt scraping/exfiltration via a stolen token.
const exportLimiter = createRateLimiter({ name: 'users.export', limit: PROD ? 5 : 100 });
// Public-profile lookups are enumerable; cap them to limit bulk harvesting.
const publicProfileLimiter = createRateLimiter({ name: 'users.public-profile', limit: PROD ? 120 : 1000 });

interface LeanActiveUserBlock {
    _id: mongoose.Types.ObjectId;
    blockedUserId: mongoose.Types.ObjectId;
    blockedAt?: Date;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = path.extname(file.originalname).toLowerCase().replace('.', '');
        const hasValidExtension = allowedTypes.test(extname);
        const hasValidMimetype = file.mimetype && (
            file.mimetype.startsWith('image/') ||
            allowedTypes.test(file.mimetype)
        );

        if (hasValidExtension || hasValidMimetype) {
            return cb(null, true);
        }

        cb(new ValidationError('Only images work here (jpeg, jpg, png, gif, webp).'));
    },
});

router.get('/me', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await getUserProfile(req.user!.userId);
    res.json(profile);
}));

router.put('/profile', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await updateProfile(req.user!.userId, {
        username: req.body.username,
        bio: req.body.bio,
    });
    res.json(profile);
}));

router.post('/profile-image', authenticateUser, upload.single('image'), asyncHandler(async (req: AuthRequest, res: express.Response) => {
    if (!req.file) {
        throw new ValidationError('No image selected. Pick one?');
    }

    const imageCheck = await moderateImage(req.file.buffer, req.file.mimetype);
    if (!imageCheck.allowed) {
        throw new ValidationError(imageCheck.reason || "That image isn't allowed.");
    }

    const profile = await updateProfileImage(req.user!.userId, {
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
    });
    res.json(profile);
}));

router.get('/blocked', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const currentUserId = req.user!.userId;
    const currentUserObjectId = new mongoose.Types.ObjectId(currentUserId);

    const activeBlocks = await UserBlock.find({
        blockerUserId: currentUserObjectId,
        isActive: true,
    }).select('_id blockedUserId blockedAt').sort({ blockedAt: -1 }).lean<LeanActiveUserBlock[]>();

    if (activeBlocks.length === 0) {
        res.json([]);
        return;
    }

    const blockedUserIds = activeBlocks.map((block) => block.blockedUserId);
    const blockedUsers = await User.find({
        _id: { $in: blockedUserIds },
    }).select('_id username bio profileImageUrl').lean<LeanUser[]>();

    const blockedUserMap = new Map(
        blockedUsers.map((user) => [user._id.toString(), user])
    );

    const response = activeBlocks
        .map((block) => {
            const blockedUser = blockedUserMap.get(block.blockedUserId.toString());
            if (!blockedUser) {
                return null;
            }

            return {
                id: blockedUser._id.toString(),
                username: blockedUser.username || '',
                bio: blockedUser.bio || '',
                profileImageUrl: blockedUser.profileImageUrl || '',
                blockedAt: block.blockedAt ? block.blockedAt.getTime() : null,
            };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

    res.json(response);
}));

router.get('/me/export', authenticateUser, exportLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const data = await exportUserData(req.user!.userId);
    res.setHeader('Content-Disposition', `attachment; filename="bleya-data-export-${req.user!.userId}.json"`);
    res.json(data);
}));

router.delete('/me', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await deleteUserAccount(req.user!.userId);
    // End the session: the account no longer exists, so revoke the refresh cookie.
    res.clearCookie('refreshToken', { path: '/' });
    res.json(result);
}));

router.get('/:userId([0-9a-fA-F]{24})', authenticateUser, publicProfileLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await getPublicProfile(req.params.userId);
    res.json(profile);
}));

// User-level block/unblock (works without an existing DM — reachable from a
// public room, profile, or message).
router.post('/:userId([0-9a-fA-F]{24})/block', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await blockUser(req.user!.userId, req.params.userId);
    res.json(result);
}));

router.post('/:userId([0-9a-fA-F]{24})/unblock', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await unblockUser(req.user!.userId, req.params.userId);
    res.json(result);
}));

export default router;
