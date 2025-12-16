import express from 'express';
import jwt, { Secret } from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { ValidationError, UnauthorizedError, NotFoundError, ErrorCode, InternalError } from '../utils/errors.js';

const router = express.Router();

// Token config (defaults if env not set)
const ACCESS_TOKEN_TTL: string | number = process.env.ACCESS_TOKEN_TTL || '1m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 1);

// Code expiration time (10 minutes)
const CODE_EXPIRY_MINUTES = 10;

/**
 * Normalize phone number by removing spaces, dashes, and parentheses
 * This ensures consistent storage and comparison
 */
function normalizePhoneNumber(phoneNumber: string): string {
    return phoneNumber.trim().replace(/[\s\-\(\)]/g, '');
}

/**
 * Validate phone number format
 * Must be 10-15 digits, optionally starting with +
 */
function validatePhoneNumber(phoneNumber: string): boolean {
    return /^\+?[0-9]{10,15}$/.test(phoneNumber);
}

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
        path: '/'
    });
}

// Test endpoint to debug request body parsing
// TODO: Remove or protect this endpoint in production
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

// Request code (send code to user)
// Rate limit: 3 requests per 15 minutes per IP to prevent abuse
router.post('/request-code', rateLimiter(3, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        throw new ValidationError('Phone number is required');
    }

    // Validate phone number format (basic validation)
    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError('Phone number must be a valid string');
    }

    // Normalize phone number (remove spaces, dashes, etc.)
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    // Validate phone number format
    if (!validatePhoneNumber(normalizedPhone)) {
        throw new ValidationError('Phone number must be 10-15 digits');
    }

    // Generate a 6-digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Code expires in CODE_EXPIRY_MINUTES minutes
    const codeExpiresAt = new Date();
    codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + CODE_EXPIRY_MINUTES);

    // Find or create user and set code
    let user = await User.findOne({ phoneNumber: normalizedPhone });
    if (!user) {
        user = await User.create({
            phoneNumber: normalizedPhone,
            code,
            codeExpiresAt
        });
    } else {
        user.code = code;
        user.codeExpiresAt = codeExpiresAt;
        await user.save();
    }

    // In production, send code via SMS here
    // For now, return code in response for testing (TODO: Remove in production)
    res.json({ message: 'Verification code sent', code });
}));

// Verify code and get JWT
// Rate limit: 5 attempts per 15 minutes per IP to prevent brute force
router.post('/verify-code', rateLimiter(5, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { phoneNumber, code } = req.body;
    if (!phoneNumber || !code) {
        throw new ValidationError('Phone number and code are required');
    }

    // Validate phone number format (basic validation)
    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError('Phone number must be a valid string');
    }

    // Validate code format (must be 6 digits)
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
        throw new ValidationError('Code must be a 6-digit number');
    }

    // Normalize phone number (same as in request-code)
    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    const user = await User.findOne({ phoneNumber: normalizedPhone });

    // Check if user exists
    if (!user) {
        throw new UnauthorizedError('Invalid phone number or code');
    }

    // Check if code exists and hasn't expired
    if (!user.code || !user.codeExpiresAt) {
        throw new UnauthorizedError('No verification code found. Please request a new code.');
    }

    const now = new Date();
    if (user.codeExpiresAt < now) {
        // Code expired, clear it
        user.code = undefined;
        user.codeExpiresAt = undefined;
        await user.save();
        throw new UnauthorizedError('Verification code has expired. Please request a new code.');
    }

    // Verify code matches
    if (user.code !== code) {
        throw new UnauthorizedError('Invalid phone number or code');
    }

    // Clear the code after successful verification
    user.code = undefined;
    user.codeExpiresAt = undefined;
    // Update last login timestamp only on successful authentication
    user.lastLogin = new Date();
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
}));

// Example protected route
router.get('/me', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }
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

// Exchange refresh token for a new access token (and rotate refresh)
// Rate limit: 5 requests per 15 minutes per IP
router.post('/refresh', rateLimiter(5, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { refreshToken } = req.cookies || {};

    if (!refreshToken) {
        res.clearCookie('refreshToken', { path: '/' });
        throw new UnauthorizedError('Missing refresh token');
    }

    const hashed = hashRefreshToken(refreshToken);
    const now = new Date();

    // Atomically find and update the user with the matching refresh token hash
    // This prevents race conditions when multiple refresh requests occur simultaneously
    const newRefresh = generateRefreshToken();
    const newRefreshHash = hashRefreshToken(newRefresh);
    const newExpiry = getRefreshExpiryDate();

    const user = await User.findOneAndUpdate(
        {
            refreshTokenHash: hashed,
            refreshTokenExpiresAt: { $gt: now } // Ensure token hasn't expired
        },
        {
            $set: {
                refreshTokenHash: newRefreshHash,
                refreshTokenExpiresAt: newExpiry
            }
        },
        { new: true } // Return the updated document
    );

    if (!user) {
        res.clearCookie('refreshToken', { path: '/' });
        throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const payload = { phoneNumber: user.phoneNumber, userId: user._id.toString() };
    const accessToken = signAccessToken(payload);

    setRefreshCookie(res, newRefresh);

    res.json({ token: accessToken });
}));

// Logout: clear refresh token cookie and invalidate stored hash
router.post('/logout', asyncHandler(async (req: express.Request, res: express.Response) => {
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
    res.clearCookie('refreshToken', { path: '/' });
    res.json({ success: true });
}));

export default router;