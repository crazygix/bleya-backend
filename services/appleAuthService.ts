import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { UserIdentity } from '../models/UserIdentity.js';
import logger from '../utils/logger.js';

// Sign in with Apple server-to-server: exchange the authorization code captured
// at sign-in for a refresh token, and revoke that token when the account is
// deleted (Apple App Store Guideline 5.1.1(v)). Everything here no-ops unless
// the four Apple secrets are configured, so it is safe to ship before they are.

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export function isAppleRevocationConfigured(): boolean {
    const a = config.apple;
    return Boolean(a.revokeClientId && a.teamId && a.keyId && a.privateKey);
}

// The client secret is a short-lived ES256 JWT signed with the Apple .p8 key.
function buildClientSecret(): string {
    const a = config.apple;
    const nowSec = Math.floor(Date.now() / 1000);
    const privateKey = a.privateKey.replace(/\\n/g, '\n');
    return jwt.sign(
        {
            iss: a.teamId,
            iat: nowSec,
            exp: nowSec + 300,
            aud: 'https://appleid.apple.com',
            sub: a.revokeClientId,
        },
        privateKey,
        { algorithm: 'ES256', keyid: a.keyId }
    );
}

async function postForm(url: string, params: Record<string, string>): Promise<Response | null> {
    try {
        return await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });
    } catch (error) {
        logger.error('apple.request_error', { url, error: error instanceof Error ? error.message : 'unknown' });
        return null;
    }
}

export async function exchangeAuthorizationCode(code: string): Promise<string | null> {
    if (!isAppleRevocationConfigured()) {
        return null;
    }

    const res = await postForm(APPLE_TOKEN_URL, {
        client_id: config.apple.revokeClientId,
        client_secret: buildClientSecret(),
        code,
        grant_type: 'authorization_code',
    });

    if (!res) {
        return null;
    }
    if (!res.ok) {
        logger.warn('apple.token_exchange_failed', { status: res.status });
        return null;
    }

    const data = (await res.json()) as { refresh_token?: string };
    return data.refresh_token || null;
}

// Called at sign-in. Stores the Apple refresh token on the identity so it can be
// revoked later. Requires the client to send the authorization code (a mobile
// change); until then this simply does nothing.
export async function captureAppleRefreshToken(
    provider: string,
    providerUserId: string,
    authorizationCode?: string | null
): Promise<void> {
    if (provider !== 'apple' || !authorizationCode || !isAppleRevocationConfigured()) {
        return;
    }

    try {
        const refreshToken = await exchangeAuthorizationCode(authorizationCode);
        if (refreshToken) {
            await UserIdentity.updateOne(
                { provider: 'apple', providerUserId },
                { $set: { appleRefreshToken: refreshToken } }
            );
        }
    } catch (error) {
        logger.error('apple.capture_failed', { error: error instanceof Error ? error.message : 'unknown' });
    }
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
    if (!isAppleRevocationConfigured() || !refreshToken) {
        return;
    }

    const res = await postForm(APPLE_REVOKE_URL, {
        client_id: config.apple.revokeClientId,
        client_secret: buildClientSecret(),
        token: refreshToken,
        token_type_hint: 'refresh_token',
    });

    if (res && !res.ok) {
        logger.warn('apple.revoke_failed', { status: res.status });
    }
}
