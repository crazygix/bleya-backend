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
// Its `sub` must be the client id the code/token was issued to.
function buildClientSecret(clientId: string): string {
    const a = config.apple;
    const nowSec = Math.floor(Date.now() / 1000);
    const privateKey = a.privateKey.replace(/\\n/g, '\n');
    return jwt.sign(
        {
            iss: a.teamId,
            iat: nowSec,
            exp: nowSec + 300,
            aud: 'https://appleid.apple.com',
            sub: clientId,
        },
        privateKey,
        { algorithm: 'ES256', keyid: a.keyId }
    );
}

// Apple issues codes and tokens per client: the iOS bundle id for native
// sign-in, the Services ID for the Android web flow. Use the ID token's
// audience when it is one of ours, and fall back to APPLE_REVOKE_CLIENT_ID.
function resolveClientId(audience?: string | null): string {
    if (audience && config.authProviders.appleAllowedAudiences.includes(audience)) {
        return audience;
    }
    return config.apple.revokeClientId;
}

// Codes from the Android web flow were requested with our callback as the
// redirect_uri, and Apple requires the same value when redeeming them.
function redirectUriFor(clientId: string): string | undefined {
    const androidServiceId = config.authProviders.appleAndroidServiceId;
    return androidServiceId && clientId === androidServiceId
        ? `${config.urls.publicOrigin}${config.authProviders.appleAndroidRedirectPath}`
        : undefined;
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

export async function exchangeAuthorizationCode(code: string, clientId: string): Promise<string | null> {
    if (!isAppleRevocationConfigured()) {
        return null;
    }

    const params: Record<string, string> = {
        client_id: clientId,
        client_secret: buildClientSecret(clientId),
        code,
        grant_type: 'authorization_code',
    };
    const redirectUri = redirectUriFor(clientId);
    if (redirectUri) {
        params.redirect_uri = redirectUri;
    }

    const res = await postForm(APPLE_TOKEN_URL, params);

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
    authorizationCode?: string | null,
    audience?: string | null
): Promise<void> {
    if (provider !== 'apple' || !authorizationCode || !isAppleRevocationConfigured()) {
        return;
    }

    try {
        const clientId = resolveClientId(audience);
        const refreshToken = await exchangeAuthorizationCode(authorizationCode, clientId);
        if (refreshToken) {
            await UserIdentity.updateOne(
                { provider: 'apple', providerUserId },
                { $set: { appleRefreshToken: refreshToken, appleClientId: clientId } }
            );
        }
    } catch (error) {
        logger.error('apple.capture_failed', { error: error instanceof Error ? error.message : 'unknown' });
    }
}

// `clientId` is the client the token was issued to (stored with it at sign-in);
// Apple rejects a revocation signed for a different client.
export async function revokeRefreshToken(refreshToken: string, clientId?: string | null): Promise<void> {
    if (!isAppleRevocationConfigured() || !refreshToken) {
        return;
    }

    const resolvedClientId = clientId || config.apple.revokeClientId;
    const res = await postForm(APPLE_REVOKE_URL, {
        client_id: resolvedClientId,
        client_secret: buildClientSecret(resolvedClientId),
        token: refreshToken,
        token_type_hint: 'refresh_token',
    });

    if (res && !res.ok) {
        logger.warn('apple.revoke_failed', { status: res.status });
    }
}
