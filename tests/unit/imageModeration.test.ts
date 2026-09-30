import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../config/index.js';
import { isImageModerationConfigured, moderateImage } from '../../services/imageModerationService.js';

const IMAGE = Buffer.from([0x52, 0x49, 0x46, 0x46]);

function sightengineReply(nudity: Record<string, number>, status = 200): Response {
    return new Response(
        JSON.stringify({ status: 'success', request: { id: 'req_1' }, nudity: { none: 0.01, ...nudity } }),
        { status, headers: { 'Content-Type': 'application/json' } }
    );
}

describe('moderateImage', () => {
    const originalSettings = { ...config.contentFilter.imageModeration };
    const originalFetch = globalThis.fetch;
    let requests: { url: string; form: FormData }[];

    beforeEach(() => {
        requests = [];
        Object.assign(config.contentFilter.imageModeration, {
            provider: 'sightengine',
            apiKey: 'api-user',
            apiSecret: 'api-secret',
        });
    });

    afterEach(() => {
        Object.assign(config.contentFilter.imageModeration, originalSettings);
        globalThis.fetch = originalFetch;
    });

    function answerWith(reply: () => Response | Promise<Response>): void {
        globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(url), form: init?.body as FormData });
            return reply();
        }) as typeof fetch;
    }

    it('allows everything without calling out when not configured', async () => {
        config.contentFilter.imageModeration.provider = '';
        answerWith(() => sightengineReply({ erotica: 0.99 }));

        assert.equal(isImageModerationConfigured(), false);
        assert.deepEqual(await moderateImage(IMAGE, 'image/webp'), { allowed: true });
        assert.equal(requests.length, 0);
    });

    it('needs both Sightengine credentials', () => {
        config.contentFilter.imageModeration.apiSecret = '';

        assert.equal(isImageModerationConfigured(), false);
    });

    it('sends the image with the nudity model and credentials', async () => {
        answerWith(() => sightengineReply({ sexual_activity: 0.01, sexual_display: 0.01, erotica: 0.01 }));

        const result = await moderateImage(IMAGE, 'image/webp');

        assert.deepEqual(result, { allowed: true });
        assert.equal(requests[0].url, 'https://api.sightengine.com/1.0/check.json');
        assert.equal(requests[0].form.get('models'), 'nudity-2.1');
        assert.equal(requests[0].form.get('api_user'), 'api-user');
        assert.equal(requests[0].form.get('api_secret'), 'api-secret');
        assert.ok(requests[0].form.get('media') instanceof Blob);
    });

    it('rejects explicit images with a message for the user', async () => {
        answerWith(() => sightengineReply({ erotica: 0.87 }));

        const result = await moderateImage(IMAGE, 'image/webp');

        assert.equal(result.allowed, false);
        assert.match(result.reason ?? '', /choose a different one/);
    });

    it('allows merely suggestive images', async () => {
        answerWith(() => sightengineReply({ very_suggestive: 0.9, suggestive: 0.9, erotica: 0.2 }));

        assert.deepEqual(await moderateImage(IMAGE, 'image/webp'), { allowed: true });
    });

    it('fails open when the provider errors or is unreachable', async () => {
        answerWith(() => new Response(
            JSON.stringify({ status: 'failure', error: { message: 'usage limit reached' } }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
        ));
        assert.deepEqual(await moderateImage(IMAGE, 'image/webp'), { allowed: true });

        answerWith(() => {
            throw new TypeError('fetch failed');
        });
        assert.deepEqual(await moderateImage(IMAGE, 'image/webp'), { allowed: true });
    });
});
