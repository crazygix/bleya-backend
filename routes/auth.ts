import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { UnauthorizedError } from '../utils/errors.js';
import { config } from '../config/index.js';
import * as authService from '../services/authService.js';
import { getUserProfile } from '../services/userService.js';

const router = express.Router();

const PROD = config.isProduction;

const providerSignInLimiter = createRateLimiter({
    name: 'auth.provider-sign-in',
    limit: PROD ? 20 : 200,
});
const passkeyRegistrationLimiter = createRateLimiter({
    name: 'auth.passkey-registration',
    limit: PROD ? 10 : 200,
});
const passkeyAuthenticationLimiter = createRateLimiter({
    name: 'auth.passkey-authentication',
    limit: PROD ? 30 : 200,
});
const refreshLimiter = createRateLimiter({
    name: 'auth.refresh',
    limit: PROD ? 60 : 600,
});

function setRefreshCookie(res: express.Response, refreshToken: string): void {
    res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: 'lax',
        expires: authService.getRefreshExpiryDate(),
        path: '/',
    });
}

function buildAndroidAppleRedirect(body: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
        if (typeof value === 'string') {
            params.append(key, value);
        }
    }

    return `intent://callback?${params.toString()}#Intent;package=${config.authProviders.androidPackageName};scheme=signinwithapple;end`;
}

router.post('/provider-sign-in', providerSignInLimiter, asyncHandler(async (req: express.Request, res: express.Response) => {
    const result = await authService.providerSignIn({
        provider: req.body.provider,
        idToken: req.body.idToken,
        rawNonce: req.body.rawNonce,
        platform: req.body.platform,
        authorizationCode: req.body.authorizationCode,
    });

    setRefreshCookie(res, result.refreshToken);
    res.json({
        token: result.token,
        requiresUsername: result.requiresUsername,
        hasPasskey: result.hasPasskey,
    });
}));

router.get('/security', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await authService.getSecurityStatus(req.user!.userId);
    res.json(result);
}));

router.post('/passkeys/registration/options', authenticateUser, passkeyRegistrationLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await authService.beginPasskeyRegistration(req.user!.userId);
    res.json(result);
}));

router.post('/passkeys/registration/verify', authenticateUser, passkeyRegistrationLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await authService.finishPasskeyRegistration(
        req.user!.userId,
        req.body.challengeId,
        req.body.response,
    );
    res.json(result);
}));

router.post('/passkeys/authentication/options', passkeyAuthenticationLimiter, asyncHandler(async (_req: express.Request, res: express.Response) => {
    const result = await authService.beginPasskeyAuthentication();
    res.json(result);
}));

router.post('/passkeys/authentication/verify', passkeyAuthenticationLimiter, asyncHandler(async (req: express.Request, res: express.Response) => {
    const result = await authService.finishPasskeyAuthentication(req.body.challengeId, req.body.response);
    setRefreshCookie(res, result.refreshToken);
    res.json({
        token: result.token,
        requiresUsername: result.requiresUsername,
        hasPasskey: result.hasPasskey,
    });
}));

router.post(config.authProviders.appleAndroidCallbackRoute, asyncHandler(async (req: express.Request, res: express.Response) => {
    res.redirect(302, buildAndroidAppleRedirect(req.body || {}));
}));

router.get(config.authProviders.appleAndroidCallbackRoute, asyncHandler(async (req: express.Request, res: express.Response) => {
    res.redirect(302, buildAndroidAppleRedirect(req.query as Record<string, unknown>));
}));

router.get('/me', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const profile = await getUserProfile(req.user!.userId);
    res.json(profile);
}));

router.post('/refresh', refreshLimiter, asyncHandler(async (req: express.Request, res: express.Response) => {
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
