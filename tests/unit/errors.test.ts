import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AppError,
    ValidationError,
    UnauthorizedError,
    NotFoundError,
    TooManyRequestsError,
    ErrorCode,
} from '../../utils/errors.js';

test('ValidationError has status 400 and VALIDATION_ERROR code', () => {
    const err = new ValidationError('bad input');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, ErrorCode.VALIDATION_ERROR);
    assert.equal(err.message, 'bad input');
    assert.ok(err instanceof AppError);
});

test('UnauthorizedError has status 401 and UNAUTHORIZED code', () => {
    const err = new UnauthorizedError();
    assert.equal(err.statusCode, 401);
    assert.equal(err.code, ErrorCode.UNAUTHORIZED);
});

test('UnauthorizedError accepts custom message', () => {
    const err = new UnauthorizedError('custom msg');
    assert.equal(err.message, 'custom msg');
});

test('NotFoundError has status 404 and default NOT_FOUND code', () => {
    const err = new NotFoundError();
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, ErrorCode.NOT_FOUND);
});

test('NotFoundError accepts custom code', () => {
    const err = new NotFoundError('gone', ErrorCode.USER_NOT_FOUND);
    assert.equal(err.code, ErrorCode.USER_NOT_FOUND);
    assert.equal(err.message, 'gone');
});

test('TooManyRequestsError has status 429', () => {
    const err = new TooManyRequestsError();
    assert.equal(err.statusCode, 429);
    assert.equal(err.code, ErrorCode.TOO_MANY_REQUESTS);
});

test('AppError includes details when provided', () => {
    const err = new AppError(ErrorCode.INTERNAL_ERROR, 'oops', 500, { extra: true });
    assert.deepEqual(err.details, { extra: true });
});

test('AppError isOperational defaults to true', () => {
    const err = new AppError(ErrorCode.INTERNAL_ERROR, 'oops');
    assert.equal(err.isOperational, true);
});
