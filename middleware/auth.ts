import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../utils/errors.js';
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
