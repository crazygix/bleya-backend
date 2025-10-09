import express from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';

const router = express.Router();

// Token config (defaults if env not set)
const ACCESS_TOKEN_TTL: string | number = process.env.ACCESS_TOKEN_TTL || '60m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 365);

function signAccessToken(payload: { userId: string; phoneNumber: string }) {
    const secret: Secret = process.env.JWT_SECRET as Secret;
    const options: jwt.SignOptions = { expiresIn: ACCESS_TOKEN_TTL as any, algorithm: 'HS256' };
    return jwt.sign(payload, secret, options);
}

function generateRefreshToken(): string {
    return crypto.randomBytes(48).toString('hex');
}

function hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function getRefreshExpiryDate(): Date {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + REFRESH_TOKEN_TTL_DAYS);
    return expiry;
}

function setRefreshCookie(res: express.Response, refreshToken: string) {
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        expires: getRefreshExpiryDate(),
        path: '/api/auth'
    });
}

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

// Removed redundant create-account and verify-phone routes

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

        // Issue access token and refresh token (rotated)
        const payload = { phoneNumber: user.phoneNumber, userId: user._id.toString() };
        const accessToken = signAccessToken(payload);

        const refreshToken = generateRefreshToken();
        user.refreshTokenHash = hashRefreshToken(refreshToken);
        user.refreshTokenExpiresAt = getRefreshExpiryDate();
        await user.save();

        setRefreshCookie(res, refreshToken);

        res.json({ token: accessToken });
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

// Exchange refresh token for a new access token (and rotate refresh)
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.cookies || {};
        if (!refreshToken) {
            return res.status(401).json({ error: 'Missing refresh token' });
        }

        const hashed = hashRefreshToken(refreshToken);
        const user = await User.findOne({ refreshTokenHash: hashed });
        if (!user || !user.refreshTokenExpiresAt || user.refreshTokenExpiresAt < new Date()) {
            res.clearCookie('refreshToken', { path: '/api/auth' });
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        const payload = { phoneNumber: user.phoneNumber, userId: user._id.toString() };
        const accessToken = signAccessToken(payload);

        // Rotate refresh token
        const newRefresh = generateRefreshToken();
        user.refreshTokenHash = hashRefreshToken(newRefresh);
        user.refreshTokenExpiresAt = getRefreshExpiryDate();
        await user.save();

        setRefreshCookie(res, newRefresh);

        res.json({ token: accessToken });
    } catch (error) {
        console.error('Error refreshing token:', error);
        res.status(500).json({ error: 'Error refreshing token' });
    }
});

// Logout: clear refresh token cookie and invalidate stored hash
router.post('/logout', async (req, res) => {
    try {
        const { refreshToken } = req.cookies || {};
        if (refreshToken) {
            const hashed = hashRefreshToken(refreshToken);
            const user = await User.findOne({ refreshTokenHash: hashed });
            if (user) {
                user.refreshTokenHash = undefined as unknown as string;
                user.refreshTokenExpiresAt = undefined as unknown as Date;
                await user.save();
            }
        }
        res.clearCookie('refreshToken', { path: '/api/auth' });
        res.json({ success: true });
    } catch (error) {
        console.error('Error during logout:', error);
        res.status(500).json({ error: 'Error during logout' });
    }
});