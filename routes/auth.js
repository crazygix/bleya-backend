import express from 'express';
import admin from 'firebase-admin';
import { authenticateUser } from '../middleware/auth.ts';
import { User } from '../models/User.ts';
const router = express.Router();
// Create account with phone number
router.post('/create-account', async (req, res) => {
    try {
        const { phoneNumber, displayName } = req.body;
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
            phoneNumber,
            displayName: displayName || phoneNumber
        });
        // Create a custom token for the phone number
        const customToken = await admin.auth().createCustomToken(phoneNumber);
        res.status(201).json({
            message: 'Account created successfully',
            user: {
                phoneNumber: user.phoneNumber,
                displayName: user.displayName,
                createdAt: user.createdAt
            },
            token: customToken
        });
    }
    catch (error) {
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
        // Create a custom token for the phone number
        const customToken = await admin.auth().createCustomToken(phoneNumber);
        res.json({ token: customToken });
    }
    catch (error) {
        console.error('Error verifying phone number:', error);
        res.status(500).json({ error: 'Error verifying phone number' });
    }
});
// Verify the Firebase ID token and get user info
router.post('/verify-token', authenticateUser, async (req, res) => {
    try {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ error: 'User not authenticated' });
        }
        // Find user in our database
        const dbUser = await User.findOne({ phoneNumber: user.phoneNumber });
        if (!dbUser) {
            return res.status(404).json({ error: 'User not found' });
        }
        // Update last login
        dbUser.lastLogin = new Date();
        await dbUser.save();
        res.json({
            uid: user.uid,
            phoneNumber: user.phoneNumber,
            displayName: dbUser.displayName,
            createdAt: dbUser.createdAt,
            lastLogin: dbUser.lastLogin
        });
    }
    catch (error) {
        console.error('Error verifying token:', error);
        res.status(500).json({ error: 'Error verifying token' });
    }
});
export default router;
//# sourceMappingURL=auth.js.map