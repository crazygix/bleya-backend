import express, { Request, Response } from 'express'
import http from 'http'
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import authRoutes from '../routes/auth.js'
import roomRoutes from '../routes/rooms.js'
import userRoutes from '../routes/users.js'
import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { setupSocketIO } from './socket.js'
import { errorHandler } from '../middleware/errorHandler.js'

dotenv.config();

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

mongoose.connect(mongoUri);

mongoose.connection.on('connected', () => {
    log('MongoDB connected');
})

mongoose.connection.on('error', err => {
    log('MongoDB connection error:', err);
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

app.get("/", (req: Request, res: Response) => {
    res.json({ message: "Gde si bre zverino?" })
})

// Health check endpoint for Railway
app.get("/health", (req: Request, res: Response) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        port: process.env.PORT || 8080
    });
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
    process.stderr.writeSync(`Unhandled Promise Rejection: ${JSON.stringify(errorData, null, 2)}\n`);

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
    process.stderr.writeSync(`Uncaught Exception: ${JSON.stringify(errorData, null, 2)}\n`);

    // Set exit code and exit immediately (log is already flushed synchronously)
    // Process manager (e.g., Railway) will restart the process
    process.exitCode = 1;
    process.exit(1);
});

const port = process.env.PORT || 8080
server.listen(port, () => {
    const host = process.env.HOST || 'localhost';
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const url = `${protocol}://${host}:${port}`;
    log(`Server running at ${url}`);
})

