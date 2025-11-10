import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';

const router = express.Router();

// Configure multer for file uploads
const uploadsDir = path.join(process.cwd(), 'uploads', 'profiles');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
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
            // Delete uploaded file if user not found
            fs.unlinkSync(req.file.path);
            return res.status(404).json({ error: 'User not found' });
        }

        // Delete old profile image if exists
        if (user.profileImageUrl) {
            const oldImagePath = path.join(process.cwd(), user.profileImageUrl);
            if (fs.existsSync(oldImagePath)) {
                fs.unlinkSync(oldImagePath);
            }
        }

        // Store relative path from project root
        const relativePath = path.relative(process.cwd(), req.file.path).replace(/\\/g, '/');
        user.profileImageUrl = '/' + relativePath;
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
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Error uploading profile image' });
    }
});

export default router;

