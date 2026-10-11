import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { config } from '../../config/index.js';
import { createRateLimiter } from '../../middleware/rateLimiter.js';

test('onLimited runs for each rejected request, not for the allowed ones', async () => {
    const wasTest = config.isTest;
    // Limiters are switched off in tests; this one is the subject.
    (config as { isTest: boolean }).isTest = false;

    try {
        const limited: string[] = [];
        const app = express();
        app.use(express.json());
        app.post('/sign-in', createRateLimiter({
            name: 'test.sign-in',
            limit: 1,
            onLimited: (req) => limited.push(String(req.body?.provider)),
        }), (_req, res) => {
            res.json({ ok: true });
        });
        app.use((error: { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
            res.status(error.statusCode ?? 500).json({});
        });

        const agent = supertest(app);
        await agent.post('/sign-in').send({ provider: 'google' }).expect(200);
        await agent.post('/sign-in').send({ provider: 'apple' }).expect(429);
        await agent.post('/sign-in').send({ provider: 'google' }).expect(429);

        assert.deepEqual(limited, ['apple', 'google']);
    } finally {
        (config as { isTest: boolean }).isTest = wasTest;
    }
});
