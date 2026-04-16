import express, { Request, Response } from 'express';
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
import { errorHandler } from '../middleware/errorHandler.js';
import { httpRequestLogger } from '../middleware/httpRequestLogger.js';
import { buildCorsOptions } from '../utils/cors.js';
import logger from '../utils/logger.js';
import { config, validateAppleAuthConfig, validatePushConfig, validateR2Config } from '../config/index.js';

function createApiRouter(): express.Router {
    const apiV1Router = express.Router();
    apiV1Router.use('/auth', authRoutes);
    apiV1Router.use('/rooms', roomRoutes);
    apiV1Router.use('/users', userRoutes);
    apiV1Router.use('/messages', messageRoutes);
    apiV1Router.use('/notifications', notificationRoutes);
    apiV1Router.use('/cities', citiesRoutes);
    return apiV1Router;
}

export function validateRuntimeConfig(): void {
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

    const appleValidation = validateAppleAuthConfig();
    if (!appleValidation.complete) {
        if (config.isProduction) {
            throw new Error(`Apple authentication configuration is invalid in production. ${appleValidation.errors.join(' ')}`);
        }

        if (!config.isTest) {
            logger.warn('apple.auth.config.invalid', {
                errors: appleValidation.errors,
                note: 'Apple sign-in may fail until the configuration is corrected',
            });
        }
    }

    const pushValidation = validatePushConfig();
    if (!pushValidation.complete) {
        if (config.isProduction) {
            throw new Error(`Push configuration incomplete in production. Missing: ${pushValidation.missing.join(', ')}`);
        }

        if (!config.isTest) {
            logger.warn('push.config.incomplete', {
                missing: pushValidation.missing,
                note: 'Push notifications will be disabled until Firebase env vars are configured',
            });
        }
    }
}

export function createApp(): express.Express {
    validateRuntimeConfig();

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

    const v1Router = createApiRouter();
    app.use('/v1', v1Router);

    app.get('/', (_req: Request, res: Response) => {
        res.json({ message: 'Gde si bre zverino?' });
    });

    app.get('/health', (_req: Request, res: Response) => {
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

    return app;
}
