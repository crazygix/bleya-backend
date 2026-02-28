import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

let r2Client: S3Client | null = null;

export function setR2ClientForTests(client: S3Client | null): void {
    r2Client = client;
}

export function resetR2ClientForTests(): void {
    r2Client = null;
}

function getR2Client(): S3Client {
    if (!r2Client) {
        if (!config.r2.endpoint || !config.r2.accessKeyId || !config.r2.secretAccessKey) {
            throw new Error(
                'R2 configuration incomplete. Please set R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY environment variables.'
            );
        }

        r2Client = new S3Client({
            region: 'auto',
            endpoint: config.r2.endpoint,
            forcePathStyle: true,
            credentials: {
                accessKeyId: config.r2.accessKeyId,
                secretAccessKey: config.r2.secretAccessKey,
            },
        });
    }
    return r2Client;
}

function getBucketName(): string {
    const bucketName = config.r2.bucketName;
    if (!bucketName || bucketName.trim() === '') {
        throw new Error(
            'R2_BUCKET_NAME environment variable is not set or is empty. ' +
            'Please configure R2_BUCKET_NAME in your environment variables.'
        );
    }
    return bucketName;
}

function getPublicBaseUrl(bucketName: string): string {
    if (config.isProduction) {
        return config.r2.publicUrl || `${config.r2.endpoint}/${bucketName}`;
    }

    return config.r2.publicUrlDev || config.r2.publicUrl || `${config.r2.endpoint}/${bucketName}`;
}

export interface UploadResult {
    url: string;
    key: string;
}

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

        const publicUrl = getPublicBaseUrl(bucketName);

        return {
            url: `${publicUrl}/${key}`,
            key,
        };
    } catch (error) {
        logger.error('r2.upload.failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
        });
        throw new Error('Failed to upload file to R2');
    }
}

export async function deleteFromR2(key: string): Promise<void> {
    const bucketName = getBucketName();

    try {
        const command = new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        });

        await getR2Client().send(command);
    } catch (error) {
        logger.warn('r2.delete.failed', {
            key,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export function extractKeyFromUrl(url: string): string | null {
    try {
        const bucketName = config.r2.bucketName;
        if (!bucketName) return null;

        if (url.includes(bucketName)) {
            const parts = url.split(`${bucketName}/`);
            return parts[1] || null;
        }

        const publicUrl = getPublicBaseUrl(bucketName);
        if (publicUrl && url.startsWith(publicUrl)) {
            return url.replace(`${publicUrl}/`, '');
        }

        return null;
    } catch {
        return null;
    }
}
