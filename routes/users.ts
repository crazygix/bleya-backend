import express from 'express';
import multer from 'multer';
import path from 'path';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from '../services/r2Service.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { NotFoundError, ValidationError, ErrorCode, InternalError } from '../utils/errors.js';

const router = express.Router();

// Configure multer for memory storage (we'll upload directly to R2)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = path.extname(file.originalname).toLowerCase().replace('.', '');
        const hasValidExtension = allowedTypes.test(extname);
        const hasValidMimetype = file.mimetype && (
            file.mimetype.startsWith('image/') ||
            allowedTypes.test(file.mimetype)
        );

        if (hasValidExtension || hasValidMimetype) {
            return cb(null, true);
        } else {
            cb(new ValidationError('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
        }
    }
});

// Get current user profile
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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    });
}));

// Update user profile (username and bio)
router.put('/profile', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { username, bio } = req.body;
    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });

    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    let profileChanged = false;

    if (username !== undefined) {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError('Username must be a non-empty string');
        }
        if (user.username !== username.trim()) {
            user.username = username.trim();
            profileChanged = true;
        }
    }
    if (bio !== undefined) {
        if (typeof bio !== 'string') {
            throw new ValidationError('Bio must be a string');
        }
        if (user.bio !== bio) {
            user.bio = bio;
            profileChanged = true;
        }
    }

    // Update updatedAt only if profile actually changed
    if (profileChanged) {
        user.updatedAt = new Date();
    }

    await user.save();

    res.json({
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLogin: user.lastLogin
    });
}));

// Upload profile image
router.post('/profile-image', authenticateUser, upload.single('image'), asyncHandler(async (req: AuthRequest, res: express.Response) => {
    if (!req.file) {
        throw new ValidationError('No image file provided');
    }

    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    // Delete old profile image from R2 if exists
    if (user.profileImageUrl) {
        const oldKey = extractKeyFromUrl(user.profileImageUrl);
        if (oldKey) {
            try {
                await deleteFromR2(oldKey);
            } catch (error) {
                // Log but don't fail if deletion fails
                console.error('Failed to delete old profile image:', error);
            }
        }
    }

    // Generate unique key for R2
    const fileExtension = path.extname(req.file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const key = `profiles/profile-${uniqueSuffix}${fileExtension}`;

    // Upload to R2
    const uploadResult = await uploadToR2(
        req.file.buffer,
        key,
        req.file.mimetype
    );

    // Store the full URL in the database
    user.profileImageUrl = uploadResult.url;
    // Update updatedAt when profile image changes
    user.updatedAt = new Date();
    await user.save();

    res.json({
        phoneNumber: user.phoneNumber,
        username: user.username,
        bio: user.bio,
        profileImageUrl: user.profileImageUrl,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLogin: user.lastLogin
    });
}));

// Get user by ID (must be last to avoid conflicts with /me, /profile, /profile-image)
router.get('/:userId', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { userId } = req.params;

    // Validate MongoDB ObjectId format
    if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
        throw new ValidationError('Invalid user ID format');
    }

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
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
    });
}));

export default router;

