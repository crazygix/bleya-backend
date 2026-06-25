import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createAuthService } from '../../services/authService.js';
import type { UserRepository } from '../../repositories/userRepository.js';
import type { UserIdentityRepository } from '../../repositories/userIdentityRepository.js';
import type { PasskeyCredentialRepository } from '../../repositories/passkeyCredentialRepository.js';
import type { AuthChallengeRepository } from '../../repositories/authChallengeRepository.js';
import type { ProviderIdentityService } from '../../services/providerIdentityService.js';
import type { PasskeyService } from '../../services/passkeyService.js';

function createMockUser(overrides: Record<string, unknown> = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        username: '',
        refreshTokenHash: undefined,
        refreshTokenExpiresAt: undefined,
        lastLogin: new Date(0),
        updatedAt: new Date(0),
        save: async function save() {
            return this;
        },
        ...overrides,
    };
}

function fakeUserRepo(overrides: Partial<UserRepository> = {}): UserRepository {
    return {
        findById: async () => null,
        findByIdLean: async () => null,
        findByIdSelectJoinedRooms: async () => null,
        findByIdSelectUsername: async () => null,
        findEnforcementState: async () => null,
        create: async (data = {}) => createMockUser(data) as any,
        updateLastLogin: async () => {},
        findByUsernameLean: async () => null,
        findOneAndUpdateByRefreshToken: async () => null,
        clearRefreshToken: async () => {},
        addToJoinedRooms: async () => ({ modifiedCount: 0 }),
        removeFromJoinedRooms: async () => {},
        existsWithRoom: async () => false,
        findByIds: async () => [],
        findJoinedUserIds: async () => [],
        ...overrides,
    };
}

function fakeUserIdentityRepo(overrides: Partial<UserIdentityRepository> = {}): UserIdentityRepository {
    return {
        findByProviderIdentity: async () => null,
        create: async (data) => ({
            _id: new mongoose.Types.ObjectId(),
            userId: new mongoose.Types.ObjectId(data.userId),
            provider: data.provider,
            providerUserId: data.providerUserId,
            email: data.email,
            emailVerified: data.emailVerified,
            isPrivateRelay: data.isPrivateRelay,
            linkedAt: new Date(),
            lastUsedAt: new Date(),
        }),
        updateLastUsed: async () => {},
        ...overrides,
    };
}

function fakePasskeyCredentialRepo(overrides: Partial<PasskeyCredentialRepository> = {}): PasskeyCredentialRepository {
    return {
        listForUser: async () => [],
        findByCredentialId: async () => null,
        create: async () => {},
        updateCounterAndLastUsed: async () => {},
        existsForUser: async () => false,
        ...overrides,
    };
}

function fakeAuthChallengeRepo(overrides: Partial<AuthChallengeRepository> = {}): AuthChallengeRepository {
    return {
        create: async ({ ceremony, challenge, userId }) => ({
            _id: new mongoose.Types.ObjectId(),
            ceremony,
            challenge,
            ...(userId ? { userId: new mongoose.Types.ObjectId(userId) } : {}),
            createdAt: new Date(),
        }),
        findById: async () => null,
        deleteById: async () => {},
        ...overrides,
    };
}

function fakeProviderIdentityService(overrides: Partial<ProviderIdentityService> = {}): ProviderIdentityService {
    return {
        verifyGoogleIdToken: async () => ({
            provider: 'google',
            providerUserId: 'google-user-1',
            email: 'alice@example.com',
            emailVerified: true,
            isPrivateRelay: false,
        }),
        verifyAppleIdToken: async () => ({
            provider: 'apple',
            providerUserId: 'apple-user-1',
            email: 'alice@example.com',
            emailVerified: true,
            isPrivateRelay: false,
        }),
        ...overrides,
    };
}

function fakePasskeyService(overrides: Partial<PasskeyService> = {}): PasskeyService {
    return {
        generateRegistrationOptions: async () => ({
            rp: { id: 'bleyachat.com', name: 'Bleya' },
            user: { id: 'dXNlcg==', name: 'alice', displayName: 'alice' },
            challenge: 'challenge-1',
            pubKeyCredParams: [],
        }),
        verifyRegistration: async () => ({
            credentialId: 'credential-1',
            publicKey: 'public-key-1',
            counter: 0,
            transports: ['internal'],
            deviceType: 'singleDevice',
            backedUp: false,
            aaguid: 'aaguid',
        }),
        generateAuthenticationOptions: async () => ({
            challenge: 'challenge-2',
            rpId: 'bleyachat.com',
        }),
        verifyAuthentication: async () => ({
            credentialId: 'credential-1',
            newCounter: 1,
        }),
        ...overrides,
    };
}

describe('authService (mocked)', () => {
    it('creates a new user on first provider sign-in', async () => {
        let createdIdentityCount = 0;
        const createdUsers: any[] = [];
        const user = createMockUser();

        const svc = createAuthService({
            userRepo: fakeUserRepo({
                create: async () => {
                    createdUsers.push(user);
                    return user as any;
                },
            }),
            userIdentityRepo: fakeUserIdentityRepo({
                create: async (data) => {
                    createdIdentityCount += 1;
                    return {
                        _id: new mongoose.Types.ObjectId(),
                        userId: new mongoose.Types.ObjectId(data.userId),
                        provider: data.provider,
                        providerUserId: data.providerUserId,
                    } as any;
                },
            }),
            passkeyCredentialRepo: fakePasskeyCredentialRepo(),
            authChallengeRepo: fakeAuthChallengeRepo(),
            providerIdentityService: fakeProviderIdentityService(),
            passkeyService: fakePasskeyService(),
        });

        const result = await svc.providerSignIn({
            provider: 'google',
            idToken: 'token',
        });

        assert.ok(result.token);
        assert.equal(result.requiresUsername, true);
        assert.equal(result.hasPasskey, false);
        assert.equal(createdUsers.length, 1);
        assert.equal(createdIdentityCount, 1);
    });

    it('creates a separate user when a different provider signs in with the same email', async () => {
        let createdIdentityCount = 0;
        const createdUsers: any[] = [];

        const svc = createAuthService({
            userRepo: fakeUserRepo({
                create: async () => {
                    const user = createMockUser();
                    createdUsers.push(user);
                    return user as any;
                },
            }),
            userIdentityRepo: fakeUserIdentityRepo({
                create: async (data) => {
                    createdIdentityCount += 1;
                    return {
                        _id: new mongoose.Types.ObjectId(),
                        userId: new mongoose.Types.ObjectId(data.userId),
                        provider: data.provider,
                        providerUserId: data.providerUserId,
                        linkedAt: new Date(),
                        lastUsedAt: new Date(),
                    } as any;
                },
            }),
            passkeyCredentialRepo: fakePasskeyCredentialRepo(),
            authChallengeRepo: fakeAuthChallengeRepo(),
            providerIdentityService: fakeProviderIdentityService(),
            passkeyService: fakePasskeyService(),
        });

        await svc.providerSignIn({
            provider: 'google',
            idToken: 'token',
        });
        await svc.providerSignIn({
            provider: 'apple',
            idToken: 'token',
        });

        assert.equal(createdUsers.length, 2);
        assert.equal(createdIdentityCount, 2);
    });

    it('starts and finishes passkey registration', async () => {
        const userId = new mongoose.Types.ObjectId().toString();
        let createdCredential = '';

        const svc = createAuthService({
            userRepo: fakeUserRepo({
                findById: async () => createMockUser({ _id: new mongoose.Types.ObjectId(userId), username: 'alice' }) as any,
            }),
            userIdentityRepo: fakeUserIdentityRepo(),
            passkeyCredentialRepo: fakePasskeyCredentialRepo({
                create: async (data) => {
                    createdCredential = data.credentialId;
                },
                existsForUser: async () => true,
            }),
            authChallengeRepo: fakeAuthChallengeRepo({
                findById: async (id) => ({
                    _id: new mongoose.Types.ObjectId(id),
                    ceremony: 'passkey-registration',
                    challenge: 'challenge-1',
                    userId: new mongoose.Types.ObjectId(userId),
                }),
            }),
            providerIdentityService: fakeProviderIdentityService(),
            passkeyService: fakePasskeyService(),
        });

        const options = await svc.beginPasskeyRegistration(userId);
        assert.equal(typeof options.challengeId, 'string');

        const result = await svc.finishPasskeyRegistration(userId, options.challengeId, {
            id: 'credential-1',
            rawId: 'credential-1',
            type: 'public-key',
            response: {
                clientDataJSON: 'abc',
                attestationObject: 'def',
            },
            clientExtensionResults: {},
        });

        assert.equal(createdCredential, 'credential-1');
        assert.equal(result.hasPasskey, true);
    });
});
