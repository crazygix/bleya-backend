import express from 'express';
import multer from 'multer';
import path from 'path';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from '../services/r2Service.js';

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
            console.error('File rejected:', {
                originalname: file.originalname,
                mimetype: file.mimetype,
                extname: extname
            });
            cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp)'));
        }
    }
});

// Get current user profile
router.get('/me', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user._id.toString(),
            phoneNumber: user.phoneNumber,
            username: user.username,
            bio: user.bio,
            profileImageUrl: user.profileImageUrl,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching user info' });
    }
});

// Update user profile (username and bio)
router.put('/profile', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const { username, bio } = req.body;
        const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (username !== undefined) {
            user.username = username;
        }
        if (bio !== undefined) {
            user.bio = bio;
        }

        await user.save();

        res.json({
            phoneNumber: user.phoneNumber,
            username: user.username,
            bio: user.bio,
            profileImageUrl: user.profileImageUrl,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ error: 'Error updating profile' });
    }
});

// Upload profile image
router.post('/profile-image', authenticateUser, upload.single('image'), async (req: AuthRequest, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image file provided' });
        }

        const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Delete old profile image from R2 if exists
        if (user.profileImageUrl) {
            const oldKey = extractKeyFromUrl(user.profileImageUrl);
            if (oldKey) {
                await deleteFromR2(oldKey);
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
        await user.save();

        res.json({
            phoneNumber: user.phoneNumber,
            username: user.username,
            bio: user.bio,
            profileImageUrl: user.profileImageUrl,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        });
    } catch (error) {
        console.error('Error uploading profile image:', error);
        res.status(500).json({ error: 'Error uploading profile image' });
    }
});

// Get user by ID (must be last to avoid conflicts with /me, /profile, /profile-image)
router.get('/:userId', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        
        // Validate MongoDB ObjectId format
        if (!userId.match(/^[0-9a-fA-F]{24}$/)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }
        
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user._id.toString(),
            phoneNumber: user.phoneNumber,
            username: user.username,
            bio: user.bio,
            profileImageUrl: user.profileImageUrl,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching user info' });
    }
});

export default router;

