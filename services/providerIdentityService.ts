import crypto from 'crypto';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../config/index.js';
import { AppError, ErrorCode, UnauthorizedError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export interface VerifiedIdentityProfile {
    provider: 'google' | 'apple';
    providerUserId: string;
    email: string;
    emailVerified: boolean;
    isPrivateRelay: boolean;
}

export interface ProviderIdentityService {
    verifyGoogleIdToken(idToken: string, rawNonce?: string): Promise<VerifiedIdentityProfile>;
    verifyAppleIdToken(idToken: string, rawNonce?: string): Promise<VerifiedIdentityProfile>;
}

const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

function normalizeEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseBooleanClaim(value: unknown): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value.trim().toLowerCase() === 'true';
    }
    return false;
}

function parseTestClaims(idToken: string): JWTPayload | null {
    if (!config.isTest || !idToken.startsWith('test.')) {
        return null;
    }

    const [, encodedClaims] = idToken.split('.', 2);
    if (!encodedClaims) {
        return null;
    }

    try {
        return JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as JWTPayload;
    } catch {
        return null;
    }
}

function assertAudiencesConfigured(provider: 'google' | 'apple'): string[] {
    const audiences = provider === 'google'
        ? config.authProviders.googleAllowedAudiences
        : config.authProviders.appleAllowedAudiences;

    if (audiences.length === 0) {
        throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            `${provider} authentication is not configured on the server.`,
            500
        );
    }

    return audiences;
}

function sha256Base64Url(input: string): string {
    return crypto.createHash('sha256').update(input).digest('base64url');
}

function assertNonceMatches(
    provider: 'google' | 'apple',
    claims: JWTPayload,
    rawNonce?: string,
): void {
    if (!rawNonce) {
        return;
    }

    const tokenNonce = typeof claims.nonce === 'string' ? claims.nonce : '';
    const expectedHashed = sha256Base64Url(rawNonce);
    if (tokenNonce && tokenNonce !== rawNonce && tokenNonce !== expectedHashed) {
        throw new UnauthorizedError(`Unable to verify that ${provider === 'google' ? 'Google' : 'Apple'} sign-in attempt.`);
    }
}

function rethrowAsUnauthorized(provider: 'google' | 'apple', error: unknown): never {
    if (error instanceof joseErrors.JOSEError) {
        logger.warn('auth.provider.token_verification_failed', {
            provider,
            code: error.code,
            name: error.name,
            message: error.message,
        });
        throw new UnauthorizedError(`Unable to verify that ${provider === 'google' ? 'Google' : 'Apple'} sign-in attempt.`);
    }
    throw error;
}

function buildVerifiedIdentity(
    provider: 'google' | 'apple',
    claims: JWTPayload,
): VerifiedIdentityProfile {
    const providerUserId = typeof claims.sub === 'string' ? claims.sub : '';
    if (!providerUserId) {
        throw new UnauthorizedError('Unable to verify that identity.');
    }

    return {
        provider,
        providerUserId,
        email: normalizeEmail(claims.email),
        emailVerified: parseBooleanClaim(claims.email_verified),
        isPrivateRelay: provider === 'apple' && parseBooleanClaim(claims.is_private_email),
    };
}

export class RemoteProviderIdentityService implements ProviderIdentityService {
    async verifyGoogleIdToken(idToken: string, rawNonce?: string): Promise<VerifiedIdentityProfile> {
        const testClaims = parseTestClaims(idToken);
        if (testClaims) {
            assertNonceMatches('google', testClaims, rawNonce);
            return buildVerifiedIdentity('google', testClaims);
        }

        const audiences = assertAudiencesConfigured('google');
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, googleJwks, {
                issuer: ['https://accounts.google.com', 'accounts.google.com'],
                audience: audiences,
            }));
        } catch (error) {
            rethrowAsUnauthorized('google', error);
        }

        assertNonceMatches('google', payload, rawNonce);

        return buildVerifiedIdentity('google', payload);
    }

    async verifyAppleIdToken(idToken: string, rawNonce?: string): Promise<VerifiedIdentityProfile> {
        const testClaims = parseTestClaims(idToken);
        if (testClaims) {
            assertNonceMatches('apple', testClaims, rawNonce);
            return buildVerifiedIdentity('apple', testClaims);
        }

        const audiences = assertAudiencesConfigured('apple');
        let payload: JWTPayload;
        try {
            ({ payload } = await jwtVerify(idToken, appleJwks, {
                issuer: 'https://appleid.apple.com',
                audience: audiences,
            }));
        } catch (error) {
            rethrowAsUnauthorized('apple', error);
        }

        assertNonceMatches('apple', payload, rawNonce);

        return buildVerifiedIdentity('apple', payload);
    }
}

export const providerIdentityService: ProviderIdentityService = new RemoteProviderIdentityService();
