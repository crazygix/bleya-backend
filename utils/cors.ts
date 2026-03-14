import type { CorsOptions } from 'cors';
import { config } from '../config/index.js';

function parseAllowedOrigins(): string[] {
  return config.urls.corsOrigins;
}

export function buildCorsOptions(): CorsOptions {
  const allowed = parseAllowedOrigins();

  return {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    origin(origin, callback) {
      // Non-browser clients (mobile apps, curl, server-to-server) often send no Origin.
      if (!origin) return callback(null, true);

      if (!config.isProduction) return callback(null, true);

      if (allowed.includes(origin)) return callback(null, true);

      return callback(new Error('CORS: origin not allowed'));
    },
  };
}

type SocketCorsCallback = (err: Error | null, ok: boolean) => void;
type SocketCorsOrigin = (originHeader: string | undefined, callback: SocketCorsCallback) => void;

export interface SocketCorsOptions {
  origin: SocketCorsOrigin;
  credentials: boolean;
  methods: string[];
}

export function buildSocketCors(): SocketCorsOptions {
  const allowed = parseAllowedOrigins();

  // socket.io accepts `origin` as string|string[]|boolean|function depending on version.
  const origin = (originHeader: string | undefined, callback: (err: Error | null, ok: boolean) => void) => {
    if (!originHeader) return callback(null, true);
    if (!config.isProduction) return callback(null, true);
    if (allowed.includes(originHeader)) return callback(null, true);
    return callback(new Error('CORS: origin not allowed'), false);
  };

  return {
    origin,
    credentials: true,
    methods: ['GET', 'POST'],
  };
}
