import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidUsername, normalizeUsernameInput } from '../../utils/username.js';

test('normalizeUsernameInput trims surrounding whitespace only', () => {
    assert.equal(normalizeUsernameInput(' alice '), 'alice');
});

test('isValidUsername accepts lowercase usernames', () => {
    assert.equal(isValidUsername('alice_123'), true);
});

test('isValidUsername rejects uppercase usernames', () => {
    assert.equal(isValidUsername('Alice'), false);
});
