import path from 'path';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from './r2Service.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { isValidUsername, normalizeUsernameInput } from '../utils/username.js';
import logger from '../utils/logger.js';
import { type UserRepository, userRepository as defaultUserRepo } from '../repositories/userRepository.js';

export interface UserProfileResponse {
    id: string;
    username: string;
    bio: string;
    profileImageUrl: string;
    createdAt: number;
    updatedAt: number;
    lastLogin: number;
}

export interface PublicUserResponse {
    id: string;
    username: string;
    bio: string;
    profileImageUrl: string;
    createdAt: number;
    updatedAt: number;
}

export function toUserProfileResponse(user: {
    _id: { toString(): string };
    username?: string;
    bio?: string;
    profileImageUrl?: string;
    createdAt: { getTime(): number };
    updatedAt: { getTime(): number };
    lastLogin: { getTime(): number };
}): UserProfileResponse {
    return {
        id: user._id.toString(),
        username: user.username || '',
        bio: user.bio || '',
        profileImageUrl: user.profileImageUrl || '',
        createdAt: user.createdAt.getTime(),
        updatedAt: user.updatedAt.getTime(),
        lastLogin: user.lastLogin.getTime(),
    };
}

export interface UserServiceDeps {
    userRepo: UserRepository;
}

export function createUserService(deps: UserServiceDeps) {
    const { userRepo } = deps;

    async function getUserProfile(userId: string): Promise<UserProfileResponse> {
        const user = await userRepo.findByIdLean(userId);
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }
        return toUserProfileResponse(user);
    }

    async function getPublicProfile(userId: string): Promise<PublicUserResponse> {
        const user = await userRepo.findByIdLean(userId);
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        return {
            id: user._id.toString(),
            username: user.username || '',
            bio: user.bio || '',
            profileImageUrl: user.profileImageUrl || '',
            createdAt: user.createdAt.getTime(),
            updatedAt: user.updatedAt.getTime(),
        };
    }

    async function updateProfile(
        userId: string,
        updates: { username?: string; bio?: string }
    ): Promise<UserProfileResponse> {
        const user = await userRepo.findById(userId) as any;
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        let profileChanged = false;

        if (updates.username !== undefined) {
            if (typeof updates.username !== 'string' || updates.username.trim().length === 0) {
                throw new ValidationError("Username can't be empty.");
            }

            const normalizedUsername = normalizeUsernameInput(updates.username);
            if (!isValidUsername(normalizedUsername)) {
                throw new ValidationError('Keep it simple: 3-30 characters, just letters, numbers, and underscores.');
            }

            if (user.username !== normalizedUsername) {
                user.username = normalizedUsername;
                profileChanged = true;
            }
        }

        if (updates.bio !== undefined) {
            if (typeof updates.bio !== 'string') {
                throw new ValidationError('Bio needs to be text.');
            }

            const sanitizedBio = sanitizePlainText(updates.bio, {
                maxLength: 280,
                collapseWhitespace: false,
                escapeHtml: true,
            });

            if (user.bio !== sanitizedBio) {
                user.bio = sanitizedBio;
                profileChanged = true;
            }
        }

        if (profileChanged) {
            user.updatedAt = new Date();
        }

        await user.save();
        return toUserProfileResponse(user);
    }

    async function updateProfileImage(
        userId: string,
        file: { buffer: Buffer; originalname: string; mimetype: string }
    ): Promise<UserProfileResponse> {
        const user = await userRepo.findById(userId) as any;
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        if (user.profileImageUrl) {
            const oldKey = extractKeyFromUrl(user.profileImageUrl);
            if (oldKey) {
                try {
                    await deleteFromR2(oldKey);
                } catch (error) {
                    logger.warn('profile_image.delete_old.failed', {
                        userId: user._id.toString(),
                        key: oldKey,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }

        const fileExtension = path.extname(file.originalname).toLowerCase();
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        const key = `profiles/profile-${uniqueSuffix}${fileExtension}`;

        const uploadResult = await uploadToR2(file.buffer, key, file.mimetype);

        user.profileImageUrl = uploadResult.url;
        user.updatedAt = new Date();
        await user.save();

        return toUserProfileResponse(user);
    }

    return { getUserProfile, getPublicProfile, updateProfile, updateProfileImage };
}

const defaultUserService = createUserService({ userRepo: defaultUserRepo });

export const getUserProfile = defaultUserService.getUserProfile;
export const getPublicProfile = defaultUserService.getPublicProfile;
export const updateProfile = defaultUserService.updateProfile;
export const updateProfileImage = defaultUserService.updateProfileImage;
