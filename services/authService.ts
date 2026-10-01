import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { AppError, ValidationError, UnauthorizedError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { isValidUsername, normalizeUsernameInput } from '../utils/username.js';
import { assertCleanText, containsBlockedTerm } from '../utils/contentFilter.js';
import { describeEnforcementForUser, type EnforcementState } from '../utils/enforcement.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { captureAppleRefreshToken } from './appleAuthService.js';
import { type UserProfileResponse, toUserProfileResponse } from './userService.js';
import {
    type RefreshSessionUser,
    type UserRepository,
    userRepository as defaultUserRepo,
} from '../repositories/userRepository.js';
import {
    type UserIdentityRepository,
    userIdentityRepository as defaultUserIdentityRepo,
} from '../repositories/userIdentityRepository.js';
import {
    type PasskeyCredentialRepository,
    passkeyCredentialRepository as defaultPasskeyCredentialRepo,
} from '../repositories/passkeyCredentialRepository.js';
import {
    type AuthChallengeRepository,
    authChallengeRepository as defaultAuthChallengeRepo,
} from '../repositories/authChallengeRepository.js';
import {
    type ProviderIdentityService,
    providerIdentityService as defaultProviderIdentityService,
    type VerifiedIdentityProfile,
} from './providerIdentityService.js';
import {
    type PasskeyService,
    passkeyService as defaultPasskeyService,
} from './passkeyService.js';
import { isIdentityBanned } from './bannedIdentityService.js';
import type {
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
} from '@simplewebauthn/server';

const ACCESS_TOKEN_TTL = config.accessTokenTtl as jwt.SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL_DAYS = config.refreshTokenTtlDays;
const REFRESH_TOKEN_REUSE_WINDOW_MS = config.refreshTokenReuseWindowMs;
const PREVIOUS_REFRESH_TOKEN_TTL_MS = config.previousRefreshTokenTtlMs;

export type AuthProvider = 'google' | 'apple';

export interface AuthSessionResult {
    token: string;
    requiresUsername: boolean;
    hasPasskey: boolean;
}

export interface RefreshResult {
    accessToken: string;
    // Set when a new refresh token was issued, which the route sends as the
    // cookie. Absent when the presented token stays in use.
    refreshToken?: string;
}

export interface AuthSecurityStatus {
    hasPasskey: boolean;
}

export interface PasskeyOptionsResult {
    challengeId: string;
    options: Record<string, unknown>;
}

export interface PasskeySummary {
    id: string;
    deviceType: string;
    backedUp: boolean;
    createdAt: number | null;
    lastUsedAt: number | null;
}

// Adding (or removing) a passkey changes how the account can be entered, so it
// needs a fresh sign-in rather than any valid access token: the token must come
// from the current session (issued at or after its sign-in) and that sign-in
// must be recent. The app only offers registration right after sign-in or
// choosing a username, which is well inside this window.
const RECENT_SIGN_IN_WINDOW_MS = 30 * 60 * 1000;
// iat has one-second resolution; lastLogin is stamped just before signing.
const TOKEN_CLOCK_SKEW_MS = 5_000;

export interface AuthServiceDeps {
    userRepo: UserRepository;
    userIdentityRepo: UserIdentityRepository;
    passkeyCredentialRepo: PasskeyCredentialRepository;
    authChallengeRepo: AuthChallengeRepository;
    providerIdentityService: ProviderIdentityService;
    passkeyService: PasskeyService;
    // Whether a provider identity belongs to a banned/suspended account that was
    // deleted. Optional so DB-less unit tests can omit it (treated as not banned).
    isIdentityBanned?: (provider: AuthProvider, providerUserId: string) => Promise<boolean>;
}

type AuthUserDocument = mongoose.Document & EnforcementState & {
    _id: mongoose.Types.ObjectId;
    username?: string;
    bio?: string;
    profileImageUrl?: string;
    createdAt: Date;
    updatedAt: Date;
    lastLogin: Date;
    refreshTokenHash?: string;
    refreshTokenExpiresAt?: Date;
    refreshTokenIssuedAt?: Date;
    previousRefreshTokenHash?: string;
    previousRefreshTokenExpiresAt?: Date;
    revokedRefreshTokenHash?: string;
};

// Banned/suspended accounts get no session. 403 + USER_BLOCKED + a message the
// app can show as-is (it displays error.message).
function assertAccountMayStartSession(state: EnforcementState): void {
    const explanation = describeEnforcementForUser(state);
    if (explanation) {
        throw new AppError(ErrorCode.USER_BLOCKED, explanation, 403);
    }
}

export function signAccessToken(payload: { userId: string }): string {
    return jwt.sign(payload, config.jwtSecret, {
        expiresIn: ACCESS_TOKEN_TTL,
        algorithm: 'HS256',
    });
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

function normalizeProvider(value: unknown): AuthProvider {
    if (value === 'google' || value === 'apple') {
        return value;
    }

    throw new ValidationError('Choose a supported sign-in method.');
}

function normalizeIdToken(value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ValidationError('Missing identity token.');
    }

    return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function validateChallengeId(value: unknown): string {
    if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
        throw new ValidationError('That passkey request is no longer valid. Try again.');
    }

    return value;
}

function validateCredentialResponse(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('That passkey response could not be processed.');
    }

    return value as Record<string, unknown>;
}

function validateRegistrationResponse(value: unknown): RegistrationResponseJSON {
    return validateCredentialResponse(value) as unknown as RegistrationResponseJSON;
}

function validateAuthenticationResponse(value: unknown): AuthenticationResponseJSON {
    return validateCredentialResponse(value) as unknown as AuthenticationResponseJSON;
}

export function createAuthService(deps: AuthServiceDeps) {
    const {
        userRepo,
        userIdentityRepo,
        passkeyCredentialRepo,
        authChallengeRepo,
        providerIdentityService,
        passkeyService,
    } = deps;
    const isIdentityBanned = deps.isIdentityBanned ?? (async () => false);

    async function issueSessionForUser(user: AuthUserDocument): Promise<AuthSessionResult & { refreshToken: string }> {
        assertAccountMayStartSession(user);

        const now = new Date();
        const refreshToken = generateRefreshToken();
        user.refreshTokenHash = hashRefreshToken(refreshToken);
        user.refreshTokenExpiresAt = getRefreshExpiryDate();
        user.refreshTokenIssuedAt = now;
        // A new session replaces the old one entirely, including its previous
        // token and any session a past ban or suspension ended. These fields
        // aren't loaded (select: false); markModified makes sure each one is
        // saved as removed.
        user.previousRefreshTokenHash = undefined;
        user.previousRefreshTokenExpiresAt = undefined;
        user.revokedRefreshTokenHash = undefined;
        user.markModified('previousRefreshTokenHash');
        user.markModified('previousRefreshTokenExpiresAt');
        user.markModified('revokedRefreshTokenHash');
        user.lastLogin = now;
        await user.save();

        const accessToken = signAccessToken({ userId: user._id.toString() });
        const requiresUsername = !user.username || user.username.trim().length === 0;
        const hasPasskey = await passkeyCredentialRepo.existsForUser(user._id.toString());

        return {
            token: accessToken,
            refreshToken,
            requiresUsername,
            hasPasskey,
        };
    }

    async function loadUser(userId: string): Promise<AuthUserDocument> {
        const user = await userRepo.findById(userId) as AuthUserDocument | null;
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        return user;
    }

    async function resolveUserForVerifiedIdentity(identity: VerifiedIdentityProfile): Promise<AuthUserDocument> {
        const existingIdentity = await userIdentityRepo.findByProviderIdentity(identity.provider, identity.providerUserId);
        if (existingIdentity) {
            await userIdentityRepo.updateLastUsed(existingIdentity._id!.toString());
            return loadUser(existingIdentity.userId.toString());
        }

        // A banned (or still-suspended) account that was deleted can't come back
        // under the same Apple/Google identity.
        if (await isIdentityBanned(identity.provider, identity.providerUserId)) {
            throw new AppError(ErrorCode.USER_BLOCKED, 'This account has been banned.', 403);
        }

        const user = await userRepo.create({}) as AuthUserDocument;

        await userIdentityRepo.create({
            userId: user._id.toString(),
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            email: identity.email,
            emailVerified: identity.emailVerified,
            isPrivateRelay: identity.isPrivateRelay,
        });

        return user;
    }

    async function verifyProviderIdentity(input: {
        provider: unknown;
        idToken: unknown;
        rawNonce?: unknown;
    }): Promise<VerifiedIdentityProfile> {
        const provider = normalizeProvider(input.provider);
        const idToken = normalizeIdToken(input.idToken);
        const rawNonce = normalizeOptionalString(input.rawNonce);

        if (provider === 'google') {
            return providerIdentityService.verifyGoogleIdToken(idToken, rawNonce);
        }

        return providerIdentityService.verifyAppleIdToken(idToken, rawNonce);
    }

    async function providerSignIn(input: {
        provider: unknown;
        idToken: unknown;
        rawNonce?: unknown;
        platform?: unknown;
        authorizationCode?: unknown;
    }): Promise<AuthSessionResult & { refreshToken: string }> {
        const identity = await verifyProviderIdentity(input);
        const user = await resolveUserForVerifiedIdentity(identity);

        // Capture the Apple refresh token (if the client sent an authorization
        // code) so it can be revoked on account deletion. Best-effort no-op
        // otherwise.
        await captureAppleRefreshToken(
            identity.provider,
            identity.providerUserId,
            normalizeOptionalString(input.authorizationCode),
            identity.audience
        );

        return issueSessionForUser(user);
    }

    async function getSecurityStatus(userId: string): Promise<AuthSecurityStatus> {
        await loadUser(userId);
        const hasPasskey = await passkeyCredentialRepo.existsForUser(userId);

        return {
            hasPasskey,
        };
    }

    function assertRecentSignIn(user: AuthUserDocument, tokenIssuedAt?: number): void {
        const lastLoginMs = user.lastLogin ? user.lastLogin.getTime() : 0;
        const tokenIssuedMs = typeof tokenIssuedAt === 'number' ? tokenIssuedAt * 1000 : 0;
        const tokenFromCurrentSession = tokenIssuedMs + TOKEN_CLOCK_SKEW_MS >= lastLoginMs;
        const signInIsRecent = Date.now() - lastLoginMs <= RECENT_SIGN_IN_WINDOW_MS;

        if (!tokenFromCurrentSession || !signInIsRecent) {
            throw new AppError(ErrorCode.FORBIDDEN, 'For your security, please sign in again before changing your passkeys.', 403);
        }
    }

    async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
        await loadUser(userId);
        const passkeys = await passkeyCredentialRepo.listForUser(userId);
        return passkeys.map((passkey) => ({
            id: passkey._id ? passkey._id.toString() : '',
            deviceType: passkey.deviceType || 'unknown',
            backedUp: passkey.backedUp ?? false,
            createdAt: passkey.createdAt ? passkey.createdAt.getTime() : null,
            lastUsedAt: passkey.lastUsedAt ? passkey.lastUsedAt.getTime() : null,
        }));
    }

    async function deletePasskey(userId: string, passkeyId: unknown, tokenIssuedAt?: number): Promise<AuthSecurityStatus> {
        if (typeof passkeyId !== 'string' || !mongoose.Types.ObjectId.isValid(passkeyId)) {
            throw new ValidationError("That passkey isn't valid.");
        }

        const user = await loadUser(userId);
        assertRecentSignIn(user, tokenIssuedAt);

        const deleted = await passkeyCredentialRepo.deleteForUser(userId, passkeyId);
        if (!deleted) {
            throw new NotFoundError('Passkey not found');
        }

        return getSecurityStatus(userId);
    }

    async function beginPasskeyRegistration(userId: string, tokenIssuedAt?: number): Promise<PasskeyOptionsResult> {
        const user = await loadUser(userId);
        assertRecentSignIn(user, tokenIssuedAt);
        const existingPasskeys = await passkeyCredentialRepo.listForUser(userId);

        const username = user.username?.trim() || `user-${user._id.toString()}`;

        const options = await passkeyService.generateRegistrationOptions({
            userId: user._id.toString(),
            username,
            displayName: user.username?.trim() || 'Bleya user',
            existingCredentials: existingPasskeys.map((credential) => ({
                credentialId: credential.credentialId,
                transports: credential.transports,
            })),
        });

        const challengeDoc = await authChallengeRepo.create({
            ceremony: 'passkey-registration',
            challenge: options.challenge,
            userId: user._id.toString(),
        });

        return {
            challengeId: challengeDoc._id.toString(),
            options: options as unknown as Record<string, unknown>,
        };
    }

    async function finishPasskeyRegistration(userId: string, challengeId: unknown, response: unknown): Promise<AuthSecurityStatus> {
        const normalizedChallengeId = validateChallengeId(challengeId);
        const credentialResponse = validateRegistrationResponse(response);
        const challengeDoc = await authChallengeRepo.findById(normalizedChallengeId);

        if (!challengeDoc || challengeDoc.ceremony !== 'passkey-registration' || challengeDoc.userId?.toString() !== userId) {
            throw new ValidationError('That passkey request is no longer valid. Try again.');
        }

        const verification = await passkeyService.verifyRegistration({
            expectedChallenge: challengeDoc.challenge,
            response: credentialResponse,
        });

        await passkeyCredentialRepo.create({
            userId,
            credentialId: verification.credentialId,
            publicKey: verification.publicKey,
            counter: verification.counter,
            transports: verification.transports,
            deviceType: verification.deviceType,
            backedUp: verification.backedUp,
            aaguid: verification.aaguid,
        });

        await authChallengeRepo.deleteById(normalizedChallengeId);
        return getSecurityStatus(userId);
    }

    async function beginPasskeyAuthentication(): Promise<PasskeyOptionsResult> {
        const options = await passkeyService.generateAuthenticationOptions();
        const challengeDoc = await authChallengeRepo.create({
            ceremony: 'passkey-authentication',
            challenge: options.challenge,
        });

        return {
            challengeId: challengeDoc._id.toString(),
            options: options as unknown as Record<string, unknown>,
        };
    }

    async function finishPasskeyAuthentication(challengeId: unknown, response: unknown): Promise<AuthSessionResult & { refreshToken: string }> {
        const normalizedChallengeId = validateChallengeId(challengeId);
        const credentialResponse = validateAuthenticationResponse(response);
        const challengeDoc = await authChallengeRepo.findById(normalizedChallengeId);

        if (!challengeDoc || challengeDoc.ceremony !== 'passkey-authentication') {
            throw new ValidationError('That passkey request is no longer valid. Try again.');
        }

        const rawId = typeof credentialResponse.rawId === 'string' && credentialResponse.rawId.trim().length > 0
            ? credentialResponse.rawId.trim()
            : typeof credentialResponse.id === 'string'
                ? credentialResponse.id.trim()
                : '';

        if (!rawId) {
            throw new ValidationError('That passkey response could not be processed.');
        }

        const authenticator = await passkeyCredentialRepo.findByCredentialId(rawId);
        if (!authenticator) {
            throw new UnauthorizedError('No passkey found for that device.');
        }

        const verification = await passkeyService.verifyAuthentication({
            expectedChallenge: challengeDoc.challenge,
            response: credentialResponse,
            authenticator: {
                credentialId: authenticator.credentialId,
                publicKey: authenticator.publicKey,
                counter: authenticator.counter,
                transports: authenticator.transports,
            },
        });

        await passkeyCredentialRepo.updateCounterAndLastUsed(verification.credentialId, verification.newCounter);
        await authChallengeRepo.deleteById(normalizedChallengeId);

        const user = await loadUser(authenticator.userId.toString());
        return issueSessionForUser(user);
    }

    // Moderation normally clears the refresh session, but check anyway so no
    // path can renew a banned or suspended session. `sessionTokenHash` is either
    // token of the session, current or previous.
    async function assertSessionMayContinue(user: RefreshSessionUser, sessionTokenHash: string, now: Date): Promise<void> {
        if (describeEnforcementForUser(user, now)) {
            await userRepo.clearRefreshToken(sessionTokenHash, now);
            assertAccountMayStartSession(user);
        }
    }

    // Every refresh replaces the refresh token. The replaced one stays usable
    // until its successor is first used (at most PREVIOUS_REFRESH_TOKEN_TTL_MS),
    // so a response lost on its way to the app doesn't end the session.
    async function refreshAccessToken(presentedRefreshToken: string): Promise<RefreshResult> {
        const hashed = hashRefreshToken(presentedRefreshToken);
        const now = new Date();
        const reuseWindowStart = new Date(now.getTime() - REFRESH_TOKEN_REUSE_WINDOW_MS);
        const nextRefreshToken = generateRefreshToken();
        const next = { hash: hashRefreshToken(nextRefreshToken), expiresAt: getRefreshExpiryDate() };

        // The current token: replace it.
        const rotated = await userRepo.rotateRefreshToken(
            hashed,
            now,
            next,
            new Date(now.getTime() + PREVIOUS_REFRESH_TOKEN_TTL_MS)
        );
        if (rotated) {
            await assertSessionMayContinue(rotated, next.hash, now);
            return { accessToken: signAccessToken({ userId: rotated._id.toString() }), refreshToken: nextRefreshToken };
        }

        // The previous token, with its successor issued over 30 s ago and still
        // unused: the response carrying the successor never arrived. Issue a
        // new one. The previous token stays, so another lost response recovers
        // the same way.
        const reissued = await userRepo.reissueFromPreviousRefreshToken(hashed, now, next, reuseWindowStart);
        if (reissued) {
            await assertSessionMayContinue(reissued, next.hash, now);
            logger.info('auth.refresh.previous_token_reissued', { userId: reissued._id.toString() });
            return { accessToken: signAccessToken({ userId: reissued._id.toString() }), refreshToken: nextRefreshToken };
        }

        // The previous token, with its successor issued in the last 30 s: most
        // likely two refreshes sent at once. It gets only an access token, and
        // the response that issued the successor sets the cookie.
        const reused = await userRepo.findByRecentPreviousRefreshToken(hashed, now, reuseWindowStart);
        if (reused) {
            await assertSessionMayContinue(reused, hashed, now);
            logger.info('auth.refresh.previous_token_reused', { userId: reused._id.toString() });
            return { accessToken: signAccessToken({ userId: reused._id.toString() }) };
        }

        // A session ended by a ban or suspension: say why (403) rather
        // than a bare 401, so the app can show the reason.
        const revoked = await userRepo.findEnforcementByRevokedRefreshToken(hashed);
        if (revoked) {
            assertAccountMayStartSession(revoked);
        }
        throw new UnauthorizedError('Invalid or expired refresh token');
    }

    // Ends the session of a current or unexpired previous refresh token.
    // Returns the id of the user whose session ended, so callers can also drop
    // that user's live sockets.
    async function logout(refreshToken: string): Promise<string | null> {
        const hashed = hashRefreshToken(refreshToken);
        return userRepo.clearRefreshToken(hashed, new Date());
    }

    async function checkUsernameAvailability(username: unknown): Promise<boolean> {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError('How should we call you?');
        }

        const normalizedUsername = normalizeUsernameInput(username);
        if (!isValidUsername(normalizedUsername) || containsBlockedTerm(normalizedUsername)) {
            return false;
        }

        const existingUser = await userRepo.findByUsernameLean(normalizedUsername);
        return !existingUser;
    }

    async function setUsername(userId: string, username: unknown): Promise<UserProfileResponse> {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError('How should we call you?');
        }

        const normalizedUsername = normalizeUsernameInput(username);
        if (!isValidUsername(normalizedUsername)) {
            throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
        }

        assertCleanText(normalizedUsername, 'username');

        const user = await loadUser(userId);

        if (user.username && user.username.trim().length > 0) {
            throw new ValidationError("You've already set your username and can't change it.");
        }

        const existingUser = await userRepo.findByUsernameLean(normalizedUsername);
        if (existingUser) {
            throw new ValidationError("That username's taken. Try another one?");
        }

        user.username = normalizedUsername;
        user.updatedAt = new Date();
        await user.save();

        return toUserProfileResponse(user);
    }

    return {
        providerSignIn,
        getSecurityStatus,
        listPasskeys,
        deletePasskey,
        beginPasskeyRegistration,
        finishPasskeyRegistration,
        beginPasskeyAuthentication,
        finishPasskeyAuthentication,
        refreshAccessToken,
        logout,
        checkUsernameAvailability,
        setUsername,
    };
}

const defaultAuthService = createAuthService({
    userRepo: defaultUserRepo,
    userIdentityRepo: defaultUserIdentityRepo,
    passkeyCredentialRepo: defaultPasskeyCredentialRepo,
    authChallengeRepo: defaultAuthChallengeRepo,
    providerIdentityService: defaultProviderIdentityService,
    passkeyService: defaultPasskeyService,
    isIdentityBanned,
});

export const providerSignIn = defaultAuthService.providerSignIn;
export const getSecurityStatus = defaultAuthService.getSecurityStatus;
export const listPasskeys = defaultAuthService.listPasskeys;
export const deletePasskey = defaultAuthService.deletePasskey;
export const beginPasskeyRegistration = defaultAuthService.beginPasskeyRegistration;
export const finishPasskeyRegistration = defaultAuthService.finishPasskeyRegistration;
export const beginPasskeyAuthentication = defaultAuthService.beginPasskeyAuthentication;
export const finishPasskeyAuthentication = defaultAuthService.finishPasskeyAuthentication;
export const refreshAccessToken = defaultAuthService.refreshAccessToken;
export const logout = defaultAuthService.logout;
export const checkUsernameAvailability = defaultAuthService.checkUsernameAvailability;
export const setUsername = defaultAuthService.setUsername;
