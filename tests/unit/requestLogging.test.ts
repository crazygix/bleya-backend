import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bodyParser from 'body-parser';
import supertest from 'supertest';
import { httpRequestLogger } from '../../middleware/httpRequestLogger.js';
import { toLoggablePath } from '../../utils/requestPath.js';

test('toLoggablePath redacts location and secret query values', () => {
    assert.equal(
        toLoggablePath('/v1/cities/nearby?lat=44.8125&lng=20.4612&limit=5'),
        '/v1/cities/nearby?lat=REDACTED&lng=REDACTED&limit=5'
    );
    assert.equal(
        toLoggablePath('/v1/auth/apple/android/callback?code=abc&id_token=xyz'),
        '/v1/auth/apple/android/callback?code=REDACTED&id_token=REDACTED'
    );
    assert.equal(toLoggablePath('/v1/rooms/joined'), '/v1/rooms/joined');
});

test('a deeply nested JSON body is logged without crashing the process', async () => {
    const app = express();
    app.use(bodyParser.json({ limit: '100kb' }));
    app.use(httpRequestLogger);
    app.use((_req, res) => {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'nope' } });
    });

    // ~10 KB of nesting, far deeper than the call stack allows for naive recursion.
    const depth = 5000;
    const body = `${'['.repeat(depth)}${']'.repeat(depth)}`;

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);

    try {
        await supertest(app)
            .post('/v1/anything')
            .set('Content-Type', 'application/json')
            .send(body)
            .expect(404);

        // Give the 'finish' listener a tick to run.
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(uncaught, []);
    } finally {
        process.off('uncaughtException', onUncaught);
    }
});
