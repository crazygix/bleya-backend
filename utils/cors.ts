import type { CorsOptions } from 'cors';

function parseAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildCorsOptions(): CorsOptions {
  const allowed = parseAllowedOrigins();
  const allowAllInDev = process.env.CORS_ALLOW_ALL_IN_DEV === 'true';
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';

  return {
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    origin(origin, callback) {
      // Non-browser clients (mobile apps, curl, server-to-server) often send no Origin.
      if (!origin) return callback(null, true);

      if (isDev && allowAllInDev) return callback(null, true);

      if (allowed.includes(origin)) return callback(null, true);

      return callback(new Error('CORS: origin not allowed'));
    },
  };
}

export function buildSocketCors(): { origin: any; credentials: boolean; methods: string[] } {
  const allowed = parseAllowedOrigins();
  const allowAllInDev = process.env.CORS_ALLOW_ALL_IN_DEV === 'true';
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';

  // socket.io accepts `origin` as string|string[]|boolean|function depending on version.
  const origin = (originHeader: string | undefined, callback: (err: Error | null, ok: boolean) => void) => {
    if (!originHeader) return callback(null, true);
    if (isDev && allowAllInDev) return callback(null, true);
    if (allowed.includes(originHeader)) return callback(null, true);
    return callback(new Error('CORS: origin not allowed'), false);
  };

  return {
    origin,
    credentials: true,
    methods: ['GET', 'POST'],
  };
}

