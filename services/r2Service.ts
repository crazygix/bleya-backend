import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Lazy initialization of S3 client for Cloudflare R2
// This ensures environment variables are loaded before client is created
let r2Client: S3Client | null = null;

function getR2Client(): S3Client {
    if (!r2Client) {
        const endpoint = process.env.R2_ENDPOINT;
        const accessKeyId = process.env.R2_ACCESS_KEY_ID;
        const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

        if (!endpoint || !accessKeyId || !secretAccessKey) {
            throw new Error(
                'R2 configuration incomplete. Please set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.'
            );
        }

        // forcePathStyle: true is required for R2 (uses path-style URLs instead of virtual-hosted-style)
        r2Client = new S3Client({
            region: 'auto',
            endpoint: endpoint,
            forcePathStyle: true,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
        });
    }
    return r2Client;
}

// Get bucket name dynamically from environment (not cached at module load)
function getBucketName(): string {
    const bucketName = process.env.R2_BUCKET_NAME || '';
    if (!bucketName || bucketName.trim() === '') {
        throw new Error(
            'R2_BUCKET_NAME environment variable is not set or is empty. ' +
            'Please configure R2_BUCKET_NAME in your environment variables.'
        );
    }
    return bucketName;
}

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
    const bucketName = getBucketName();
    
    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable',
        });

        await getR2Client().send(command);

        // Construct public URL based on environment
        // Use environment-specific public URL if available, otherwise fall back to default
        const isProduction = process.env.NODE_ENV === 'production';
        const publicUrl = isProduction
            ? (process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${bucketName}`)
            : (process.env.R2_PUBLIC_URL_DEV || process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${bucketName}`);

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
    const bucketName = getBucketName();
    
    try {
        const command = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        });

        await getR2Client().send(command);
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
    const bucketName = getBucketName();
    
    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            ContentType: contentType,
        });

        return await getSignedUrl(getR2Client(), command, { expiresIn });
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
    const bucketName = getBucketName();
    
    try {
        const command = new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
        });

        return await getSignedUrl(getR2Client(), command, { expiresIn });
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
        const bucketName = process.env.R2_BUCKET_NAME || '';
        if (!bucketName) return null;
        
        // If URL contains the bucket name, extract the key
        if (url.includes(bucketName)) {
            const parts = url.split(`${bucketName}/`);
            return parts[1] || null;
        }
        // If using custom domain, extract from path
        const isProduction = process.env.NODE_ENV === 'production';
        const publicUrl = isProduction
            ? (process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${bucketName}`)
            : (process.env.R2_PUBLIC_URL_DEV || process.env.R2_PUBLIC_URL || `${process.env.R2_ENDPOINT}/${bucketName}`);

        if (publicUrl && url.startsWith(publicUrl)) {
            return url.replace(publicUrl + '/', '');
        }
        return null;
    } catch {
        return null;
    }
}

