import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { ValidationError, UnauthorizedError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { sanitizeUsername } from '../utils/sanitize.js';
import { config } from '../config/index.js';
import { type UserProfileResponse, toUserProfileResponse } from './userService.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';
import {
    type UserIdentityRepository,
    userIdentityRepository as defaultUserIdentityRepo,
    type StoredUserIdentity,
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
import type {
    RegistrationResponseJSON,
    AuthenticationResponseJSON,
} from '@simplewebauthn/server';

const ACCESS_TOKEN_TTL = config.accessTokenTtl as jwt.SignOptions['expiresIn'];
const REFRESH_TOKEN_TTL_DAYS = config.refreshTokenTtlDays;

export type AuthProvider = 'google' | 'apple';

export interface AuthSessionResult {
    token: string;
    requiresUsername: boolean;
    hasPasskey: boolean;
}

export interface RefreshResult {
    accessToken: string;
    refreshToken: string;
}

export interface LinkedIdentitySummary {
    provider: AuthProvider;
    email: string;
    emailVerified: boolean;
    isPrivateRelay: boolean;
    linkedAt: number;
    lastUsedAt: number;
}

export interface AuthSecurityStatus {
    hasPasskey: boolean;
    linkedProviders: LinkedIdentitySummary[];
}

export interface PasskeyOptionsResult {
    challengeId: string;
    options: Record<string, unknown>;
}

export interface AuthServiceDeps {
    userRepo: UserRepository;
    userIdentityRepo: UserIdentityRepository;
    passkeyCredentialRepo: PasskeyCredentialRepository;
    authChallengeRepo: AuthChallengeRepository;
    providerIdentityService: ProviderIdentityService;
    passkeyService: PasskeyService;
}

type AuthUserDocument = mongoose.Document & {
    _id: mongoose.Types.ObjectId;
    username?: string;
    bio?: string;
    profileImageUrl?: string;
    createdAt: Date;
    updatedAt: Date;
    lastLogin: Date;
    refreshTokenHash?: string;
    refreshTokenExpiresAt?: Date;
};

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

function dedupeUserIds(identities: StoredUserIdentity[]): string[] {
    return [...new Set(identities.map((identity) => identity.userId.toString()))];
}

function toLinkedIdentitySummary(identity: StoredUserIdentity): LinkedIdentitySummary {
    return {
        provider: identity.provider,
        email: identity.email || '',
        emailVerified: identity.emailVerified || false,
        isPrivateRelay: identity.isPrivateRelay || false,
        linkedAt: identity.linkedAt?.getTime() || 0,
        lastUsedAt: identity.lastUsedAt?.getTime() || 0,
    };
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

    async function issueSessionForUser(user: AuthUserDocument): Promise<AuthSessionResult & { refreshToken: string }> {
        const now = new Date();
        const refreshToken = generateRefreshToken();
        user.refreshTokenHash = hashRefreshToken(refreshToken);
        user.refreshTokenExpiresAt = getRefreshExpiryDate();
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

        let linkedUserId: string | null = null;
        if (identity.emailVerified && identity.email && !identity.isPrivateRelay) {
            const matchingIdentities = await userIdentityRepo.findVerifiedByEmail(identity.email);
            const matchingUserIds = dedupeUserIds(matchingIdentities);

            if (matchingUserIds.length > 1) {
                throw new ValidationError('That email is already linked to multiple accounts. Sign in with an existing method first.');
            }

            if (matchingUserIds.length === 1) {
                linkedUserId = matchingUserIds[0];
            }
        }

        const user = linkedUserId
            ? await loadUser(linkedUserId)
            : (await userRepo.create({}) as AuthUserDocument);

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
    }): Promise<AuthSessionResult & { refreshToken: string }> {
        const identity = await verifyProviderIdentity(input);
        const user = await resolveUserForVerifiedIdentity(identity);
        return issueSessionForUser(user);
    }

    async function linkIdentity(userId: string, input: {
        provider: unknown;
        idToken: unknown;
        rawNonce?: unknown;
    }): Promise<AuthSecurityStatus> {
        const identity = await verifyProviderIdentity(input);
        const existingIdentity = await userIdentityRepo.findByProviderIdentity(identity.provider, identity.providerUserId);
        if (existingIdentity) {
            if (existingIdentity.userId.toString() !== userId) {
                throw new ValidationError('That sign-in method is already linked to another account.');
            }

            await userIdentityRepo.updateLastUsed(existingIdentity._id!.toString());
            return getSecurityStatus(userId);
        }

        const currentIdentities = await userIdentityRepo.findByUserId(userId);
        if (currentIdentities.some((item) => item.provider === identity.provider)) {
            throw new ValidationError('That sign-in method is already linked to this account.');
        }

        await loadUser(userId);
        await userIdentityRepo.create({
            userId,
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            email: identity.email,
            emailVerified: identity.emailVerified,
            isPrivateRelay: identity.isPrivateRelay,
        });

        return getSecurityStatus(userId);
    }

    async function getSecurityStatus(userId: string): Promise<AuthSecurityStatus> {
        await loadUser(userId);
        const [linkedProviders, hasPasskey] = await Promise.all([
            userIdentityRepo.findByUserId(userId),
            passkeyCredentialRepo.existsForUser(userId),
        ]);

        return {
            hasPasskey,
            linkedProviders: linkedProviders.map(toLinkedIdentitySummary),
        };
    }

    async function beginPasskeyRegistration(userId: string): Promise<PasskeyOptionsResult> {
        const user = await loadUser(userId);
        const identities = await userIdentityRepo.findByUserId(userId);
        const existingPasskeys = await passkeyCredentialRepo.listForUser(userId);

        const primaryIdentity = identities.find((identity) => identity.email) || identities[0];
        const username = user.username?.trim()
            || primaryIdentity?.email
            || `user-${user._id.toString()}`;

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

    async function refreshAccessToken(currentRefreshToken: string): Promise<RefreshResult> {
        const hashed = hashRefreshToken(currentRefreshToken);
        const now = new Date();
        const newRefresh = generateRefreshToken();
        const newRefreshHash = hashRefreshToken(newRefresh);
        const newExpiry = getRefreshExpiryDate();

        const user = await userRepo.findOneAndUpdateByRefreshToken(
            hashed,
            now,
            { $set: { refreshTokenHash: newRefreshHash, refreshTokenExpiresAt: newExpiry } }
        );

        if (!user) {
            throw new UnauthorizedError('Invalid or expired refresh token');
        }

        const accessToken = signAccessToken({ userId: user._id.toString() });
        return { accessToken, refreshToken: newRefresh };
    }

    async function logout(refreshToken: string): Promise<void> {
        const hashed = hashRefreshToken(refreshToken);
        await userRepo.clearRefreshToken(hashed);
    }

    async function checkUsernameAvailability(username: unknown): Promise<boolean> {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError('How should we call you?');
        }

        const normalizedUsername = sanitizeUsername(username);
        if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
            return false;
        }

        const existingUser = await userRepo.findByUsernameLean(normalizedUsername);
        return !existingUser;
    }

    async function setUsername(userId: string, username: unknown): Promise<UserProfileResponse> {
        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new ValidationError('How should we call you?');
        }

        const normalizedUsername = sanitizeUsername(username);
        if (!/^[a-z0-9_]{3,30}$/.test(normalizedUsername)) {
            throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
        }

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
        linkIdentity,
        getSecurityStatus,
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
});

export const providerSignIn = defaultAuthService.providerSignIn;
export const linkIdentity = defaultAuthService.linkIdentity;
export const getSecurityStatus = defaultAuthService.getSecurityStatus;
export const beginPasskeyRegistration = defaultAuthService.beginPasskeyRegistration;
export const finishPasskeyRegistration = defaultAuthService.finishPasskeyRegistration;
export const beginPasskeyAuthentication = defaultAuthService.beginPasskeyAuthentication;
export const finishPasskeyAuthentication = defaultAuthService.finishPasskeyAuthentication;
export const refreshAccessToken = defaultAuthService.refreshAccessToken;
export const logout = defaultAuthService.logout;
export const checkUsernameAvailability = defaultAuthService.checkUsernameAvailability;
export const setUsername = defaultAuthService.setUsername;
