import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { ValidationError, UnauthorizedError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { sanitizePhoneNumber, sanitizeUsername } from '../utils/sanitize.js';
import { config } from '../config/index.js';

const router = express.Router();

const ACCESS_TOKEN_TTL = config.accessTokenTtl as jwt.SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL_DAYS = config.refreshTokenTtlDays;
const CODE_EXPIRY_MINUTES = 10;
const RESEND_COOLDOWN_MS = 60 * 1000;

function validatePhoneNumber(phoneNumber: string): boolean {
    return /^\+?[0-9]{10,15}$/.test(phoneNumber);
}

function normalizePhoneNumber(phoneNumber: string): string {
    return sanitizePhoneNumber(phoneNumber);
}

function signAccessToken(payload: { userId: string; phoneNumber: string }): string {
    const options: jwt.SignOptions = {
        expiresIn: ACCESS_TOKEN_TTL,
        algorithm: 'HS256',
    };

    return jwt.sign(payload, config.jwtSecret, options);
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

function setRefreshCookie(res: express.Response, refreshToken: string): void {
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        expires: getRefreshExpiryDate(),
        path: '/',
    });
}

const authRateLimit = config.isProduction ? 5 : 100;
const requestCodeRateLimit = config.isProduction ? 3 : 100;

router.post('/request-code', rateLimiter(requestCodeRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { phoneNumber } = req.body;

    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError("What's your number?");
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!validatePhoneNumber(normalizedPhone)) {
        throw new ValidationError("That doesn't look like a valid number. Try again?");
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpiresAt = new Date();
    codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + CODE_EXPIRY_MINUTES);
    const codeSentAt = new Date();

    const user = await User.findOneAndUpdate(
        { phoneNumber: normalizedPhone },
        {
            $set: {
                code,
                codeExpiresAt,
                codeSentAt,
            },
            $setOnInsert: {
                phoneNumber: normalizedPhone,
            },
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }
    );

    if (!user) {
        throw new Error('Failed to create or update user for OTP request');
    }

    res.json({
        message: 'Verification code sent',
        code,
        codeSentAt: codeSentAt.getTime(),
    });
}));

router.post('/verify-code', rateLimiter(authRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { phoneNumber, code } = req.body;

    if (!phoneNumber || !code) {
        throw new ValidationError('We need both your number and the code.');
    }

    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError("What's your number?");
    }

    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) {
        throw new ValidationError("That code doesn't look complete. Try again?");
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    const user = await User.findOne({ phoneNumber: normalizedPhone });

    if (!user) {
        throw new UnauthorizedError("That code doesn't look right. Try again?");
    }

    if (!user.code || !user.codeExpiresAt) {
        throw new UnauthorizedError('No code found. Request a new one?');
    }

    const now = new Date();
    if (user.codeExpiresAt < now) {
        user.code = undefined;
        user.codeExpiresAt = undefined;
        await user.save();
        throw new UnauthorizedError('That code expired. Request a new one?');
    }

    if (user.code !== code) {
        throw new UnauthorizedError("That code doesn't look right. Try again?");
    }

    user.code = undefined;
    user.codeExpiresAt = undefined;
    user.lastLogin = now;

    const refreshToken = generateRefreshToken();
    user.refreshTokenHash = hashRefreshToken(refreshToken);
    user.refreshTokenExpiresAt = getRefreshExpiryDate();
    await user.save();

    const payload = { phoneNumber: user.phoneNumber, userId: user._id.toString() };
    const accessToken = signAccessToken(payload);

    setRefreshCookie(res, refreshToken);

    const requiresUsername = !user.username || user.username.trim().length === 0;
    res.json({
        token: accessToken,
        requiresUsername,
    });
}));

router.post('/resend-code', rateLimiter(requestCodeRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { phoneNumber } = req.body;

    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError("What's your number?");
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    if (!validatePhoneNumber(normalizedPhone)) {
        throw new ValidationError("That doesn't look like a valid number. Try again?");
    }

    const user = await User.findOne({ phoneNumber: normalizedPhone });
    if (!user) {
        throw new NotFoundError('User not found');
    }

    const now = new Date();
    if (user.codeSentAt) {
        const timeSinceLastSent = now.getTime() - user.codeSentAt.getTime();
        if (timeSinceLastSent < RESEND_COOLDOWN_MS) {
            const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - timeSinceLastSent) / 1000);
            throw new ValidationError(`Hold on! Wait ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''} before requesting a new code.`);
        }
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpiresAt = new Date();
    codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + CODE_EXPIRY_MINUTES);
    const codeSentAt = new Date();

    user.code = code;
    user.codeExpiresAt = codeExpiresAt;
    user.codeSentAt = codeSentAt;
    await user.save();

    res.json({
        message: 'Verification code resent',
        code,
        codeSentAt: codeSentAt.getTime(),
    });
}));

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
        lastLogin: user.lastLogin.getTime(),
    });
}));

router.post('/refresh', rateLimiter(authRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { refreshToken } = req.cookies || {};

    if (!refreshToken) {
        res.clearCookie('refreshToken', { path: '/' });
        throw new UnauthorizedError('Missing refresh token');
    }

    const hashed = hashRefreshToken(refreshToken);
    const now = new Date();
    const newRefresh = generateRefreshToken();
    const newRefreshHash = hashRefreshToken(newRefresh);
    const newExpiry = getRefreshExpiryDate();

    const user = await User.findOneAndUpdate(
        {
            refreshTokenHash: hashed,
            refreshTokenExpiresAt: { $gt: now },
        },
        {
            $set: {
                refreshTokenHash: newRefreshHash,
                refreshTokenExpiresAt: newExpiry,
            },
        },
        { new: true }
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

router.post('/check-username', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { username } = req.body;

    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new ValidationError('How should we call you?');
    }

    const normalizedUsername = sanitizeUsername(username);

    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
        res.json({ available: false });
        return;
    }

    const existingUser = await User.findOne({ username: normalizedUsername }).select('_id').lean();
    res.json({ available: !existingUser });
}));

router.post('/set-username', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const { username } = req.body;

    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new ValidationError('How should we call you?');
    }

    const normalizedUsername = sanitizeUsername(username);
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
        throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
    }

    const user = await User.findOne({ phoneNumber: req.user?.phoneNumber });
    if (!user) {
        throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
    }

    if (user.username && user.username.trim().length > 0) {
        throw new ValidationError("You've already set your username and can't change it.");
    }

    const existingUser = await User.findOne({ username: normalizedUsername }).select('_id').lean();
    if (existingUser) {
        throw new ValidationError("That username's taken. Try another one?");
    }

    user.username = normalizedUsername;
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

router.post('/logout', asyncHandler(async (req: express.Request, res: express.Response) => {
    const { refreshToken } = req.cookies || {};
    if (refreshToken) {
        const hashed = hashRefreshToken(refreshToken);
        await User.findOneAndUpdate(
            { refreshTokenHash: hashed },
            { $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' } }
        );
    }
    res.clearCookie('refreshToken', { path: '/' });
    res.json({ success: true });
}));

export default router;
