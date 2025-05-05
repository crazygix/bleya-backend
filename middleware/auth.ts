import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

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
            return res.status(401).json({ error: 'Invalid token' });
        }
    } else {
        return res.status(401).json({ error: 'No token provided' });
    }
}; 