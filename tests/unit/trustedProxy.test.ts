import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { getClientIp, isTrustedProxyAddress, trustProxy } from '../../utils/trustedProxy.js';

test('Cloudflare addresses are trusted proxies, others are not', () => {
    assert.equal(isTrustedProxyAddress('104.16.0.1'), true);
    assert.equal(isTrustedProxyAddress('172.67.212.142'), true);
    assert.equal(isTrustedProxyAddress('::ffff:104.21.85.245'), true);
    assert.equal(isTrustedProxyAddress('2606:4700::1'), true);
    assert.equal(isTrustedProxyAddress('203.0.113.7'), false);
    assert.equal(isTrustedProxyAddress('not-an-ip'), false);
});

test('trustProxy trusts the direct peer and Cloudflare hops only', () => {
    assert.equal(trustProxy('10.0.0.1', 0), true);
    assert.equal(trustProxy('104.16.0.1', 1), true);
    assert.equal(trustProxy('203.0.113.7', 1), false);
});

function buildApp() {
    const app = express();
    app.set('trust proxy', trustProxy);
    app.get('/ip', (req, res) => {
        res.json({ ip: req.ip, clientIp: getClientIp(req) });
    });
    return app;
}

test('req.ip is the real client behind Cloudflare and the platform proxy', async () => {
    const res = await supertest(buildApp())
        .get('/ip')
        .set('X-Forwarded-For', '198.51.100.23, 104.16.0.1')
        .expect(200);
    assert.equal(res.body.ip, '198.51.100.23');
    assert.equal(res.body.clientIp, '198.51.100.23');
});

test('spoofed X-Forwarded-For entries left of the real client are ignored', async () => {
    const res = await supertest(buildApp())
        .get('/ip')
        .set('X-Forwarded-For', '1.2.3.4, 198.51.100.23')
        .expect(200);
    assert.equal(res.body.ip, '198.51.100.23');
});

test('CF-Connecting-IP is used only when the resolved address is Cloudflare', async () => {
    const viaCloudflare = await supertest(buildApp())
        .get('/ip')
        .set('X-Forwarded-For', '104.16.0.1')
        .set('CF-Connecting-IP', '198.51.100.99')
        .expect(200);
    assert.equal(viaCloudflare.body.clientIp, '198.51.100.99');

    const direct = await supertest(buildApp())
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.7')
        .set('CF-Connecting-IP', '198.51.100.99')
        .expect(200);
    assert.equal(direct.body.clientIp, '203.0.113.7');
});
