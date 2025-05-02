import { Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
    });
}

export interface AuthRequest extends Request {
    user?: {
        uid: string;
        phoneNumber: string;
    };
}

export const authenticateUser = async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);

        req.user = {
            uid: decodedToken.uid,
            phoneNumber: decodedToken.phone_number || '',
        };

        next();
    } catch (error) {
        console.error('Authentication error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
}; 