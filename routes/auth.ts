import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { UnauthorizedError } from '../utils/errors.js';
import { config } from '../config/index.js';
import * as authService from '../services/authService.js';
import { getUserProfile } from '../services/userService.js';

const router = express.Router();

const authRateLimit = config.isProduction ? 5 : 100;
const requestCodeRateLimit = config.isProduction ? 3 : 100;

function buildVerificationCodeResponse(message: string, code: string, codeSentAt: Date): {
    message: string;
    codeSentAt: number;
    code?: string;
} {
    return {
        message,
        codeSentAt: codeSentAt.getTime(),
        ...(config.isProduction ? {} : { code }),
    };
}

function setRefreshCookie(res: express.Response, refreshToken: string): void {
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        expires: authService.getRefreshExpiryDate(),
        path: '/',
    });
}

router.post('/request-code', rateLimiter(requestCodeRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const result = await authService.requestCode(req.body.phoneNumber);
    res.json(buildVerificationCodeResponse('Verification code sent', result.code, result.codeSentAt));
}));

router.post('/verify-code', rateLimiter(authRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const result = await authService.verifyCode(req.body.phoneNumber, req.body.code);
    setRefreshCookie(res, result.refreshToken);
    res.json({ token: result.accessToken, requiresUsername: result.requiresUsername });
}));

router.post('/resend-code', rateLimiter(requestCodeRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const result = await authService.resendCode(req.body.phoneNumber);
    res.json(buildVerificationCodeResponse('Verification code resent', result.code, result.codeSentAt));
}));

router.get('/me', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await getUserProfile(req.user!.userId);
    res.json(profile);
}));

router.post('/refresh', rateLimiter(authRateLimit, 15 * 60 * 1000), asyncHandler(async (req: express.Request, res: express.Response) => {
    const { refreshToken } = req.cookies || {};
    if (!refreshToken) {
        res.clearCookie('refreshToken', { path: '/' });
        throw new UnauthorizedError('Missing refresh token');
    }

    try {
        const result = await authService.refreshAccessToken(refreshToken);
        setRefreshCookie(res, result.refreshToken);
        res.json({ token: result.accessToken });
    } catch (error) {
        res.clearCookie('refreshToken', { path: '/' });
        throw error;
    }
}));

router.post('/check-username', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const available = await authService.checkUsernameAvailability(req.body.username);
    res.json({ available });
}));

router.post('/set-username', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await authService.setUsername(req.user!.userId, req.body.username);
    res.json(profile);
}));

router.post('/logout', asyncHandler(async (req: express.Request, res: express.Response) => {
    const { refreshToken } = req.cookies || {};
    if (refreshToken) {
        await authService.logout(refreshToken);
    }
    res.clearCookie('refreshToken', { path: '/' });
    res.json({ success: true });
}));

export default router;
