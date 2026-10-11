import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStack, createErrorReporter, errorFingerprint, formatErrorReport } from '../../utils/errorReporter.js';

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
    it('formats a self-contained debug report with app stack frames only', () => {
        const text = formatErrorReport(
            'request.error',
            {
                method: 'GET',
                path: '/v1/rooms/0123456789abcdef01234567',
                requestId: 'req-1',
                userId: 'u1',
                error: {
                    name: 'TypeError',
                    message: 'boom',
                    code: 'INTERNAL_ERROR',
                    statusCode: 500,
                    stack: [
                        'TypeError: boom',
                        '    at getRoom (/app/services/roomService.ts:120:5)',
                        '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
                        '    at Query.exec (/app/node_modules/mongoose/lib/query.js:1:1)',
                        '    at file:///app/routes/rooms.ts:40:9',
                    ].join('\n'),
                },
            },
            { environment: 'production', commit: 'abc123', rootDir: '/app', time: new Date(Date.UTC(2026, 9, 11, 12, 0, 0)) }
        );
        assert.equal(text, [
            'Bleya backend error',
            'event: request.error',
            'time: 2026-10-11T12:00:00.000Z',
            'env: production',
            'commit: abc123',
            'request: GET /v1/rooms/0123456789abcdef01234567',
            'error: TypeError: boom',
            'code: INTERNAL_ERROR (status 500)',
            'requestId: req-1',
            'userId: u1',
            'stack:',
            '  at getRoom (services/roomService.ts:120:5)',
            '  at routes/rooms.ts:40:9',
        ].join('\n'));
    });

    it('keeps dependency frames when there are no app frames', () => {
        assert.deepEqual(
            cleanStack('Error: x\n    at a (/app/node_modules/x.js:1:1)', '/app'),
            ['at a (node_modules/x.js:1:1)']
        );
    });

    it('sends the report as a copyable <pre> block with HTML escaped', () => {
        const { reporter, sent } = setup();
        reporter.report('request.error', { error: { name: 'Error', message: 'a < b & c' } });
        assert.match(sent[0], /^🔥 <b>request\.error<\/b> · production\n<pre>Bleya backend error\n/);
        assert.match(sent[0], /error: Error: a &lt; b &amp; c/);
        assert.match(sent[0], /<\/pre>$/);
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
        assert.match(sent[1], /^🔁 <b>Still happening<\/b> · production\n<pre>request\.error: TypeError: boom\nhappened 2 more time\(s\) in the last 10 min/);

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
