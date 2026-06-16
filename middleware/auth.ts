import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { UnauthorizedError, AppError, ErrorCode } from '../utils/errors.js';
import { config } from '../config/index.js';

export interface AuthRequest extends Request {
    user?: {
        userId: string;
    };
}

export const authenticateUser = (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, config.jwtSecret);
            if (typeof decoded !== 'object' || decoded === null || typeof (decoded as { userId?: unknown }).userId !== 'string') {
                return next(new UnauthorizedError('Invalid or expired token'));
            }

            req.user = { userId: (decoded as { userId: string }).userId };
            next();
        } catch {
            return next(new UnauthorizedError('Invalid or expired token'));
        }
    } else {
        return next(new UnauthorizedError('No token provided'));
    }
};

export interface AdminRequest extends Request {
    admin?: {
        actor: string;
    };
}

// Admin gate for the moderation API. Uses a shared secret in ADMIN_API_KEY,
// constant-time compared against the `x-admin-key` header. Fail-closed: if no
// key is configured the whole admin surface is denied, so it stays off until you
// opt in. A web admin panel sends the key as `x-admin-key`; later this guard can
// also accept a logged-in admin-role user without changing any call sites.
export const requireAdmin = (
    req: AdminRequest,
    _res: Response,
    next: NextFunction
) => {
    const configured = config.admin.apiKey;
    if (!configured) {
        return next(new AppError(ErrorCode.FORBIDDEN, 'Admin access is disabled.', 403));
    }

    const provided = req.header('x-admin-key') || '';
    const providedBuf = Buffer.from(provided);
    const configuredBuf = Buffer.from(configured);
    const ok = providedBuf.length === configuredBuf.length
        && crypto.timingSafeEqual(providedBuf, configuredBuf);

    if (!ok) {
        return next(new AppError(ErrorCode.FORBIDDEN, 'Admin access denied.', 403));
    }

    req.admin = { actor: 'admin:env-key' };
    next();
}; 
