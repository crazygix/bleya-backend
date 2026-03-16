import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
    signAccessToken,
    hashRefreshToken,
    getRefreshExpiryDate,
} from '../../services/authService.js';
import { config } from '../../config/index.js';

test('signAccessToken returns a valid JWT decodable with the secret', () => {
    const token = signAccessToken({ userId: 'abc123' });
    const decoded = jwt.verify(token, config.jwtSecret) as { userId: string };
    assert.equal(decoded.userId, 'abc123');
});

test('signAccessToken uses HS256 algorithm', () => {
    const token = signAccessToken({ userId: 'x' });
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256');
});

test('hashRefreshToken is deterministic', () => {
    const hash1 = hashRefreshToken('my-token');
    const hash2 = hashRefreshToken('my-token');
    assert.equal(hash1, hash2);
});

test('hashRefreshToken produces different hashes for different inputs', () => {
    const hash1 = hashRefreshToken('token-a');
    const hash2 = hashRefreshToken('token-b');
    assert.notEqual(hash1, hash2);
});

test('getRefreshExpiryDate returns a future date', () => {
    const expiry = getRefreshExpiryDate();
    assert.ok(expiry.getTime() > Date.now());
});

test('getRefreshExpiryDate offset matches configured TTL days', () => {
    const before = Date.now();
    const expiry = getRefreshExpiryDate();
    const expectedMs = config.refreshTokenTtlDays * 24 * 60 * 60 * 1000;
    const diff = expiry.getTime() - before;
    assert.ok(diff >= expectedMs - 1000);
    assert.ok(diff <= expectedMs + 1000);
});
