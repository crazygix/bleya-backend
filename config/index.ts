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

  // Snapshot env vars set externally (by Railway, CI, shell, etc.) before any
  // .env file is read. These always win — .env files only fill in gaps. Files
  // later in `candidates` still override earlier ones via process.env.
  const externallySet = new Set(Object.keys(process.env));

  for (const candidate of candidates) {
    const filePath = path.join(projectRoot, candidate);
    if (!fs.existsSync(filePath)) continue;

    const parsed = dotenv.parse(fs.readFileSync(filePath));
    for (const [key, value] of Object.entries(parsed)) {
      if (externallySet.has(key)) continue;
      process.env[key] = value;
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
  'accessToken',
  'refreshToken',
  'id_token',
  'idToken',
  'identityToken',
  'authorizationCode',
  'challenge',
  'nonce',
  'rawNonce',
  'authorization',
  'cookie',
  'set-cookie',
  'secret',
  'api_key',
  'apikey',
  // User-generated content / profile PII — redacted so message text, bios and
  // handles never persist in request/response logs (keeps logs consistent with
  // the Art. 17 hard-delete; otherwise erased content lingers in the log sink).
  // 'message' is intentionally NOT redacted: it carries status/error strings,
  // not message content (message content lives under 'text').
  'text',
  'bio',
  'username',
  'replyText',
  'previewText',
  'parentMessageText',
  'lastMessageText',
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

function parsePathEnv(name: string, value: string | undefined, defaultValue: string): string {
  const candidate = (value && value.trim().length > 0 ? value : defaultValue).trim();
  if (!candidate.startsWith('/')) {
    throw new Error(`${name} must start with '/'`);
  }

  if (candidate.includes('://')) {
    throw new Error(`${name} must be a path, not a full URL`);
  }

  if (candidate.includes('?') || candidate.includes('#')) {
    throw new Error(`${name} must not include a query string or fragment`);
  }

  return trimTrailingSlash(candidate) || '/';
}

function deriveMountedRoutePath(name: string, absolutePath: string, mountPath: string): string {
  const normalizedMountPath = trimTrailingSlash(mountPath) || '/';
  if (absolutePath === normalizedMountPath) {
    return '/';
  }

  if (!absolutePath.startsWith(`${normalizedMountPath}/`)) {
    throw new Error(`${name} must start with '${normalizedMountPath}/'`);
  }

  return absolutePath.slice(normalizedMountPath.length);
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

const nodeEnv = bootNodeEnv;
const isProduction = nodeEnv === 'production';
const isLocal = nodeEnv === 'development';
const isTest = nodeEnv === 'test';

const port = parseNumberEnv('PORT', 8080);
const publicOrigin = isProduction ? 'https://api.bleyachat.com' : `http://localhost:${port}`;
const corsOrigins = isProduction
  ? ['https://bleyachat.com', 'https://www.bleyachat.com']
  : [];
const r2PublicBaseUrl = normalizeUrl(process.env.R2_PUBLIC_BASE_URL || '');
const accessTokenTtl = '1h';
const refreshTokenTtlDays = 365;
const googleAllowedAudiences = parseList(process.env.GOOGLE_ALLOWED_AUDIENCES);
const appleAllowedAudiences = parseList(process.env.APPLE_ALLOWED_AUDIENCES);
const appleAndroidRedirectPath = parsePathEnv(
  'APPLE_ANDROID_REDIRECT_PATH',
  process.env.APPLE_ANDROID_REDIRECT_PATH,
  '/v1/auth/apple/android/callback'
);
const appleAndroidCallbackRoute = deriveMountedRoutePath(
  'APPLE_ANDROID_REDIRECT_PATH',
  appleAndroidRedirectPath,
  '/v1/auth'
);
const passkeyExpectedOrigins = parseList(process.env.PASSKEY_EXPECTED_ORIGINS);
const passkeyRpId = process.env.PASSKEY_RP_ID?.trim() || 'bleyachat.com';
const passkeyRpName = process.env.PASSKEY_RP_NAME?.trim() || 'Bleya';
const citySearchDefaults = {
  defaultRadiusKm: 30,
  defaultLimit: 20,
  maxRadiusKm: 100,
  maxLimit: 50,
};

export const config = {
  nodeEnv,
  isProduction,
  isLocal,
  isTest,
  port,

  urls: {
    publicOrigin,
    corsOrigins,
  },

  mongoUri: requiredEnv('MONGODB_URI', { defaultInTest: 'mongodb://127.0.0.1:27017/bleya_test' }),
  jwtSecret: requiredEnv('JWT_SECRET', { defaultInTest: 'test-jwt-secret' }),

  accessTokenTtl,
  refreshTokenTtlDays,

  authProviders: {
    googleAllowedAudiences,
    appleAllowedAudiences,
    appleAndroidServiceId: process.env.APPLE_ANDROID_SERVICE_ID?.trim() || '',
    appleAndroidRedirectPath,
    appleAndroidCallbackRoute,
    androidPackageName: process.env.ANDROID_PACKAGE_NAME?.trim() || 'com.bleyachat',
  },

  push: {
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID?.trim() || '',
    firebaseClientEmail: process.env.FIREBASE_CLIENT_EMAIL?.trim() || '',
    firebasePrivateKey: process.env.FIREBASE_PRIVATE_KEY?.trim() || '',
  },

  passkey: {
    rpId: passkeyRpId,
    rpName: passkeyRpName,
    expectedOrigins: passkeyExpectedOrigins,
  },

  httpLogging: {
    bodyMode: parseHttpLogBodyMode('HTTP_LOG_BODY_MODE', isProduction ? 'errors' : 'all'),
    // Local development keeps payloads untouched for easier debugging.
    redactBodies: isLocal ? false : parseBooleanEnv('HTTP_LOG_BODY_REDACT', true),
    truncateBodies: isLocal ? false : parseBooleanEnv('HTTP_LOG_BODY_TRUNCATE', true),
    maxBodyBytes: parseNumberEnv('HTTP_LOG_BODY_MAX_BYTES', 4096),
    bodyRedactFields: DEFAULT_REDACT_FIELDS,
  },

  r2: {
    endpoint: process.env.R2_ENDPOINT || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucketName: process.env.R2_BUCKET_NAME || '',
    publicBaseUrl: r2PublicBaseUrl,
  },

  citySearch: citySearchDefaults,

  wikidata: {
    sparqlEndpoint: 'https://query.wikidata.org/sparql',
    coordinateToleranceKm: 15, // Increased from 5km to handle coordinate variations
  },

  pexels: {
    apiKey: process.env.PEXELS_API_KEY || '',
  },

  imageService: {
    provider: (process.env.IMAGE_SERVICE_PROVIDER || 'pexels') as 'wikidata' | 'pexels',
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

export function validateAppleAuthConfig(): { complete: boolean; errors: string[] } {
  const errors: string[] = [];
  const hasAndroidServiceId = config.authProviders.appleAndroidServiceId.length > 0;
  const hasAppleAudiences = config.authProviders.appleAllowedAudiences.length > 0;

  if (hasAndroidServiceId && !hasAppleAudiences) {
    errors.push('APPLE_ALLOWED_AUDIENCES must include the Apple Android Service ID when Apple Android sign-in is enabled.');
  }

  if (
    hasAndroidServiceId
    && hasAppleAudiences
    && !config.authProviders.appleAllowedAudiences.includes(config.authProviders.appleAndroidServiceId)
  ) {
    errors.push('APPLE_ANDROID_SERVICE_ID must also be listed in APPLE_ALLOWED_AUDIENCES.');
  }

  return {
    complete: errors.length === 0,
    errors,
  };
}

export function validatePushConfig(): { complete: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!config.push.firebaseProjectId) missing.push('FIREBASE_PROJECT_ID');
  if (!config.push.firebaseClientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!config.push.firebasePrivateKey) missing.push('FIREBASE_PRIVATE_KEY');

  return {
    complete: missing.length === 0,
    missing,
  };
}
