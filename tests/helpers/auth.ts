import mongoose from 'mongoose';
import { User } from '../../models/User.js';
import { signAccessToken } from '../../services/authService.js';

interface TestUserOverrides {
    phoneNumber?: string;
    username?: string;
    bio?: string;
    code?: string;
    codeExpiresAt?: Date;
    codeSentAt?: Date;
    joinedRooms?: mongoose.Types.ObjectId[];
}

export async function createTestUser(overrides: TestUserOverrides = {}) {
    const user = await User.create({
        phoneNumber: overrides.phoneNumber || `+1${Date.now()}`,
        username: overrides.username,
        bio: overrides.bio || '',
        code: overrides.code,
        codeExpiresAt: overrides.codeExpiresAt,
        codeSentAt: overrides.codeSentAt,
        joinedRooms: overrides.joinedRooms || [],
    });
    return user;
}

export function getAuthToken(userId: string): string {
    return signAccessToken({ userId });
}

export function authHeader(userId: string): { Authorization: string } {
    return { Authorization: `Bearer ${getAuthToken(userId)}` };
}
