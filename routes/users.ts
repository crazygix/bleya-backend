import express from 'express';
import multer from 'multer';
import path from 'path';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { UserBlock } from '../models/UserBlock.js';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from '../services/r2Service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { sanitizePlainText, sanitizeUsername } from '../utils/sanitize.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

const router = express.Router();

interface LeanBlockedUser {
    _id: mongoose.Types.ObjectId;
    username?: string;
    bio?: string;
    profileImageUrl?: string;
}

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
    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    res.json({
        id: user._id.toString(),
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt.getTime(),
        updatedAt: user.updatedAt.getTime(),
    });
}));

router.put('/profile', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { username, bio } = req.body;
    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    let profileChanged = false;

    if (username !== undefined) {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError("Username can't be empty.");
        }

        const normalizedUsername = sanitizeUsername(username);
        if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
            throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
        }

        if (user.username !== normalizedUsername) {
            user.username = normalizedUsername;
            profileChanged = true;
        }
    }

    if (bio !== undefined) {
        if (typeof bio !== 'string') {
            throw new ValidationError('Bio needs to be text.');
        }

        const sanitizedBio = sanitizePlainText(bio, {
            maxLength: 280,
            collapseWhitespace: false,
            escapeHtml: true,
        });

        if (user.bio !== sanitizedBio) {
            user.bio = sanitizedBio;
            profileChanged = true;
        }
    }

    if (profileChanged) {
        user.updatedAt = new Date();
    }

    await user.save();

    res.json({
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt.getTime(),
        updatedAt: user.updatedAt.getTime(),
        lastLogin: user.lastLogin.getTime(),
    });
}));

router.post('/profile-image', authenticateUser, upload.single('image'), asyncHandler(async (req: AuthRequest, res: express.Response) => {
    if (!req.file) {
        throw new ValidationError('No image selected. Pick one?');
    }

    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (user.profileImageUrl) {
        const oldKey = extractKeyFromUrl(user.profileImageUrl);
        if (oldKey) {
            try {
                await deleteFromR2(oldKey);
            } catch (error) {
                logger.warn('profile_image.delete_old.failed', {
                    userId: user._id.toString(),
                    key: oldKey,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const key = `profiles/profile-${uniqueSuffix}${fileExtension}`;

    const uploadResult = await uploadToR2(req.file.buffer, key, req.file.mimetype);

    user.profileImageUrl = uploadResult.url;
    user.updatedAt = new Date();
    await user.save();

    res.json({
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt.getTime(),
        updatedAt: user.updatedAt.getTime(),
        lastLogin: user.lastLogin.getTime(),
    });
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
    }).select('_id username bio profileImageUrl').lean<LeanBlockedUser[]>();

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

router.get('/:userId([0-9a-fA-F]{24})', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    res.json({
        id: user._id.toString(),
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt.getTime(),
        updatedAt: user.updatedAt.getTime(),
    });
}));

export default router;
