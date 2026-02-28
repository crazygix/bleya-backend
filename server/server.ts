import http from 'http';
import mongoose from 'mongoose';
import { pathToFileURL } from 'url';
import type { Express } from 'express';
import { setupSocketIO } from './socket.js';
import { createApp } from './app.js';
import logger from '../utils/logger.js';
import { config } from '../config/index.js';

export { createApp } from './app.js';

const mongooseOptions: mongoose.ConnectOptions = {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
    retryReads: true,
};

let processHandlersRegistered = false;
let mongooseHandlersRegistered = false;

function handleFatalError(error: Error, eventName: string, exitOnFatalError: boolean): void {
    logger.error(eventName, {
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
        },
    });

    if (exitOnFatalError) {
        process.exit(1);
    }
}

export function registerProcessHandlers(exitOnFatalError = true): void {
    if (processHandlersRegistered) {
        return;
    }

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

        if (exitOnFatalError) {
            process.exit(1);
        }
    });

    process.on('uncaughtException', (error: Error) => {
        handleFatalError(error, 'process.uncaught_exception', exitOnFatalError);
    });

    processHandlersRegistered = true;
}

export function registerMongooseConnectionHandlers(): void {
    if (mongooseHandlersRegistered) {
        return;
    }

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

    mongooseHandlersRegistered = true;
}

export async function waitForMongoConnection(): Promise<void> {
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
}

export interface CreateHttpServerOptions {
    app?: Express;
    withSocketIO?: boolean;
}

export function createHttpServer(options: CreateHttpServerOptions = {}): {
    app: Express;
    server: http.Server;
} {
    const app = options.app || createApp();
    const server = http.createServer(app);

    if (options.withSocketIO ?? true) {
        setupSocketIO(server);
    }

    return { app, server };
}

export interface StartServerOptions {
    app?: Express;
    port?: number;
    withSocketIO?: boolean;
    connectMongo?: boolean;
    registerFatalProcessHandlers?: boolean;
    exitOnFatalError?: boolean;
}

export interface StopServerOptions {
    disconnectMongo?: boolean;
}

async function listen(server: http.Server, port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onListening = () => {
            server.removeListener('error', onListenError);
            resolve();
        };

        const onListenError = (error: NodeJS.ErrnoException) => {
            server.removeListener('listening', onListening);
            reject(error);
        };

        server.once('listening', onListening);
        server.once('error', onListenError);
        server.listen(port);
    });
}

export async function startServer(options: StartServerOptions = {}): Promise<{
    app: Express;
    server: http.Server;
}> {
    const resolvedOptions = {
        port: options.port ?? config.port,
        withSocketIO: options.withSocketIO ?? true,
        connectMongo: options.connectMongo ?? true,
        registerFatalProcessHandlers: options.registerFatalProcessHandlers ?? true,
        exitOnFatalError: options.exitOnFatalError ?? true,
    };

    try {
        if (resolvedOptions.registerFatalProcessHandlers) {
            registerProcessHandlers(resolvedOptions.exitOnFatalError);
        }

        registerMongooseConnectionHandlers();

        if (resolvedOptions.connectMongo) {
            await waitForMongoConnection();

            if (mongoose.connection.readyState !== 1) {
                throw new Error('MongoDB connection not established');
            }
        }

        const { app, server } = createHttpServer({
            app: options.app,
            withSocketIO: resolvedOptions.withSocketIO,
        });

        await listen(server, resolvedOptions.port);

        server.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                logger.error('server.port_in_use', { port: resolvedOptions.port });
            } else {
                logger.error('server.error', {
                    code: error.code,
                    message: error.message,
                });
            }

            if (resolvedOptions.exitOnFatalError) {
                process.exit(1);
            }
        });

        const protocol = config.isProduction ? 'https' : 'http';
        const url = `${protocol}://${config.host}:${resolvedOptions.port}`;
        logger.info('server.started', { url });

        return { app, server };
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('server.start_failed', {
            message: normalizedError.message,
            stack: normalizedError.stack,
        });

        if (resolvedOptions.exitOnFatalError) {
            process.exit(1);
        }

        throw normalizedError;
    }
}

export async function stopServer(
    server: http.Server,
    options: StopServerOptions = {}
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });

    if (options.disconnectMongo && mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
    }
}

function isExecutedDirectly(): boolean {
    return process.argv.slice(1).some((arg) => {
        try {
            return import.meta.url === pathToFileURL(arg).href;
        } catch {
            return false;
        }
    });
}

if (isExecutedDirectly()) {
    void startServer();
}
