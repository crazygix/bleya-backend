import express from 'express';
import { authenticateUser, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { AppError, UnauthorizedError } from '../utils/errors.js';
import { config } from '../config/index.js';
import * as authService from '../services/authService.js';
import { disconnectUser } from '../server/socket.js';

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
    const result = await authService.beginPasskeyRegistration(req.user!.userId, req.user!.tokenIssuedAt);
    res.json(result);
}));

router.get('/passkeys', authenticateUser, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const passkeys = await authService.listPasskeys(req.user!.userId);
    res.json(passkeys);
}));

router.delete('/passkeys/:passkeyId', authenticateUser, passkeyRegistrationLimiter, asyncHandler(async (req: AuthRequest, res: express.Response) => {
    const result = await authService.deletePasskey(req.user!.userId, req.params.passkeyId, req.user!.tokenIssuedAt);
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
        // Only a rejected session (invalid/expired token, or a banned account)
        // ends it. A transient failure such as a database blip must keep the
        // cookie, or the user is logged out for our outage.
        if (error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)) {
            res.clearCookie('refreshToken', { path: '/' });
        }
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
        const userId = await authService.logout(refreshToken);
        // End the realtime session too, not just the refresh token.
        if (userId) {
            disconnectUser(userId);
        }
    }
    res.clearCookie('refreshToken', { path: '/' });
    res.json({ success: true });
}));

export default router;
