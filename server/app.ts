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
import reportRoutes from '../routes/reports.js';
import adminRoutes from '../routes/admin.js';
import { errorHandler, notFoundHandler } from '../middleware/errorHandler.js';
import { httpRequestLogger } from '../middleware/httpRequestLogger.js';
import { buildCorsOptions } from '../utils/cors.js';
import { trustProxy } from '../utils/trustedProxy.js';
import logger from '../utils/logger.js';
import {
    config,
    MIN_ADMIN_API_KEY_LENGTH,
    nodeEnvWasUnset,
    validateAppleAuthConfig,
    validatePushConfig,
    validateR2Config,
} from '../config/index.js';
import { isAppleRevocationConfigured } from '../services/appleAuthService.js';

function createApiRouter(): express.Router {
    const apiV1Router = express.Router();
    apiV1Router.use('/auth', authRoutes);
    apiV1Router.use('/rooms', roomRoutes);
    apiV1Router.use('/users', userRoutes);
    apiV1Router.use('/messages', messageRoutes);
    apiV1Router.use('/notifications', notificationRoutes);
    apiV1Router.use('/cities', citiesRoutes);
    apiV1Router.use('/reports', reportRoutes);
    apiV1Router.use('/admin', adminRoutes);
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

    reportConfigGaps();
}

// Settings whose absence doesn't stop the server but silently breaks a feature.
// They are logged loudly at boot rather than failing it, so a deploy can never
// go down over them.
function reportConfigGaps(): void {
    if (config.isTest) {
        return;
    }

    const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
    if (nodeEnvWasUnset && onRailway) {
        logger.error('config.node_env_unset', {
            note: 'NODE_ENV is not set, so this hosted deploy runs with development settings (open CORS, unredacted logs). Set NODE_ENV=production.',
        });
    }

    if (config.admin.apiKeyTooShort) {
        logger.error('config.admin_key_too_short', {
            minLength: MIN_ADMIN_API_KEY_LENGTH,
            note: 'ADMIN_API_KEY is too short, so the admin API stays disabled.',
        });
    }

    if (!config.isProduction) {
        return;
    }

    const missing: string[] = [];
    if (config.authProviders.googleAllowedAudiences.length === 0) missing.push('GOOGLE_ALLOWED_AUDIENCES');
    if (config.authProviders.appleAllowedAudiences.length === 0) missing.push('APPLE_ALLOWED_AUDIENCES');
    if (!config.r2.publicBaseUrl) missing.push('R2_PUBLIC_BASE_URL');
    if (missing.length > 0) {
        logger.error('config.production_settings_missing', {
            missing,
            note: 'Sign-in for the matching provider fails, or uploaded image URLs point at the private R2 endpoint.',
        });
    }

    if (!isAppleRevocationConfigured()) {
        logger.error('apple.revocation.unconfigured', {
            note: 'Sign in with Apple tokens are not revoked on account deletion (App Store Guideline 5.1.1(v)). Set APPLE_REVOKE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY.',
        });
    }
}

export function createApp(): express.Express {
    validateRuntimeConfig();

    const app = express();

    // Production traffic arrives via Cloudflare and then Railway's edge proxy.
    // trustProxy skips exactly those hops so req.ip is the real client (see
    // utils/trustedProxy); a fixed hop count would stop at Cloudflare's IP.
    app.set('trust proxy', trustProxy);

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
    // No JSON or form endpoint needs more than a few KB (uploads are multipart).
    app.use(bodyParser.json({ limit: '100kb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '100kb' }));
    app.use(httpRequestLogger);

    const v1Router = createApiRouter();
    app.use('/v1', v1Router);

    app.get('/', (_req: Request, res: Response) => {
        res.json({ message: 'Gde si bre zverino?' });
    });

    // Keep the public payload minimal: it only needs to signal liveness to the
    // load balancer. Internal detail (env, port, memory, uptime, DB internals)
    // stays out of an unauthenticated endpoint.
    app.get('/health', (_req: Request, res: Response) => {
        const isDbConnected = mongoose.connection.readyState === 1;
        res.status(isDbConnected ? 200 : 503).json({
            status: isDbConnected ? 'ok' : 'degraded',
            timestamp: Date.now(),
        });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
