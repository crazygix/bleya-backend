import express, { Request, Response } from 'express'
import http from 'http'
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import cors from 'cors'
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

mongoose.connect(mongoUri);

mongoose.connection.on('connected', () => {
    log('MongoDB connected');
})

mongoose.connection.on('error', err => {
    log('MongoDB connection error:', err);
})

const app = express()

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

const port = process.env.PORT || 8080
server.listen(port, () => {
    const host = process.env.HOST || 'localhost';
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const url = `${protocol}://${host}:${port}`;
    log(`Server running at ${url}`);
})

