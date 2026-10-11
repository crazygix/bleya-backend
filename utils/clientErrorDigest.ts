import { config } from '../config/index.js';
import { escapeTelegramHtml, sendTelegramMessage, telegramPreBlock } from './telegram.js';

// Client errors (4xx) are mostly expected one by one (expired tokens, invalid
// input, rate limits), so they are never alerted individually. Instead they
// are counted per route, status and error code, and a digest goes to the
// errors chat every CLIENT_ERROR_DIGEST_MINUTES. A count that jumps, or a
// route that shouldn't fail at all, points at an app bug (or a backend rule
// that's too strict).

const MAX_GROUPS_SHOWN = 20;
const MAX_TRACKED_GROUPS = 300;

export interface ClientErrorInput {
    method: string;
    // The request path; ids are replaced to group requests by route.
    path: string;
    // False when no route matched (scanners, wrong URLs in the app).
    routeMatched: boolean;
    statusCode: number;
    code?: string;
    message?: string;
    requestId?: string;
    userAgent?: string;
}

interface Group {
    method: string;
    route: string;
    statusCode: number;
    code: string;
    count: number;
    sampleMessage: string;
    samplePath: string;
    sampleRequestId: string;
    userAgents: Map<string, number>;
}

export interface ClientErrorDigestOptions {
    enabled: () => boolean;
    send: (html: string) => Promise<boolean>;
    now?: () => number;
    environment?: string;
    commit?: string;
}

export function normalizeRoute(path: string): string {
    return path
        .split('?')[0]
        .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
        .replace(/\/\d+(?=\/|$)/g, '/:n');
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function createClientErrorDigest(options: ClientErrorDigestOptions) {
    const now = options.now ?? Date.now;
    const groups = new Map<string, Group>();
    let windowStart = now();
    let untracked = 0;

    function record(input: ClientErrorInput): void {
        if (!options.enabled() || input.statusCode < 400 || input.statusCode >= 500) {
            return;
        }

        // Unknown URLs are mostly scanners; one group keeps them from crowding
        // out real routes.
        const route = input.routeMatched ? normalizeRoute(input.path) : '(no matching route)';
        const method = input.routeMatched ? input.method : '*';
        const code = input.code || '-';
        const key = `${method} ${route} ${input.statusCode} ${code}`;

        let group = groups.get(key);
        if (!group) {
            if (groups.size >= MAX_TRACKED_GROUPS) {
                untracked += 1;
                return;
            }
            group = {
                method,
                route,
                statusCode: input.statusCode,
                code,
                count: 0,
                sampleMessage: truncate(input.message || '', 150),
                samplePath: truncate(`${input.method} ${input.path.split('?')[0]}`, 150),
                sampleRequestId: input.requestId || '',
                userAgents: new Map(),
            };
            groups.set(key, group);
        }
        group.count += 1;
        const userAgent = truncate(input.userAgent || 'unknown', 80);
        group.userAgents.set(userAgent, (group.userAgents.get(userAgent) ?? 0) + 1);
    }

    function format(): string | null {
        if (groups.size === 0 && untracked === 0) {
            return null;
        }

        const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
        const total = sorted.reduce((sum, group) => sum + group.count, 0) + untracked;
        const lines = [
            'Bleya client errors (4xx) digest',
            `from: ${new Date(windowStart).toISOString()}`,
            `to: ${new Date(now()).toISOString()}`,
            `env: ${options.environment ?? config.nodeEnv}`,
            `commit: ${options.commit ?? 'unknown'}`,
            `total: ${total}`,
            '',
        ];

        for (const group of sorted.slice(0, MAX_GROUPS_SHOWN)) {
            const topAgents = [...group.userAgents.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([agent, count]) => `${agent} (${count})`)
                .join(', ');
            lines.push(`${group.count}× ${group.statusCode} ${group.code} ${group.method} ${group.route}`);
            if (group.sampleMessage) {
                lines.push(`  message: ${group.sampleMessage}`);
            }
            if (group.route === '(no matching route)') {
                lines.push(`  e.g. ${group.samplePath}`);
            }
            lines.push(`  e.g. requestId ${group.sampleRequestId || '-'}`);
            lines.push(`  clients: ${topAgents}`);
        }
        if (sorted.length > MAX_GROUPS_SHOWN) {
            lines.push(`… and ${sorted.length - MAX_GROUPS_SHOWN} more groups`);
        }
        if (untracked > 0) {
            lines.push(`${untracked} more not grouped (too many distinct routes)`);
        }

        return lines.join('\n');
    }

    // Sends the digest for the window that just ended (nothing when there were
    // no client errors) and starts a new one.
    async function flush(): Promise<void> {
        const text = format();
        groups.clear();
        untracked = 0;
        const periodMinutes = Math.max(1, Math.round((now() - windowStart) / 60_000));
        windowStart = now();
        if (text) {
            const header = `⚠️ <b>Client errors</b>, last ${periodMinutes} min · ${escapeTelegramHtml(options.environment ?? config.nodeEnv)}`;
            await options.send(telegramPreBlock(header, text));
        }
    }

    return { record, format, flush };
}

const defaultDigest = createClientErrorDigest({
    enabled: () => config.alerts.clientErrorDigestMinutes > 0
        && !config.isTest
        && config.alerts.telegramBotToken.length > 0
        && config.alerts.errorsChatId.length > 0,
    send: async (html) => (await sendTelegramMessage(config.alerts.errorsChatId, html, { html: true })) === 200,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME || config.nodeEnv,
    commit: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
});

if (config.alerts.clientErrorDigestMinutes > 0) {
    setInterval(() => void defaultDigest.flush(), config.alerts.clientErrorDigestMinutes * 60 * 1000).unref();
}

export const recordClientError = defaultDigest.record;
export const flushClientErrorDigest = defaultDigest.flush;
