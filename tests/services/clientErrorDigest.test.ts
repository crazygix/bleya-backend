import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClientErrorDigest, normalizeRoute } from '../../utils/clientErrorDigest.js';

function setup(enabled = true) {
    let clock = Date.UTC(2026, 9, 11, 11, 0, 0);
    const sent: string[] = [];
    const digest = createClientErrorDigest({
        enabled: () => enabled,
        send: async (html) => {
            sent.push(html);
            return true;
        },
        now: () => clock,
        environment: 'production',
        commit: 'abc123',
    });
    return { digest, sent, advance: (ms: number) => { clock += ms; } };
}

const expired = {
    method: 'GET',
    path: '/v1/rooms/0123456789abcdef01234567/messages',
    routeMatched: true,
    statusCode: 401,
    code: 'UNAUTHORIZED',
    message: 'Invalid or expired token',
    requestId: 'req-1',
    userAgent: 'Dart/3.5 (dart:io)',
};

describe('clientErrorDigest', () => {
    it('replaces ids and numbers in routes', () => {
        assert.equal(normalizeRoute('/v1/rooms/0123456789abcdef01234567/messages?x=1'), '/v1/rooms/:id/messages');
        assert.equal(normalizeRoute('/v1/cities/42'), '/v1/cities/:n');
    });

    it('groups by route, status and code, most frequent first', () => {
        const { digest, advance } = setup();
        digest.record(expired);
        digest.record({ ...expired, path: '/v1/rooms/abcdefabcdefabcdefabcdef/messages', userAgent: 'okhttp/4' });
        digest.record({ ...expired, statusCode: 429, code: 'TOO_MANY_REQUESTS', message: 'Slow down', requestId: 'req-9' });
        digest.record({ method: 'GET', path: '/wp-login.php', routeMatched: false, statusCode: 404, code: 'NOT_FOUND' });
        digest.record({ ...expired, statusCode: 500 });
        advance(60 * 60 * 1000);

        assert.equal(digest.format(), [
            'Bleya client errors (4xx) digest',
            'from: 2026-10-11T11:00:00.000Z',
            'to: 2026-10-11T12:00:00.000Z',
            'env: production',
            'commit: abc123',
            'total: 4',
            '',
            '2× 401 UNAUTHORIZED GET /v1/rooms/:id/messages',
            '  message: Invalid or expired token',
            '  e.g. requestId req-1',
            '  clients: Dart/3.5 (dart:io) (1), okhttp/4 (1)',
            '1× 429 TOO_MANY_REQUESTS GET /v1/rooms/:id/messages',
            '  message: Slow down',
            '  e.g. requestId req-9',
            '  clients: Dart/3.5 (dart:io) (1)',
            '1× 404 NOT_FOUND * (no matching route)',
            '  e.g. GET /wp-login.php',
            '  e.g. requestId -',
            '  clients: unknown (1)',
        ].join('\n'));
    });

    it('sends the digest once per window and nothing when there were no errors', async () => {
        const { digest, sent, advance } = setup();
        digest.record(expired);
        advance(60 * 60 * 1000);
        await digest.flush();
        assert.equal(sent.length, 1);
        assert.match(sent[0], /^⚠️ <b>Client errors<\/b>, last 60 min · production\n<pre>Bleya client errors/);

        advance(60 * 60 * 1000);
        await digest.flush();
        assert.equal(sent.length, 1);
    });

    it('records nothing while disabled', () => {
        const { digest } = setup(false);
        digest.record(expired);
        assert.equal(digest.format(), null);
    });
});
