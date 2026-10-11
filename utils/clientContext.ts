import type { IncomingHttpHeaders } from 'http';

// The app describes itself on every request (REST and the socket handshake)
// with these headers, for analytics. All three are optional; a malformed value
// is dropped, never rejected.
export const APP_PLATFORM_HEADER = 'x-app-platform';
export const APP_VERSION_HEADER = 'x-app-version';
export const INSTALL_ID_HEADER = 'x-install-id';

export interface ClientContext {
    platform?: string;
    appVersion?: string;
    // Random id the app generates once per install. It lets a signed-out
    // sign-in attempt be linked to its outcome, so failures can be counted per
    // person instead of per attempt.
    installId?: string;
}

const PLATFORM_PATTERN = /^(ios|android|web)$/;
const APP_VERSION_PATTERN = /^[\w.+-]{1,32}$/;
const INSTALL_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function matchOptional(value: unknown, pattern: RegExp): string | undefined {
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

export function normalizePlatform(value: unknown): string | undefined {
    return matchOptional(value, PLATFORM_PATTERN);
}

export function normalizeAppVersion(value: unknown): string | undefined {
    return matchOptional(value, APP_VERSION_PATTERN);
}

export function normalizeInstallId(value: unknown): string | undefined {
    return matchOptional(value, INSTALL_ID_PATTERN);
}

export function readClientContext(headers: IncomingHttpHeaders): ClientContext {
    return {
        platform: normalizePlatform(headers[APP_PLATFORM_HEADER]),
        appVersion: normalizeAppVersion(headers[APP_VERSION_HEADER]),
        installId: normalizeInstallId(headers[INSTALL_ID_HEADER]),
    };
}
