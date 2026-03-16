import mongoose from 'mongoose';
import { User } from '../../models/User.js';
import { signAccessToken } from '../../services/authService.js';

interface TestUserOverrides {
    username?: string;
    bio?: string;
    joinedRooms?: mongoose.Types.ObjectId[];
}

export async function createTestUser(overrides: TestUserOverrides = {}) {
    const user = await User.create({
        username: overrides.username,
        bio: overrides.bio || '',
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

export function makeProviderTestToken(claims: Record<string, unknown>): string {
    return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
}
