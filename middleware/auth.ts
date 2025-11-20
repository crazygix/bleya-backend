import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { UnauthorizedError } from '../utils/errors.js';

dotenv.config();

export interface AuthRequest extends Request {
    user?: {
        userId: string;
        phoneNumber: string;
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
            const decoded = jwt.verify(token, process.env.JWT_SECRET!);
            req.user = decoded as { userId: string; phoneNumber: string };
            next();
        } catch (err) {
            return next(new UnauthorizedError('Invalid or expired token'));
        }
    } else {
        return next(new UnauthorizedError('No token provided'));
    }
}; 