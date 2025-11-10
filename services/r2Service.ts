import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Initialize S3 client for Cloudflare R2
const r2Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME || '';

export interface UploadResult {
    url: string;
    key: string;
}

/**
 * Upload a file buffer to R2
 */
export async function uploadToR2(
    buffer: Buffer,
    key: string,
    contentType: string
): Promise<UploadResult> {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable',
        });

        await r2Client.send(command);

        // Construct public URL based on environment
        // Use environment-specific public URL if available, otherwise fall back to default
        const isProduction = process.env.NODE_ENV === 'production';
        const publicUrl = isProduction
            ? (process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${BUCKET_NAME}`)
            : (process.env.R2_PUBLIC_URL_DEV || process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${BUCKET_NAME}`);

        return {
            url: `${publicUrl}/${key}`,
            key: key,
        };
    } catch (error) {
        console.error('Error uploading to R2:', error);
        throw new Error('Failed to upload file to R2');
    }
}

/**
 * Delete a file from R2
 */
export async function deleteFromR2(key: string): Promise<void> {
    try {
        const command = new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });

        await r2Client.send(command);
    } catch (error) {
        console.error('Error deleting from R2:', error);
        // Don't throw - deletion failures shouldn't break the flow
    }
}

/**
 * Generate a presigned URL for direct client uploads (optional, for future use)
 */
export async function getPresignedUploadUrl(
    key: string,
    contentType: string,
    expiresIn: number = 3600
): Promise<string> {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: contentType,
        });

        return await getSignedUrl(r2Client, command, { expiresIn });
    } catch (error) {
        console.error('Error generating presigned URL:', error);
        throw new Error('Failed to generate presigned URL');
    }
}

/**
 * Generate a presigned URL for reading (if bucket is private)
 */
export async function getPresignedReadUrl(
    key: string,
    expiresIn: number = 3600
): Promise<string> {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
        });

        return await getSignedUrl(r2Client, command, { expiresIn });
    } catch (error) {
        console.error('Error generating presigned read URL:', error);
        throw new Error('Failed to generate presigned read URL');
    }
}

/**
 * Extract key from R2 URL (for deletion purposes)
 */
export function extractKeyFromUrl(url: string): string | null {
    try {
        // If URL contains the bucket name, extract the key
        if (url.includes(BUCKET_NAME)) {
            const parts = url.split(`${BUCKET_NAME}/`);
            return parts[1] || null;
        }
        // If using custom domain, extract from path
        const isProduction = process.env.NODE_ENV === 'production';
        const publicUrl = isProduction
            ? (process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${BUCKET_NAME}`)
            : (process.env.R2_PUBLIC_URL_DEV || process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${BUCKET_NAME}`);

        if (publicUrl && url.startsWith(publicUrl)) {
            return url.replace(publicUrl + '/', '');
        }
        return null;
    } catch {
        return null;
    }
}

