import { Request, Response, NextFunction } from 'express';
import { TooManyRequestsError } from '../utils/errors.js';

interface RateLimitStore {
    count: number;
    resetTime: number;
}

// In-memory store for rate limiting (use Redis in production for distributed systems)
const rateLimitStore = new Map<string, RateLimitStore>();

// Clean up expired entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of rateLimitStore.entries()) {
        if (value.resetTime < now) {
            rateLimitStore.delete(key);
        }
    }
}, 5 * 60 * 1000);

/**
 * Rate limiter middleware
 * @param maxRequests Maximum number of requests allowed
 * @param windowMs Time window in milliseconds
 * @param keyGenerator Function to generate a unique key for rate limiting (default: IP address)
 */
export const rateLimiter = (
    maxRequests: number,
    windowMs: number,
    keyGenerator?: (req: Request) => string
) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket.remoteAddress || 'unknown');
        const now = Date.now();

        let store = rateLimitStore.get(key);

        // Initialize or reset if window expired
        if (!store || store.resetTime < now) {
            store = {
                count: 0,
                resetTime: now + windowMs
            };
            rateLimitStore.set(key, store);
        }

        // Increment count
        store.count++;

        // Set rate limit headers
        res.setHeader('X-RateLimit-Limit', maxRequests.toString());
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - store.count).toString());
        res.setHeader('X-RateLimit-Reset', store.resetTime.toString());

        // Check if limit exceeded
        if (store.count > maxRequests) {
            return next(new TooManyRequestsError(
                `Too many requests. Please try again after ${store.resetTime}`
            ));
        }

        next();
    };
};
