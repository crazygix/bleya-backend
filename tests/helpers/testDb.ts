import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer | null = null;

const TEST_MONGO_LAUNCH_TIMEOUT_MS = Number(process.env.TEST_MONGO_LAUNCH_TIMEOUT_MS ?? 30000);
const TEST_MONGO_START_RETRIES = Number(process.env.TEST_MONGO_START_RETRIES ?? 2);

export async function connectTestDb(): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= TEST_MONGO_START_RETRIES; attempt += 1) {
        try {
            mongoServer = await MongoMemoryServer.create({
                instance: { launchTimeout: TEST_MONGO_LAUNCH_TIMEOUT_MS },
            });
            const uri = mongoServer.getUri();
            await mongoose.connect(uri);
            return;
        } catch (error) {
            lastError = error;

            if (mongoServer) {
                await mongoServer.stop().catch(() => undefined);
                mongoServer = null;
            }

            if (attempt === TEST_MONGO_START_RETRIES) {
                throw error;
            }
        }
    }

    throw lastError instanceof Error ? lastError : new Error('Failed to start test database');
}

export async function clearTestDb(): Promise<void> {
    await mongoose.connection.dropDatabase();
}

export async function disconnectTestDb(): Promise<void> {
    await mongoose.disconnect();
    if (mongoServer) {
        await mongoServer.stop();
        mongoServer = null;
    }
}
