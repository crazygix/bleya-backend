import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { Message } from '../models/Message.js';
import { User } from '../models/User.js';

interface AuthenticatedSocket {
    userId: string;
    roomId?: string;
}

export function setupSocketIO(server: HTTPServer) {
    const io = new SocketIOServer(server, {
        cors: {
            origin: true,
            credentials: true,
            methods: ['GET', 'POST'],
        },
    });

    // Authentication middleware for Socket.io
    io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return next(new Error('Authentication error: No token provided'));
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
            (socket as any).user = decoded;
            next();
        } catch (err) {
            next(new Error('Authentication error: Invalid token'));
        }
    });

    io.on('connection', (socket) => {
        const user = (socket as any).user as AuthenticatedSocket;

        console.log(`User ${user.userId} connected`);

        // Join a room
        socket.on('join_room', async (data: { roomId: string }) => {
            try {
                const { roomId } = data;

                // Verify room exists
                const room = await Room.findById(roomId);
                if (!room) {
                    socket.emit('error', { message: 'Room not found' });
                    return;
                }

                // Get user document and persist room join
                const userDoc = await User.findById(user.userId);
                if (!userDoc) {
                    socket.emit('error', { message: 'User not found' });
                    return;
                }

                const roomObjectId = new mongoose.Types.ObjectId(roomId);

                // Check if already in joinedRooms
                const isAlreadyJoined = userDoc.joinedRooms.some(
                    (id: any) => id.equals(roomObjectId)
                );

                if (!isAlreadyJoined) {
                    // Check limit
                    if (userDoc.joinedRooms.length >= 5) {
                        socket.emit('error', {
                            message: 'You can only join up to 5 rooms at a time'
                        });
                        return;
                    }

                    // Add to joined rooms
                    userDoc.joinedRooms.push(roomObjectId);
                    await userDoc.save();
                }

                // Leave previous room if any
                if (user.roomId) {
                    socket.leave(user.roomId);
                }

                // Join new room
                socket.join(roomId);
                user.roomId = roomId;

                // Get recent messages (last 50)
                const messages = await Message.find({ roomId })
                    .sort({ createdAt: -1 })
                    .limit(50)
                    .lean();

                // Fetch usernames for all unique user IDs
                const userIds = [...new Set(messages.map((msg: any) => msg.userId))];
                const users = await User.find({ _id: { $in: userIds } }).lean();
                const usernameMap = new Map(users.map((u: any) => [u._id.toString(), u.username || '']));

                // Format messages for client
                const formattedMessages = messages.reverse().map((msg: any) => ({
                    id: msg._id.toString(),
                    roomId: msg.roomId.toString(),
                    userId: msg.userId,
                    username: usernameMap.get(msg.userId) || '',
                    text: msg.text,
                    createdAt: msg.createdAt.toISOString(),
                }));

                // Send room info and messages
                socket.emit('room_joined', {
                    room: {
                        id: room._id.toString(),
                        name: room.name,
                        description: room.description,
                    },
                    messages: formattedMessages,
                });

                // Notify others in the room
                socket.to(roomId).emit('user_joined', {
                    userId: user.userId
                });

                console.log(`User ${user.userId} joined room ${room.name}`);
            } catch (error) {
                console.error('Error joining room:', error);
                socket.emit('error', { message: 'Failed to join room' });
            }
        });

        // Send a message
        socket.on('send_message', async (data: { text: string }) => {
            try {
                if (!user.roomId) {
                    socket.emit('error', { message: 'Not in a room' });
                    return;
                }

                const { text } = data;
                if (!text || text.trim().length === 0) {
                    return;
                }

                // Create message
                const message = new Message({
                    roomId: user.roomId,
                    userId: user.userId,
                    text: text.trim(),
                });

                await message.save();

                // Fetch username for the sender
                const senderUser = await User.findById(user.userId).lean();
                const username = senderUser?.username || '';

                // Populate room info for response
                const messageData = {
                    id: message._id.toString(),
                    roomId: message.roomId.toString(),
                    userId: message.userId,
                    username: username,
                    text: message.text,
                    createdAt: message.createdAt.toISOString(),
                };

                // Broadcast to all in the room
                io.to(user.roomId).emit('new_message', messageData);

                console.log(`Message from ${user.userId} in room ${user.roomId}`);
            } catch (error) {
                console.error('Error sending message:', error);
                socket.emit('error', { message: 'Failed to send message' });
            }
        });

        // Leave room
        socket.on('leave_room', async () => {
            if (user.roomId) {
                const roomId = user.roomId;
                user.roomId = undefined;

                socket.to(roomId).emit('user_left', { userId: user.userId });
                socket.leave(roomId);

                try {
                    const room = await Room.findById(roomId);
                    console.log(`User ${user.userId} left room ${room?.name}`);
                } catch (error) {
                    console.log(`User ${user.userId} left room ${roomId}`);
                }
            }
        });

        // Disconnect
        socket.on('disconnect', () => {
            if (user.roomId) {
                socket.to(user.roomId).emit('user_left', {
                    userId: user.userId,
                });
            }
            console.log(`User ${user.userId} disconnected`);
        });
    });

    return io;
}

