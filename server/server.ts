import express, { Request, Response } from 'express'
import http from 'http'
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import fs from 'fs'
import authRoutes from '../routes/auth.js'
import roomRoutes from '../routes/rooms.js'
import userRoutes from '../routes/users.js'
import messageRoutes from '../routes/messages.js'
import mongoose from 'mongoose'
import { Room } from '../models/Room.js'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { setupSocketIO } from './socket.js'
import { errorHandler } from '../middleware/errorHandler.js'

// Load .env file from project root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

// Helper function for logging (ensures immediate flush for Railway)
const log = (message: string, data?: any) => {
    const timestamp = new Date().toISOString();
    const logMessage = data
        ? `[${timestamp}] ${message} ${JSON.stringify(data)}`
        : `[${timestamp}] ${message}`;
    console.log(logMessage);
};

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not set');
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is not set');
}

// Validate R2 configuration (required for file uploads)
const r2Endpoint = process.env.R2_ENDPOINT;
const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const r2BucketName = process.env.R2_BUCKET_NAME;

const isProduction = process.env.NODE_ENV === 'production';
const r2ConfigMissing = !r2Endpoint || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName;

if (r2ConfigMissing) {
    const missingVars = {
        R2_ENDPOINT: r2Endpoint ? 'set' : 'missing',
        R2_ACCESS_KEY_ID: r2AccessKeyId ? 'set' : 'missing',
        R2_SECRET_ACCESS_KEY: r2SecretAccessKey ? 'set' : 'missing',
        R2_BUCKET_NAME: r2BucketName ? 'set' : 'missing',
    };

    if (isProduction) {
        // In production, R2 is required - fail fast
        throw new Error(`R2 configuration incomplete in production. Missing: ${JSON.stringify(missingVars)}`);
    } else {
        // In development, warn but allow server to start
        log('Warning: R2 configuration incomplete. File uploads will fail.');
        log('Required R2 env vars:', missingVars);
    }
}

// MongoDB connection options
const mongooseOptions = {
    serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
    socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
    connectTimeoutMS: 10000, // Give up initial connection after 10s
    maxPoolSize: 50, // Increased from 10 for better concurrency
    minPoolSize: 5, // Increased from 2 for faster response
    retryWrites: true,
    retryReads: true,
};

mongoose.connection.on('connected', () => {
    log('MongoDB connected');
})

mongoose.connection.on('error', err => {
    log('MongoDB connection error:', err);
})

mongoose.connection.on('disconnected', () => {
    log('MongoDB disconnected');
})

const app = express()

// Security headers with helmet
// Configure helmet for production security
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"], // Allow images from R2/CDN
            connectSrc: ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding for Socket.io
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow R2 resources
}));

// CORS configuration - more permissive for production
app.use(cors({
    origin: true, // Allow all origins in production
    credentials: true, // Enable credentials for httpOnly cookies
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}))

app.use(compression())
app.use(cookieParser())

// Body parser configuration - more explicit for production
app.use(bodyParser.json({ limit: '10mb' }))
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }))

// Add request/response logging for debugging
app.use((req: Request, res: Response, next) => {
    log(`${req.method} ${req.path}`, { body: req.body, query: req.query });

    // Log response when it finishes
    const originalSend = res.send;
    res.send = function (body) {
        log(`${req.method} ${req.path} - Response:`, { status: res.statusCode, body: typeof body === 'string' ? body.substring(0, 200) : body });
        return originalSend.call(this, body);
    };

    next()
})

// Mount auth routes
app.use('/api/auth', authRoutes)

// Mount room routes
app.use('/api/rooms', roomRoutes)

// Mount user routes
app.use('/api/users', userRoutes)

// Mount message routes
app.use('/api/messages', messageRoutes)

app.get("/", (req: Request, res: Response) => {
    res.json({ message: "Gde si bre zverino?" })
})

// Enhanced health check endpoint with monitoring
app.get("/health", async (req: Request, res: Response) => {
    const health = {
        status: "ok",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        port: process.env.PORT || 8080,
        mongodb: {
            status: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
            readyState: mongoose.connection.readyState, // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
        },
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // MB
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024), // MB
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024), // MB
        },
        uptime: Math.round(process.uptime()), // seconds
    };

    // Return 503 if DB is not connected
    const statusCode = mongoose.connection.readyState === 1 ? 200 : 503;
    res.status(statusCode).json(health);
});

// Error handling middleware (must be last)
app.use(errorHandler);

const server = http.createServer(app)

// Setup Socket.io
setupSocketIO(server)

// Global error handlers for unhandled rejections and exceptions
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const errorData = {
        timestamp: new Date().toISOString(),
        type: 'unhandledRejection',
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
        promise: promise.toString(),
    };

    // Write synchronously to ensure logs are flushed before exit
    fs.writeSync(process.stderr.fd, `Unhandled Promise Rejection: ${JSON.stringify(errorData, null, 2)}\n`);

    // Set exit code and exit immediately (log is already flushed synchronously)
    // Process manager (e.g., Railway) will restart the process
    process.exitCode = 1;
    process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
    const errorData = {
        timestamp: new Date().toISOString(),
        type: 'uncaughtException',
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
    };

    // Write synchronously to ensure logs are flushed before exit
    fs.writeSync(process.stderr.fd, `Uncaught Exception: ${JSON.stringify(errorData, null, 2)}\n`);

    // Set exit code and exit immediately (log is already flushed synchronously)
    // Process manager (e.g., Railway) will restart the process
    process.exitCode = 1;
    process.exit(1);
});

const port = process.env.PORT || 8080

// Wait for MongoDB connection before starting server
const startServer = async () => {
    try {
        // Ensure MongoDB is connected before starting server
        // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
        if (mongoose.connection.readyState === 0) {
            // Not connected, establish connection
            await mongoose.connect(mongoUri, mongooseOptions);
        }

        // Wait until connection is fully established (readyState === 1)
        // This handles cases where connection is in progress (state 2) or disconnecting (state 3)
        if (mongoose.connection.readyState !== 1) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    mongoose.connection.removeListener('connected', onConnected);
                    mongoose.connection.removeListener('error', onError);
                    reject(new Error('MongoDB connection timeout'));
                }, 10000);

                const onConnected = () => {
                    clearTimeout(timeout);
                    mongoose.connection.removeListener('connected', onConnected);
                    mongoose.connection.removeListener('error', onError);
                    resolve();
                };

                const onError = (err: Error) => {
                    clearTimeout(timeout);
                    mongoose.connection.removeListener('connected', onConnected);
                    mongoose.connection.removeListener('error', onError);
                    reject(err);
                };

                mongoose.connection.once('connected', onConnected);
                mongoose.connection.once('error', onError);
            });
        }

        // Final verification that connection is established
        if (mongoose.connection.readyState !== 1) {
            throw new Error('MongoDB connection not established');
        }

        // Migration: Drop old name_1 index if it exists (replaced by compound index)
        try {
            // db is guaranteed to be defined after connection verification (readyState === 1)
            // Type assertion is safe here because we've verified readyState === 1
            const db = mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;
            const collection = db.collection('rooms');
            const indexes = await collection.indexes();
            const oldNameIndex = indexes.find((idx: any) => idx.name === 'name_1');
            if (oldNameIndex) {
                await collection.dropIndex('name_1');
                log('Dropped old name_1 index from rooms collection');
            }
        } catch (error: any) {
            // Index might not exist or already dropped, ignore error
            if (error.code !== 27) { // 27 = IndexNotFound
                log('Warning: Could not drop old index:', error.message);
            }
        }

        // Note: Duplicate room cleanup removed (function not implemented)

        server.listen(port, () => {
            const host = process.env.HOST || 'localhost';
            const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
            const url = `${protocol}://${host}:${port}`;
            log(`Server running at ${url}`);
        });

        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                log(`Port ${port} is already in use. Please stop the other process or use a different port.`);
            } else {
                log('Server error:', error);
            }
            process.exit(1);
        });
    } catch (error) {
        log('Failed to start server:', error);
        if (error instanceof Error) {
            log('Error stack:', error.stack);
        }
        process.exit(1);
    }
};

startServer();

