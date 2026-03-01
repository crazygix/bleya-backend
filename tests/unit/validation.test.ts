import test from 'node:test';
import assert from 'node:assert/strict';
import { validateObjectId, isValidObjectId } from '../../utils/validation.js';

test('isValidObjectId accepts a valid 24-char hex string', () => {
    assert.ok(isValidObjectId('507f1f77bcf86cd799439011'));
});

test('isValidObjectId rejects short strings', () => {
    assert.equal(isValidObjectId('507f1f77bcf86cd79943901'), false);
});

test('isValidObjectId rejects non-hex characters', () => {
    assert.equal(isValidObjectId('507f1f77bcf86cd79943901z'), false);
});

test('isValidObjectId rejects empty string', () => {
    assert.equal(isValidObjectId(''), false);
});

test('validateObjectId returns an ObjectId for valid input', () => {
    const oid = validateObjectId('507f1f77bcf86cd799439011', 'test');
    assert.equal(oid.toString(), '507f1f77bcf86cd799439011');
});

test('validateObjectId throws ValidationError for invalid input', () => {
    assert.throws(
        () => validateObjectId('not-valid', 'user ID'),
        (err: Error) => err.message.includes('Invalid user ID format')
    );
});
