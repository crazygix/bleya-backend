import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';

const router = express.Router();

// Test endpoint to debug request body parsing
router.post('/test', (req, res) => {
    console.log('Test endpoint hit');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    console.log('Body type:', typeof req.body);
    res.json({
        message: 'Test endpoint working',
        body: req.body,
        bodyType: typeof req.body,
        headers: req.headers
    });
});

// Create account with phone number
router.post('/create-account', async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ phoneNumber });
        if (existingUser) {
            return res.status(400).json({ error: 'User already exists' });
        }

        // Create new user
        const user = await User.create({
            phoneNumber
        });

        res.status(201).json({
            message: 'Account created successfully',
            user: {
                phoneNumber: user.phoneNumber,
                createdAt: user.createdAt
            }
        });
    } catch (error) {
        console.error('Error creating account:', error);
        res.status(500).json({ error: 'Error creating account' });
    }
});

// Verify phone number and get token
router.post('/verify-phone', async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // Check if user exists
        const user = await User.findOne({ phoneNumber });
        if (!user) {
            return res.status(404).json({ error: 'User not found. Please create an account first.' });
        }

        res.json({ message: 'Phone number verified' });
    } catch (error) {
        console.error('Error verifying phone number:', error);
        res.status(500).json({ error: 'Error verifying phone number' });
    }
});

// Request code (send code to user)
router.post('/request-code', async (req, res) => {
    try {
        console.log('Request body received:', req.body);
        console.log('Content-Type:', req.headers['content-type']);

        const { phoneNumber } = req.body;

        console.log('Extracted phoneNumber:', phoneNumber);

        if (!phoneNumber) {
            console.log('Phone number is missing from request');
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // Generate a 6-digit code
        const code = Math.floor(100000 + Math.random() * 900000).toString();

        // Find or create user and set code
        let user = await User.findOne({ phoneNumber });
        if (!user) {
            user = await User.create({ phoneNumber, code });
        } else {
            user.code = code;
            await user.save();
        }

        // In production, send code via SMS here
        // For now, return code in response for testing
        res.json({ message: 'Verification code sent', code });
    } catch (error) {
        console.error('Error requesting code:', error);
        res.status(500).json({ error: 'Error requesting code' });
    }
});

// Verify code and get JWT
router.post('/verify-code', async (req, res) => {
    try {
        const { phoneNumber, code } = req.body;
        if (!phoneNumber || !code) {
            return res.status(400).json({ error: 'Phone number and code are required' });
        }

        const user = await User.findOne({ phoneNumber });
        if (!user || user.code !== code) {
            return res.status(401).json({ error: 'Invalid phone number or code' });
        }

        // Clear the code after successful verification
        user.code = undefined;
        await user.save();

        // Create a JWT for the user
        const payload = { phoneNumber: user.phoneNumber, userId: user._id };
        const token = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '7d' });

        res.json({ token });
    } catch (error) {
        console.error('Error verifying code:', error);
        res.status(500).json({ error: 'Error verifying code' });
    }
});

// Example protected route
router.get('/me', authenticateUser, async (req: AuthRequest, res) => {
    try {
        const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            phoneNumber: user.phoneNumber,
            createdAt: user.createdAt,
            lastLogin: user.lastLogin
        });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching user info' });
    }
});

export default router; 