import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { errorHandler, notFoundHandler } from '../../middleware/errorHandler.js';
import { AppError, ValidationError, ErrorCode } from '../../utils/errors.js';

interface CapturedResponse {
    statusCode?: number;
    body?: { error?: { code?: string; message?: string; details?: unknown } };
    status: (code: number) => CapturedResponse;
    json: (body: unknown) => CapturedResponse;
}

function createMockReq(): any {
    return {
        method: 'GET',
        originalUrl: '/v1/test',
        path: '/v1/test',
        headers: {},
    };
}

function createMockRes(): CapturedResponse {
    const res = {} as CapturedResponse;
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body: unknown) => {
        res.body = body as CapturedResponse['body'];
        return res;
    };
    return res;
}

function run(error: Error): CapturedResponse {
    const res = createMockRes();
    errorHandler(error, createMockReq(), res as any, () => {});
    return res;
}

test('errorHandler relays the authored message for client (4xx) AppErrors', () => {
    const res = run(new ValidationError('Pick one?'));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.VALIDATION_ERROR);
    assert.equal(res.body?.error?.message, 'Pick one?');
});

test('errorHandler never leaks 5xx AppError messages to the client', () => {
    const res = run(
        new AppError(
            ErrorCode.INTERNAL_ERROR,
            'google authentication is not configured on the server.',
            500
        )
    );
    assert.equal(res.statusCode, 500);
    // Code is preserved so the client can still branch on it...
    assert.equal(res.body?.error?.code, ErrorCode.INTERNAL_ERROR);
    // ...but the internal detail must not appear in the response.
    assert.doesNotMatch(res.body?.error?.message ?? '', /configured/i);
});

test('errorHandler returns friendly copy for mongoose CastError without echoing the value', () => {
    const castError = new mongoose.Error.CastError('ObjectId', 'evil-raw-value', 'roomId');
    const res = run(castError);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.INVALID_INPUT);
    assert.doesNotMatch(res.body?.error?.message ?? '', /evil-raw-value/);
});

test('errorHandler maps mongoose ValidationError to friendly copy without technical details', () => {
    const res = run(new mongoose.Error.ValidationError());
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.VALIDATION_ERROR);
    assert.equal(res.body?.error?.details, undefined);
});

test('errorHandler maps Mongo duplicate-key (11000) to a 409 conflict', () => {
    const dupError = new Error('E11000 duplicate key error: index username');
    (dupError as unknown as { code: number }).code = 11000;
    const res = run(dupError);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body?.error?.code, ErrorCode.ALREADY_EXISTS);
    assert.doesNotMatch(res.body?.error?.message ?? '', /E11000|index/);
});

test('errorHandler maps a known Multer limit to friendly copy', () => {
    const multerError = new Error('File too large');
    multerError.name = 'MulterError';
    (multerError as unknown as { code: string }).code = 'LIMIT_FILE_SIZE';
    const res = run(multerError);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.VALIDATION_ERROR);
    assert.match(res.body?.error?.message ?? '', /too large/i);
});

test('errorHandler maps an unknown Multer code to a generic upload message', () => {
    const multerError = new Error('Something odd');
    multerError.name = 'MulterError';
    (multerError as unknown as { code: string }).code = 'LIMIT_SOMETHING_NEW';
    const res = run(multerError);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.VALIDATION_ERROR);
    assert.match(res.body?.error?.message ?? '', /upload/i);
});

test('errorHandler maps a malformed-JSON body-parser error to a friendly 400', () => {
    const parseError = new SyntaxError('Unexpected token } in JSON at position 5');
    (parseError as unknown as { type: string; status: number }).type = 'entity.parse.failed';
    (parseError as unknown as { type: string; status: number }).status = 400;
    const res = run(parseError);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body?.error?.code, ErrorCode.INVALID_INPUT);
    assert.doesNotMatch(res.body?.error?.message ?? '', /Unexpected token|position/);
});

test('errorHandler maps an oversized body-parser payload to a 413', () => {
    const tooLarge = new Error('request entity too large');
    (tooLarge as unknown as { type: string; statusCode: number }).type = 'entity.too.large';
    (tooLarge as unknown as { type: string; statusCode: number }).statusCode = 413;
    const res = run(tooLarge);
    assert.equal(res.statusCode, 413);
    assert.match(res.body?.error?.message ?? '', /too large/i);
});

test('notFoundHandler returns the standard error shape with a 404', () => {
    const res = createMockRes();
    notFoundHandler(createMockReq(), res as any);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body?.error?.code, ErrorCode.NOT_FOUND);
    assert.ok((res.body?.error?.message ?? '').length > 0);
});
