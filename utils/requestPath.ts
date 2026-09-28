import type { Request } from 'express';
import { config } from '../config/index.js';

// Query-string values that must never reach the logs: precise location
// (/cities/nearby?lat=&lng=), and anything the body-redaction list treats as
// secret (e.g. the Apple callback's code / id_token / user when sent as a GET).
const LOCATION_QUERY_KEYS = ['lat', 'lng', 'lon', 'latitude', 'longitude'];
const EXTRA_SECRET_QUERY_KEYS = ['code', 'user', 'state'];

const redactedQueryKeys = new Set(
    [...config.httpLogging.bodyRedactFields, ...LOCATION_QUERY_KEYS, ...EXTRA_SECRET_QUERY_KEYS]
        .map((key) => key.toLowerCase())
);

/** Returns the URL with sensitive query values replaced by REDACTED. */
export function toLoggablePath(rawUrl: string): string {
    const queryStart = rawUrl.indexOf('?');
    if (queryStart === -1) {
        return rawUrl;
    }

    const pathname = rawUrl.slice(0, queryStart);
    const params = new URLSearchParams(rawUrl.slice(queryStart + 1));
    const parts: string[] = [];
    for (const [key, value] of params) {
        const safeValue = redactedQueryKeys.has(key.toLowerCase()) ? 'REDACTED' : encodeURIComponent(value);
        parts.push(`${encodeURIComponent(key)}=${safeValue}`);
    }

    return parts.length > 0 ? `${pathname}?${parts.join('&')}` : pathname;
}

export function getLoggablePath(req: Request): string {
    return toLoggablePath(req.originalUrl || req.url || '');
}

/** Path without any query string, for route matching. */
export function getPathname(req: Request): string {
    const rawUrl = req.originalUrl || req.url || '';
    const queryStart = rawUrl.indexOf('?');
    return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}
