import { io as createSocketClient, Socket as ClientSocket } from 'socket.io-client';
import { getAuthToken } from './auth.js';

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();

    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

export async function connectSocket(baseUrl: string, userId: string): Promise<ClientSocket> {
    const socket = createSocketClient(baseUrl, {
        transports: ['websocket'],
        auth: {
            token: getAuthToken(userId),
        },
        forceNew: true,
        reconnection: false,
    });

    await waitFor(() => socket.connected);
    return socket;
}

// Waits for the server's answer instead of sleeping: join_room is done once
// room_joined (or an error) comes back. open_thread has no reply event, so it
// falls back to a short pause.
export function emitAndWait(socket: ClientSocket, event: string, payload: Record<string, unknown>): Promise<void> {
    if (event !== 'join_room') {
        socket.emit(event, payload);
        return new Promise((resolve) => setTimeout(resolve, 100));
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error('Timed out waiting for room_joined'));
        }, 3000);
        const onJoined = () => {
            cleanup();
            resolve();
        };
        const onError = (error: unknown) => {
            cleanup();
            reject(new Error(`join_room failed: ${JSON.stringify(error)}`));
        };
        const cleanup = () => {
            clearTimeout(timer);
            socket.off('room_joined', onJoined);
            socket.off('error', onError);
        };
        socket.on('room_joined', onJoined);
        socket.on('error', onError);
        socket.emit(event, payload);
    });
}
