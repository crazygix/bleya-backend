import supertest from 'supertest';
import { createApp } from '../../server/app.js';
import { resetRateLimiterStoreForTests } from '../../middleware/rateLimiter.js';

let agent: supertest.SuperTest<supertest.Test> | null = null;

export function getTestAgent(): supertest.SuperTest<supertest.Test> {
    if (!agent) {
        const app = createApp();
        agent = supertest(app) as unknown as supertest.SuperTest<supertest.Test>;
    }
    return agent;
}

export function resetTestApp(): void {
    resetRateLimiterStoreForTests();
}
