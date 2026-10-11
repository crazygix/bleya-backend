import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorReporter, errorFingerprint, formatErrorReport } from '../../utils/errorReporter.js';

function setup(options: { enabled?: boolean; sendResult?: boolean } = {}) {
    let clock = 1_000_000;
    const sent: string[] = [];
    const reporter = createErrorReporter({
        enabled: () => options.enabled ?? true,
        send: async (text) => {
            sent.push(text);
            return options.sendResult ?? true;
        },
        now: () => clock,
        environment: 'production',
    });
    return {
        reporter,
        sent,
        advance: (ms: number) => {
            clock += ms;
        },
    };
}

function requestError(message: string, path = '/v1/rooms/0123456789abcdef01234567') {
    return {
        method: 'GET',
        path,
        requestId: 'req-1',
        error: { name: 'TypeError', message, stack: `TypeError: ${message}\n    at handler (dist/routes/rooms.js:10:5)\n    at next (x.js:1:1)` },
    };
}

describe('errorReporter', () => {
    it('formats the event, request, error, top stack frames and other fields', () => {
        const text = formatErrorReport('request.error', { ...requestError('boom'), userId: 'u1' }, 'production');
        assert.equal(text, [
            '🔥 request.error · production',
            'GET /v1/rooms/0123456789abcdef01234567',
            'TypeError: boom',
            'at handler (dist/routes/rooms.js:10:5)',
            'at next (x.js:1:1)',
            '',
            'requestId: req-1',
            'userId: u1',
        ].join('\n'));
    });

    it('groups occurrences that differ only in ids and numbers', () => {
        assert.equal(
            errorFingerprint('request.error', requestError('Room 0123456789abcdef01234567 has 3 items')),
            errorFingerprint('request.error', requestError('Room abcdefabcdefabcdefabcdef has 12 items', '/v1/rooms/abcdefabcdefabcdefabcdef')),
        );
        assert.notEqual(
            errorFingerprint('request.error', requestError('boom')),
            errorFingerprint('socket.send_message.failed', requestError('boom')),
        );
    });

    it('sends a repeating error once, then a summary of the repeats', () => {
        const { reporter, sent, advance } = setup();
        reporter.report('request.error', requestError('boom'));
        reporter.report('request.error', requestError('boom'));
        reporter.report('request.error', requestError('boom'));
        assert.equal(sent.length, 1);

        reporter.flushRepeats();
        assert.equal(sent.length, 1, 'no summary before the window ends');

        advance(10 * 60 * 1000);
        reporter.flushRepeats();
        assert.equal(sent.length, 2);
        assert.match(sent[1], /^🔁 request\.error: TypeError: boom\nhappened 2 more time\(s\) in the last 10 min/);

        advance(10 * 60 * 1000);
        reporter.flushRepeats();
        assert.equal(sent.length, 2, 'nothing new to summarize');

        reporter.report('request.error', requestError('boom'));
        assert.equal(sent.length, 3, 'sent in full again once it was forgotten');
    });

    it('caps messages per minute and mentions the dropped ones', () => {
        const { reporter, sent, advance } = setup();
        for (let i = 0; i < 20; i += 1) {
            reporter.report(`event.${i}`, { error: 'x' });
        }
        assert.equal(sent.length, 15);

        advance(60 * 1000);
        reporter.report('event.late', { error: 'x' });
        assert.equal(sent.length, 16);
        assert.match(sent[15], /5 earlier error alert\(s\) not sent: rate limit/);
    });

    it('does nothing while disabled', () => {
        const { reporter, sent } = setup({ enabled: false });
        reporter.report('request.error', requestError('boom'));
        assert.equal(sent.length, 0);
    });

    it('calls the failure handler when a send fails', async () => {
        const { reporter } = setup({ sendResult: false });
        let failures = 0;
        reporter.setSendFailureHandler(() => {
            failures += 1;
        });
        reporter.report('request.error', requestError('boom'));
        await reporter.flush(1000);
        assert.equal(failures, 1);
    });
});
