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
app.use(cors({
    credentials: true
}))

app.use(compression())
app.use(cookieParser())
app.use(bodyParser.json())

// Mount auth routes
app.use('/api/auth', authRoutes)

app.get("/", (req: Request, res: Response) => {
    res.send("Gde si bre zverino")
})

const server = http.createServer(app)
server.listen(8080, () => {
    console.log('Server running on http://localhost:8080')
})

