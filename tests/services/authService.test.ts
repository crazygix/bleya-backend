import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createAuthService } from '../../services/authService.js';
import type { UserRepository } from '../../repositories/userRepository.js';

function makeFakeUser(overrides: Record<string, unknown> = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        phoneNumber: '+12345678901',
        username: '',
        code: undefined as string | undefined,
        codeExpiresAt: undefined as Date | undefined,
        codeSentAt: undefined as Date | undefined,
        refreshTokenHash: undefined as string | undefined,
        refreshTokenExpiresAt: undefined as Date | undefined,
        lastLogin: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        bio: '',
        profileImageUrl: '',
        save: async () => {},
        ...overrides,
    };
}

function fakeUserRepo(overrides: Partial<UserRepository> = {}): UserRepository {
    return {
        findById: async () => null,
        findByIdLean: async () => null,
        findByIdSelectJoinedRooms: async () => null,
        findByIdSelectUsername: async () => null,
        findByPhone: async () => null,
        findByUsernameLean: async () => null,
        findOneAndUpdateByPhone: async () => null,
        findOneAndUpdateByRefreshToken: async () => null,
        clearRefreshToken: async () => {},
        addToJoinedRooms: async () => ({ modifiedCount: 0 }),
        removeFromJoinedRooms: async () => {},
        existsWithRoom: async () => false,
        findByIds: async () => [],
        ...overrides,
    };
}

describe('authService (mocked)', () => {
    describe('verifyCode', () => {
        it('returns tokens on valid code', async () => {
            const futureDate = new Date();
            futureDate.setMinutes(futureDate.getMinutes() + 10);

            const user = makeFakeUser({
                code: '123456',
                codeExpiresAt: futureDate,
            });

            const repo = fakeUserRepo({
                findByPhone: async () => user as any,
            });

            const svc = createAuthService({ userRepo: repo });
            const result = await svc.verifyCode('+12345678901', '123456');

            assert.ok(result.accessToken);
            assert.ok(result.refreshToken);
            assert.equal(typeof result.requiresUsername, 'boolean');
        });

        it('throws on wrong code', async () => {
            const futureDate = new Date();
            futureDate.setMinutes(futureDate.getMinutes() + 10);

            const user = makeFakeUser({
                code: '123456',
                codeExpiresAt: futureDate,
            });

            const repo = fakeUserRepo({
                findByPhone: async () => user as any,
            });

            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.verifyCode('+12345678901', '000000'),
                (err: Error) => err.message.includes("doesn't look right")
            );
        });

        it('throws on expired code', async () => {
            const pastDate = new Date();
            pastDate.setMinutes(pastDate.getMinutes() - 1);

            const user = makeFakeUser({
                code: '123456',
                codeExpiresAt: pastDate,
            });

            const repo = fakeUserRepo({
                findByPhone: async () => user as any,
            });

            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.verifyCode('+12345678901', '123456'),
                (err: Error) => err.message.includes('expired')
            );
        });

        it('throws when user not found', async () => {
            const repo = fakeUserRepo({
                findByPhone: async () => null,
            });

            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.verifyCode('+19999999999', '123456'),
                (err: Error) => err.message.includes("doesn't look right")
            );
        });

        it('throws on missing fields', async () => {
            const repo = fakeUserRepo();
            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.verifyCode('+12345678901', undefined),
                (err: Error) => err.message.includes('both your number')
            );
        });
    });

    describe('requestCode', () => {
        it('returns code and codeSentAt on success', async () => {
            const user = makeFakeUser();
            const repo = fakeUserRepo({
                findOneAndUpdateByPhone: async () => user as any,
            });

            const svc = createAuthService({ userRepo: repo });
            const result = await svc.requestCode('+12345678901');

            assert.ok(result.code);
            assert.equal(result.code.length, 6);
            assert.ok(result.codeSentAt instanceof Date);
        });

        it('throws on invalid phone', async () => {
            const repo = fakeUserRepo();
            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.requestCode('abc'),
                (err: Error) => err.message.includes("doesn't look like a valid number")
            );
        });
    });

    describe('refreshAccessToken', () => {
        it('returns new tokens on valid refresh', async () => {
            const userId = new mongoose.Types.ObjectId();
            const repo = fakeUserRepo({
                findOneAndUpdateByRefreshToken: async () => ({ _id: userId }),
            });

            const svc = createAuthService({ userRepo: repo });
            const result = await svc.refreshAccessToken('some-refresh-token');

            assert.ok(result.accessToken);
            assert.ok(result.refreshToken);
        });

        it('throws on invalid/expired refresh token', async () => {
            const repo = fakeUserRepo({
                findOneAndUpdateByRefreshToken: async () => null,
            });

            const svc = createAuthService({ userRepo: repo });

            await assert.rejects(
                () => svc.refreshAccessToken('bad-token'),
                (err: Error) => err.message.includes('Invalid or expired')
            );
        });
    });

    describe('checkUsernameAvailability', () => {
        it('returns true when username is available', async () => {
            const repo = fakeUserRepo({
                findByUsernameLean: async () => null,
            });

            const svc = createAuthService({ userRepo: repo });
            assert.equal(await svc.checkUsernameAvailability('newuser'), true);
        });

        it('returns false when username is taken', async () => {
            const repo = fakeUserRepo({
                findByUsernameLean: async () => ({ _id: new mongoose.Types.ObjectId() }),
            });

            const svc = createAuthService({ userRepo: repo });
            assert.equal(await svc.checkUsernameAvailability('taken'), false);
        });
    });
});
