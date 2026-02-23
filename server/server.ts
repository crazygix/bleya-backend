import express, { Request, Response } from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import authRoutes from '../routes/auth.js';
import roomRoutes from '../routes/rooms.js';
import userRoutes from '../routes/users.js';
import messageRoutes from '../routes/messages.js';
import notificationRoutes from '../routes/notifications.js';
import citiesRoutes from '../routes/cities.js';
import { setupSocketIO } from './socket.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { httpRequestLogger } from '../middleware/httpRequestLogger.js';
import { buildCorsOptions } from '../utils/cors.js';
import logger from '../utils/logger.js';
import { config, validateR2Config } from '../config/index.js';

const r2Validation = validateR2Config();
if (!r2Validation.complete) {
    if (config.isProduction) {
        throw new Error(`R2 configuration incomplete in production. Missing: ${r2Validation.missing.join(', ')}`);
    }

    logger.warn('r2.config.incomplete', {
        missing: r2Validation.missing,
        note: 'File uploads will fail until R2 env vars are configured',
    });
}

const mongooseOptions: mongoose.ConnectOptions = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
    retryReads: true,
};

mongoose.connection.on('connected', () => {
    logger.info('mongodb.connected');
});

mongoose.connection.on('error', (err) => {
    logger.error('mongodb.error', {
        message: err.message,
        name: err.name,
    });
});

mongoose.connection.on('disconnected', () => {
    logger.warn('mongodb.disconnected');
});

const app = express();

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors(buildCorsOptions()));
app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(httpRequestLogger);

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/users', userRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/cities', citiesRoutes);

app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'Gde si bre zverino?' });
});

app.get('/health', async (_req: Request, res: Response) => {
    const health = {
        status: 'ok',
        timestamp: Date.now(),
        environment: config.nodeEnv,
        port: config.port,
        mongodb: {
            status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            readyState: mongoose.connection.readyState,
        },
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        },
        uptime: Math.round(process.uptime()),
    };

    const statusCode = mongoose.connection.readyState === 1 ? 200 : 503;
    res.status(statusCode).json(health);
});

app.use(errorHandler);

const server = http.createServer(app);
setupSocketIO(server);

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));

    logger.error('process.unhandled_rejection', {
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
        promiseType: Object.prototype.toString.call(promise),
    });

    process.exit(1);
});

process.on('uncaughtException', (error: Error) => {
    logger.error('process.uncaught_exception', {
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
    });

    process.exit(1);
});

const waitForMongoConnection = async (): Promise<void> => {
    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(config.mongoUri, mongooseOptions);
    }

    if (mongoose.connection.readyState === 1) {
        return;
    }

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
};

const startServer = async () => {
    try {
        await waitForMongoConnection();

        if (mongoose.connection.readyState !== 1) {
            throw new Error('MongoDB connection not established');
        }

        server.listen(config.port, () => {
            const protocol = config.isProduction ? 'https' : 'http';
            const url = `${protocol}://${config.host}:${config.port}`;
            logger.info('server.started', { url });
        });

        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                logger.error('server.port_in_use', { port: config.port });
            } else {
                logger.error('server.error', {
                    code: error.code,
                    message: error.message,
                });
            }
            process.exit(1);
        });
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('server.start_failed', {
            message: normalizedError.message,
            stack: normalizedError.stack,
        });
        process.exit(1);
    }
};

startServer();
