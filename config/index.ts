import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../.env');

dotenv.config({ path: envPath });

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
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

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: parseNumberEnv('PORT', 8080),
  host: process.env.HOST || 'localhost',

  mongoUri: requiredEnv('MONGODB_URI'),
  jwtSecret: requiredEnv('JWT_SECRET'),

  accessTokenTtl: (process.env.ACCESS_TOKEN_TTL || '1h') as string,
  refreshTokenTtlDays: parseNumberEnv('REFRESH_TOKEN_TTL_DAYS', 365),

  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  corsAllowAllInDev: process.env.CORS_ALLOW_ALL_IN_DEV === 'true',

  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: process.env.R2_BUCKET_NAME || '',
    publicUrl: process.env.R2_PUBLIC_URL || '',
    publicUrlDev: process.env.R2_PUBLIC_URL_DEV || '',
  },

  citySearch: {
    defaultRadiusKm: parseNumberEnv('CITY_SEARCH_RADIUS_KM', 100),
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
