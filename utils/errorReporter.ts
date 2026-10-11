import { config } from '../config/index.js';
import { sendTelegramMessage } from './telegram.js';

// Sends every error the server logs (logger.error) to the Telegram errors chat,
// so production errors can be fixed as they happen. An error that repeats is
// sent once and then summarized ("happened 37 more times") every
// REPEAT_WINDOW_MS while it keeps happening, and no more than
// MAX_SENDS_PER_MINUTE messages go out, so a broken dependency can't flood the
// chat or hit Telegram's limits.
//
// It must not use the logger (the logger calls it), so a failed send is passed
// to `onSendFailed` instead.

type ErrorContext = { [key: string]: unknown };

const REPEAT_WINDOW_MS = 10 * 60 * 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_SENDS_PER_MINUTE = 15;
const MAX_TRACKED_ERRORS = 500;
const MAX_STACK_FRAMES = 6;
const MAX_FIELD_LENGTH = 300;

interface TrackedError {
    lastSentAt: number;
    suppressed: number;
    summary: string;
}

export interface ErrorReporterOptions {
    enabled: () => boolean;
    send: (text: string) => Promise<boolean>;
    now?: () => number;
    environment?: string;
}

function describeError(value: unknown): { name: string; message: string; stack?: string } | null {
    if (value instanceof Error) {
        return { name: value.name, message: value.message, stack: value.stack };
    }
    if (value && typeof value === 'object') {
        const candidate = value as { name?: unknown; message?: unknown; stack?: unknown };
        if (typeof candidate.message === 'string') {
            return {
                name: typeof candidate.name === 'string' ? candidate.name : 'Error',
                message: candidate.message,
                stack: typeof candidate.stack === 'string' ? candidate.stack : undefined,
            };
        }
    }
    if (typeof value === 'string') {
        return { name: 'Error', message: value };
    }
    return null;
}

// Ids, numbers and quoted values vary between occurrences of the same error.
function normalizeForGrouping(text: string): string {
    return text
        .replace(/[0-9a-f]{24}/gi, ':id')
        .replace(/\d+/g, '#')
        .replace(/"[^"]*"|'[^']*'/g, '"…"')
        .slice(0, 200);
}

export function errorFingerprint(event: string, context?: ErrorContext): string {
    const error = describeError(context?.error);
    const path = typeof context?.path === 'string' ? context.path : '';
    return [event, error?.name ?? '', normalizeForGrouping(error?.message ?? ''), normalizeForGrouping(path)].join('|');
}

function stringifyField(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) {
        return String(value);
    }
    return text.length > MAX_FIELD_LENGTH ? `${text.slice(0, MAX_FIELD_LENGTH)}…` : text;
}

export function formatErrorReport(event: string, context: ErrorContext | undefined, environment: string): string {
    const lines = [`🔥 ${event} · ${environment}`];
    const error = describeError(context?.error);

    if (typeof context?.method === 'string' && typeof context?.path === 'string') {
        lines.push(`${context.method} ${context.path}`);
    }
    if (error) {
        lines.push(`${error.name}: ${error.message}`);
        const frames = (error.stack ?? '')
            .split('\n')
            .slice(1)
            .map((frame) => frame.trim())
            .filter((frame) => frame.startsWith('at '))
            .slice(0, MAX_STACK_FRAMES);
        lines.push(...frames);
    }

    const details = Object.entries(context ?? {})
        .filter(([key, value]) => !['error', 'method', 'path'].includes(key) && value !== undefined)
        .map(([key, value]) => `${key}: ${stringifyField(value)}`);
    if (details.length > 0) {
        lines.push('', ...details);
    }

    return lines.join('\n');
}

export function createErrorReporter(options: ErrorReporterOptions) {
    const now = options.now ?? Date.now;
    const environment = options.environment ?? config.nodeEnv;
    const tracked = new Map<string, TrackedError>();
    const sentAt: number[] = [];
    const pending = new Set<Promise<unknown>>();
    let droppedByRateLimit = 0;
    let onSendFailed: (() => void) | undefined;

    function underRateLimit(): boolean {
        const cutoff = now() - RATE_WINDOW_MS;
        while (sentAt.length > 0 && sentAt[0] <= cutoff) {
            sentAt.shift();
        }
        return sentAt.length < MAX_SENDS_PER_MINUTE;
    }

    function deliver(text: string): void {
        if (!underRateLimit()) {
            droppedByRateLimit += 1;
            return;
        }
        sentAt.push(now());

        let body = text;
        if (droppedByRateLimit > 0) {
            body += `\n\n(${droppedByRateLimit} earlier error alert(s) not sent: rate limit; see the logs)`;
            droppedByRateLimit = 0;
        }

        const sending = options.send(body).then((ok) => {
            if (!ok) {
                onSendFailed?.();
            }
        });
        pending.add(sending);
        void sending.finally(() => pending.delete(sending));
    }

    function report(event: string, context?: ErrorContext): void {
        if (!options.enabled()) {
            return;
        }

        const key = errorFingerprint(event, context);
        const existing = tracked.get(key);
        if (existing && now() - existing.lastSentAt < REPEAT_WINDOW_MS) {
            existing.suppressed += 1;
            return;
        }

        if (!existing && tracked.size >= MAX_TRACKED_ERRORS) {
            const oldest = tracked.keys().next().value;
            if (oldest !== undefined) {
                tracked.delete(oldest);
            }
        }

        const error = describeError(context?.error);
        tracked.delete(key);
        tracked.set(key, {
            lastSentAt: now(),
            suppressed: 0,
            summary: error ? `${event}: ${error.name}: ${error.message}` : event,
        });
        deliver(formatErrorReport(event, context, environment));
    }

    // Sends the "happened N more times" summaries that are due, and forgets
    // errors that stopped happening.
    function flushRepeats(): void {
        for (const [key, entry] of tracked) {
            if (now() - entry.lastSentAt < REPEAT_WINDOW_MS) {
                continue;
            }
            if (entry.suppressed === 0) {
                tracked.delete(key);
                continue;
            }
            const minutes = Math.round((now() - entry.lastSentAt) / 60_000);
            deliver(`🔁 ${entry.summary}\nhappened ${entry.suppressed} more time(s) in the last ${minutes} min · ${environment}`);
            entry.lastSentAt = now();
            entry.suppressed = 0;
        }
    }

    // Waits (at most timeoutMs) for alerts still being sent, e.g. before the
    // process exits on a fatal error.
    async function flush(timeoutMs: number): Promise<void> {
        await Promise.race([
            Promise.allSettled([...pending]),
            new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
        ]);
    }

    function setSendFailureHandler(handler: () => void): void {
        onSendFailed = handler;
    }

    return { report, flushRepeats, flush, setSendFailureHandler };
}

const defaultReporter = createErrorReporter({
    enabled: () => config.alerts.sendErrors
        && !config.isTest
        && config.alerts.telegramBotToken.length > 0
        && config.alerts.errorsChatId.length > 0,
    send: async (text) => (await sendTelegramMessage(config.alerts.errorsChatId, text)) === 200,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || config.nodeEnv,
});

setInterval(() => defaultReporter.flushRepeats(), FLUSH_INTERVAL_MS).unref();

export const reportError = defaultReporter.report;
export const flushErrorReports = defaultReporter.flush;
export const setErrorReportFailureHandler = defaultReporter.setSendFailureHandler;
