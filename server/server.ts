import express, { Request, Response } from 'express'
import http from 'http'
import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import compression from 'compression'
import cors from 'cors'
import authRoutes from '../routes/auth.js'
import mongoose from 'mongoose'
import dotenv from 'dotenv';

dotenv.config();

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    throw new Error('MONGODB_URI environment variable is not set');
}

mongoose.connect(mongoUri);

mongoose.connection.on('connected', () => {
    console.log('MongoDB connected')
})

mongoose.connection.on('error', err => {
    console.error('MongoDB connection error:', err)
})

const app = express()

// CORS configuration - more permissive for production
app.use(cors({
    origin: true, // Allow all origins in production
    credentials: false, // Disable credentials for better compatibility
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}))

app.use(compression())
app.use(cookieParser())

// Body parser configuration - more explicit for production
app.use(bodyParser.json({ limit: '10mb' }))
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }))

// Add request logging for debugging
app.use((req: Request, res: Response, next) => {
    console.log(`${req.method} ${req.path} - Body:`, req.body)
    next()
})

// Mount auth routes
app.use('/api/auth', authRoutes)

app.get("/", (req: Request, res: Response) => {
    res.send("Gde si bre zverino?")
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

const server = http.createServer(app)
const port = process.env.PORT || 8080
server.listen(port, () => {
    console.log(`Server running on port ${port}`)
})

