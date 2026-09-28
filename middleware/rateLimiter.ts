import rateLimit, { ipKeyGenerator, type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { config } from '../config/index.js';
import { TooManyRequestsError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { getLoggablePath } from '../utils/requestPath.js';
import { getClientIp } from '../utils/trustedProxy.js';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export interface RateLimiterOptions {
    name: string;
    limit: number;
    windowMs?: number;
    // Count only failed requests (status >= 400) — e.g. wrong admin keys.
    skipSuccessfulRequests?: boolean;
}

export function createRateLimiter({
    name,
    limit,
    windowMs = FIFTEEN_MINUTES_MS,
    skipSuccessfulRequests = false,
}: RateLimiterOptions): RateLimitRequestHandler {
    const handler: Options['handler'] = (req, _res, next) => {
        logger.warn('rate_limit.exceeded', {
            limiter: name,
            ip: getClientIp(req),
            path: getLoggablePath(req),
            method: req.method,
        });
        next(new TooManyRequestsError('Too many requests. Please try again later.'));
    };

    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        skipSuccessfulRequests,
        // Key on the real client (see utils/trustedProxy), grouping IPv6
        // addresses by /56 so one host can't rotate through its prefix.
        keyGenerator: (req) => ipKeyGenerator(getClientIp(req)),
        skip: () => config.isTest,
        handler,
    });
}

// Kept as no-ops for test-helper backwards compatibility. The previous custom
// limiter exposed these to scrub a shared in-memory store between tests; the
// new implementation skips entirely in test mode, so nothing needs resetting.
export function resetRateLimiterStoreForTests(): void {}
export function stopRateLimiterCleanupForTests(): void {}
