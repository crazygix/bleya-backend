import crypto from 'crypto';
import sharp from 'sharp';
import { uploadToR2, deleteFromR2, extractKeyFromUrl } from './r2Service.js';
import { moderateImage } from './imageModerationService.js';
import { NotFoundError, ValidationError, ErrorCode } from '../utils/errors.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { isValidUsername, normalizeUsernameInput } from '../utils/username.js';
import { assertCleanText } from '../utils/contentFilter.js';
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

const PROFILE_IMAGE_MAX_DIMENSION = 1024;
// Guards against decompression bombs (a tiny file that decodes to a huge image).
const PROFILE_IMAGE_MAX_INPUT_PIXELS = 40_000_000;
// The app uploads JPEG/PNG/GIF; HEIF is left out to keep the decoder surface small.
const ACCEPTED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
const UNSUPPORTED_IMAGE_MESSAGE = "That file isn't a supported image. Please choose a JPEG or PNG photo.";

/**
 * Re-encodes an uploaded image as WebP. The file's real content decides whether
 * it is an image (not its name or the client's Content-Type), EXIF orientation
 * is applied, and all metadata — including GPS location — is dropped, since
 * sharp only keeps it when asked to.
 */
export async function normalizeProfileImage(buffer: Buffer): Promise<Buffer> {
    try {
        const image = sharp(buffer, { limitInputPixels: PROFILE_IMAGE_MAX_INPUT_PIXELS, failOn: 'error' });
        const metadata = await image.metadata();
        if (!metadata.format || !ACCEPTED_IMAGE_FORMATS.has(metadata.format)) {
            throw new ValidationError(UNSUPPORTED_IMAGE_MESSAGE);
        }

        return await image
            .rotate()
            .resize(PROFILE_IMAGE_MAX_DIMENSION, PROFILE_IMAGE_MAX_DIMENSION, {
                fit: 'inside',
                withoutEnlargement: true,
            })
            .webp({ quality: 82 })
            .toBuffer();
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new ValidationError(UNSUPPORTED_IMAGE_MESSAGE);
    }
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

            assertCleanText(normalizedUsername, 'username');

            // Same rules as POST /auth/set-username: a username is chosen once.
            const currentUsername = (user.username || '').trim();
            if (currentUsername && currentUsername !== normalizedUsername) {
                throw new ValidationError("You've already set your username and can't change it.");
            }

            if (!currentUsername) {
                const existingUser = await userRepo.findByUsernameLean(normalizedUsername);
                if (existingUser && existingUser._id.toString() !== userId) {
                    throw new ValidationError("That username's taken. Try another one?");
                }

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
            });

            assertCleanText(sanitizedBio, 'bio');

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
        file: { buffer: Buffer }
    ): Promise<UserProfileResponse> {
        const user = await userRepo.findById(userId) as any;
        if (!user) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }

        const imageBuffer = await normalizeProfileImage(file.buffer);

        const imageCheck = await moderateImage(imageBuffer, 'image/webp');
        if (!imageCheck.allowed) {
            throw new ValidationError(imageCheck.reason || "That image isn't allowed.");
        }

        // Random, server-chosen name and type: the client's filename and
        // Content-Type never reach the public bucket.
        const key = `profiles/profile-${crypto.randomUUID()}.webp`;
        const uploadResult = await uploadToR2(imageBuffer, key, 'image/webp');

        const previousImageUrl: string = user.profileImageUrl || '';
        user.profileImageUrl = uploadResult.url;
        user.updatedAt = new Date();
        await user.save();

        // Only now that the new image is saved is the old one safe to delete.
        if (previousImageUrl) {
            const oldKey = extractKeyFromUrl(previousImageUrl);
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

        return toUserProfileResponse(user);
    }

    return { getUserProfile, getPublicProfile, updateProfile, updateProfileImage };
}

const defaultUserService = createUserService({ userRepo: defaultUserRepo });

export const getUserProfile = defaultUserService.getUserProfile;
export const getPublicProfile = defaultUserService.getPublicProfile;
export const updateProfile = defaultUserService.updateProfile;
export const updateProfileImage = defaultUserService.updateProfileImage;
