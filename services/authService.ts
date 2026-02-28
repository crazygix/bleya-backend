import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User } from '../models/User.js';
import { AppError, ValidationError, UnauthorizedError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { sanitizePhoneNumber, sanitizeUsername } from '../utils/sanitize.js';
import { config } from '../config/index.js';
import { type UserProfileResponse, toUserProfileResponse } from './userService.js';

const ACCESS_TOKEN_TTL = config.accessTokenTtl as jwt.SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL_DAYS = config.refreshTokenTtlDays;
const CODE_EXPIRY_MINUTES = 10;
const RESEND_COOLDOWN_MS = 60 * 1000;

function isValidPhoneNumber(phoneNumber: string): boolean {
    return /^\+?[0-9]{10,15}$/.test(phoneNumber);
}

function normalizePhoneNumber(phoneNumber: string): string {
    return sanitizePhoneNumber(phoneNumber);
}

function validatePhoneInput(phoneNumber: unknown): string {
    if (typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
        throw new ValidationError("What's your number?");
    }

    const normalized = normalizePhoneNumber(phoneNumber);
    if (!isValidPhoneNumber(normalized)) {
        throw new ValidationError("That doesn't look like a valid number. Try again?");
    }

    return normalized;
}

export function signAccessToken(payload: { userId: string }): string {
    return jwt.sign(payload, config.jwtSecret, {
        expiresIn: ACCESS_TOKEN_TTL,
        algorithm: 'HS256',
    });
}

function generateVerificationCode(): string {
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function generateRefreshToken(): string {
    return crypto.randomBytes(48).toString('hex');
}

export function hashRefreshToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export function getRefreshExpiryDate(): Date {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + REFRESH_TOKEN_TTL_DAYS);
    return expiry;
}

export interface RequestCodeResult {
    code: string;
    codeSentAt: Date;
}

export async function requestCode(phoneNumber: unknown): Promise<RequestCodeResult> {
    const normalizedPhone = validatePhoneInput(phoneNumber);

    const code = generateVerificationCode();
    const codeExpiresAt = new Date();
    codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + CODE_EXPIRY_MINUTES);
    const codeSentAt = new Date();

    const user = await User.findOneAndUpdate(
        { phoneNumber: normalizedPhone },
        {
            $set: { code, codeExpiresAt, codeSentAt },
            $setOnInsert: { phoneNumber: normalizedPhone },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (!user) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Failed to process verification request', 500);
    }

    return { code, codeSentAt };
}

export interface VerifyCodeResult {
    accessToken: string;
    refreshToken: string;
    requiresUsername: boolean;
}

export async function verifyCode(phoneNumber: unknown, code: unknown): Promise<VerifyCodeResult> {
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

    const accessToken = signAccessToken({ userId: user._id.toString() });
    const requiresUsername = !user.username || user.username.trim().length === 0;

    return { accessToken, refreshToken, requiresUsername };
}

export async function resendCode(phoneNumber: unknown): Promise<RequestCodeResult> {
    const normalizedPhone = validatePhoneInput(phoneNumber);

    const user = await User.findOne({ phoneNumber: normalizedPhone });
    if (!user) {
        throw new NotFoundError('User not found');
    }

    const now = new Date();
    if (user.codeSentAt) {
        const timeSinceLastSent = now.getTime() - user.codeSentAt.getTime();
        if (timeSinceLastSent < RESEND_COOLDOWN_MS) {
            const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - timeSinceLastSent) / 1000);
            throw new ValidationError(
                `Hold on! Wait ${remainingSeconds} second${remainingSeconds !== 1 ? 's' : ''} before requesting a new code.`
            );
        }
    }

    const code = generateVerificationCode();
    const codeExpiresAt = new Date();
    codeExpiresAt.setMinutes(codeExpiresAt.getMinutes() + CODE_EXPIRY_MINUTES);
    const codeSentAt = new Date();

    user.code = code;
    user.codeExpiresAt = codeExpiresAt;
    user.codeSentAt = codeSentAt;
    await user.save();

    return { code, codeSentAt };
}

export interface RefreshResult {
    accessToken: string;
    refreshToken: string;
}

export async function refreshAccessToken(currentRefreshToken: string): Promise<RefreshResult> {
    const hashed = hashRefreshToken(currentRefreshToken);
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
        throw new UnauthorizedError('Invalid or expired refresh token');
    }

    const accessToken = signAccessToken({ userId: user._id.toString() });
    return { accessToken, refreshToken: newRefresh };
}

export async function logout(refreshToken: string): Promise<void> {
    const hashed = hashRefreshToken(refreshToken);
    await User.findOneAndUpdate(
        { refreshTokenHash: hashed },
        { $unset: { refreshTokenHash: '', refreshTokenExpiresAt: '' } }
    );
}

export async function checkUsernameAvailability(username: unknown): Promise<boolean> {
    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new ValidationError('How should we call you?');
    }

    const normalizedUsername = sanitizeUsername(username);
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
        return false;
    }

    const existingUser = await User.findOne({ username: normalizedUsername }).select('_id').lean();
    return !existingUser;
}

export async function setUsername(userId: string, username: unknown): Promise<UserProfileResponse> {
    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new ValidationError('How should we call you?');
    }

    const normalizedUsername = sanitizeUsername(username);
    if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
        throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
    }

    const user = await User.findById(userId);
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

    return toUserProfileResponse(user);
}
