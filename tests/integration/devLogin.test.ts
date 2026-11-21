import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../helpers/testDb.js';
import { getTestAgent, resetTestApp } from '../helpers/testApp.js';
import { stopRateLimiterCleanupForTests } from '../../middleware/rateLimiter.js';
import { config } from '../../config/index.js';
import * as authService from '../../services/authService.js';
import { User } from '../../models/User.js';

describe('dev login', () => {
    before(async () => {
        await connectTestDb();
    });

    after(async () => {
        stopRateLimiterCleanupForTests();
        await disconnectTestDb();
    });

    beforeEach(async () => {
        await clearTestDb();
        resetTestApp();
    });

    afterEach(() => {
        config.devLogin.enabled = false;
    });

    it('has no route when DEV_LOGIN_ENABLED is off', async () => {
        assert.equal(config.devLogin.enabled, false);
        await getTestAgent().post('/v1/auth/dev-login').send({ username: 'tester' }).expect(404);
        assert.equal(await User.countDocuments(), 0);
    });

    it('refuses in the service too while it is off', async () => {
        await assert.rejects(authService.devSignIn({ username: 'tester' }), { statusCode: 404 });
        assert.equal(await User.countDocuments(), 0);
    });

    it('creates the user on first use, then signs in as the same user', async () => {
        config.devLogin.enabled = true;

        const first = await authService.devSignIn({ username: ' screenshot_tester ' });
        assert.equal(first.isNewUser, true);
        assert.equal(first.requiresUsername, false);
        assert.ok(first.token);
        assert.ok(first.refreshToken);

        const user = await User.findById(first.userId).lean();
        assert.equal(user?.username, 'screenshot_tester');

        const second = await authService.devSignIn({ username: 'screenshot_tester' });
        assert.equal(second.isNewUser, false);
        assert.equal(second.userId, first.userId);
        assert.equal(await User.countDocuments(), 1);
    });

    it('rejects usernames the app would not accept', async () => {
        config.devLogin.enabled = true;

        for (const username of ['ab', 'has space', 'x'.repeat(31), '', undefined, 42]) {
            await assert.rejects(authService.devSignIn({ username }), { statusCode: 400 }, String(username));
        }
        assert.equal(await User.countDocuments(), 0);
    });

    it('keeps banned accounts out', async () => {
        config.devLogin.enabled = true;
        await User.create({ username: 'banned_one', status: 'banned' });

        await assert.rejects(authService.devSignIn({ username: 'banned_one' }), { statusCode: 403 });
    });
});
