import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findProjectRoot(startDir: string): string {
  let current = startDir;

  while (true) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

function loadEnvFiles(projectRoot: string, nodeEnv: string): void {
  const candidates = [
    '.env',
    `.env.${nodeEnv}`,
    '.env.local',
    `.env.${nodeEnv}.local`,
  ];

  for (const candidate of candidates) {
    const filePath = path.join(projectRoot, candidate);
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, override: true });
    }
  }
}

const bootNodeEnv = process.env.NODE_ENV || 'development';
const projectRoot = findProjectRoot(__dirname);
loadEnvFiles(projectRoot, bootNodeEnv);

export type HttpLogBodyMode = 'off' | 'errors' | 'all';

const HTTP_LOG_BODY_MODES: HttpLogBodyMode[] = ['off', 'errors', 'all'];
const DEFAULT_REDACT_FIELDS = [
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'api_key',
  'apikey',
  'phone',
  'phone_number',
  'phonenumber',
  'phoneNumber',
];

function requiredEnv(name: string, options?: { defaultInTest?: string }): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    if (isTest && options?.defaultInTest) {
      return options.defaultInTest;
    }
    throw new Error(`${name} environment variable is not set`);
  }
  return value;
}

function parseNumberEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }

  return parsed;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  throw new Error(`${name} must be a boolean (true/false)`);
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeUrl(value: string): string {
  return trimTrailingSlash(value.trim());
}

function buildOrigin(protocol: string, host: string, port: number): string {
  return `${protocol}://${host}:${port}`;
}

function parseHttpLogBodyMode(name: string, defaultValue: HttpLogBodyMode): HttpLogBodyMode {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (!HTTP_LOG_BODY_MODES.includes(normalized as HttpLogBodyMode)) {
    throw new Error(`${name} must be one of: ${HTTP_LOG_BODY_MODES.join(', ')}`);
  }

  return normalized as HttpLogBodyMode;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const isLocal = nodeEnv === 'development';
const isTest = nodeEnv === 'test';

const bodyRedactFields = parseList(process.env.HTTP_LOG_BODY_REDACT_FIELDS);
const port = parseNumberEnv('PORT', 8080);
const appHost = process.env.APP_HOST?.trim() || 'localhost';
const defaultProtocol = isProduction ? 'https' : 'http';
const publicOrigin =
  normalizeUrl(process.env.PUBLIC_ORIGIN || buildOrigin(defaultProtocol, appHost, port));
const apiBaseUrl = normalizeUrl(process.env.API_BASE_URL || `${publicOrigin}/v1`);
const clientOrigin = normalizeUrl(process.env.CLIENT_ORIGIN || publicOrigin);
const configuredCorsOrigins = parseOrigins(process.env.CORS_ORIGINS);
const corsOrigins = configuredCorsOrigins.length > 0 ? configuredCorsOrigins : [clientOrigin];
const r2PublicBaseUrl = normalizeUrl(process.env.R2_PUBLIC_BASE_URL || '');

export const config = {
  nodeEnv,
  isProduction,
  isLocal,
  isTest,
  port,

  urls: {
    publicOrigin,
    apiBaseUrl,
    clientOrigin,
    corsOrigins,
  },

  mongoUri: requiredEnv('MONGODB_URI', { defaultInTest: 'mongodb://127.0.0.1:27017/bleya_test' }),
  jwtSecret: requiredEnv('JWT_SECRET', { defaultInTest: 'test-jwt-secret' }),

  accessTokenTtl: (process.env.ACCESS_TOKEN_TTL || '1h') as string,
  refreshTokenTtlDays: parseNumberEnv('REFRESH_TOKEN_TTL_DAYS', 365),

  corsAllowAllInDev: process.env.CORS_ALLOW_ALL_IN_DEV === 'true',

  httpLogging: {
    bodyMode: parseHttpLogBodyMode('HTTP_LOG_BODY_MODE', isProduction ? 'errors' : 'all'),
    // Local development keeps payloads untouched for easier debugging.
    redactBodies: isLocal ? false : parseBooleanEnv('HTTP_LOG_BODY_REDACT', true),
    truncateBodies: isLocal ? false : parseBooleanEnv('HTTP_LOG_BODY_TRUNCATE', true),
    maxBodyBytes: parseNumberEnv('HTTP_LOG_BODY_MAX_BYTES', 4096),
    bodyRedactFields: bodyRedactFields.length > 0 ? bodyRedactFields : DEFAULT_REDACT_FIELDS,
  },

  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: process.env.R2_BUCKET_NAME || '',
    publicBaseUrl: r2PublicBaseUrl,
  },

  citySearch: {
    defaultRadiusKm: parseNumberEnv('CITY_SEARCH_RADIUS_KM', 30),
    defaultLimit: parseNumberEnv('CITY_SEARCH_LIMIT', 20),
    maxRadiusKm: parseNumberEnv('CITY_SEARCH_MAX_RADIUS_KM', 100),
    maxLimit: parseNumberEnv('CITY_SEARCH_MAX_LIMIT', 50),
  },

  wikidata: {
    sparqlEndpoint: 'https://query.wikidata.org/sparql',
    coordinateToleranceKm: 15, // Increased from 5km to handle coordinate variations
  },

  pexels: {
    apiKey: process.env.PEXELS_API_KEY || '',
  },

  imageService: {
    provider: (process.env.IMAGE_SERVICE_PROVIDER || 'wikidata') as 'wikidata' | 'pexels',
  },
};

export function validateR2Config(): { complete: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!config.r2.endpoint) missing.push('R2_ENDPOINT');
  if (!config.r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
  if (!config.r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  if (!config.r2.bucketName) missing.push('R2_BUCKET_NAME');

  return {
    complete: missing.length === 0,
    missing,
  };
}
