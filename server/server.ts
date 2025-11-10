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
    credentials: true, // Enable credentials for httpOnly cookies
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

// Mount room routes
app.use('/api/rooms', roomRoutes)

// Mount user routes
app.use('/api/users', userRoutes)

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

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

const server = http.createServer(app)

// Setup Socket.io
setupSocketIO(server)

const port = process.env.PORT || 8080
server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`)
})

