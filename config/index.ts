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
  // Tests read only .env.test(.local): the shared .env / .env.local files hold
  // live Firebase, R2, Pexels and Atlas credentials that a test must never use.
  const candidates = nodeEnv === 'test'
    ? ['.env.test', '.env.test.local']
    : [
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

// Captured before defaulting so startup can warn when a hosted deploy forgot to
// set NODE_ENV (it would otherwise silently run with development settings).
export const nodeEnvWasUnset = !process.env.NODE_ENV || process.env.NODE_ENV.trim().length === 0;
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
// Admin keys shorter than this are refused (admin stays disabled) — the key is
// the only thing guarding the moderation API.
export const MIN_ADMIN_API_KEY_LENGTH = 32;
const rawAdminApiKey = process.env.ADMIN_API_KEY?.trim() || '';
const adminApiKeyTooShort = rawAdminApiKey.length > 0 && rawAdminApiKey.length < MIN_ADMIN_API_KEY_LENGTH;
const adminApiKey = adminApiKeyTooShort ? '' : rawAdminApiKey;
const adminDashboardOrigin = normalizeUrl(process.env.ADMIN_DASHBOARD_ORIGIN || '');
const corsOrigins = isProduction
  ? ['https://bleyachat.com', 'https://www.bleyachat.com', ...(adminDashboardOrigin ? [adminDashboardOrigin] : [])]
  : [];
const r2PublicBaseUrl = normalizeUrl(process.env.R2_PUBLIC_BASE_URL || '');
const accessTokenTtl = '1h';
const refreshTokenTtlDays = 365;
// Each refresh replaces the refresh token, and the replaced one stays usable
// until its successor is first used, for at most previousRefreshTokenTtlMs.
// Within refreshTokenReuseWindowMs of the replacement it gets only a new access
// token (two refreshes sent at once); after that it gets a new refresh token
// too (the response with the successor never arrived).
const refreshTokenReuseWindowMs = 30_000;
const previousRefreshTokenTtlMs = 7 * 24 * 60 * 60 * 1000;
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
const jwtSecret = requiredEnv('JWT_SECRET', { defaultInTest: 'test-jwt-secret' });
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
  jwtSecret,

  // Keys the HMAC used to remember banned sign-in identities after account
  // deletion. Defaults to a value derived from JWT_SECRET; set it explicitly so
  // rotating JWT_SECRET doesn't silently forget bans.
  identityHashSecret: process.env.IDENTITY_HASH_SECRET?.trim() || `banned-identity:${jwtSecret}`,

  accessTokenTtl,
  refreshTokenTtlDays,
  refreshTokenReuseWindowMs,
  previousRefreshTokenTtlMs,

  authProviders: {
    googleAllowedAudiences,
    appleAllowedAudiences,
    // When true, provider sign-in requires a rawNonce whose hash matches the ID
    // token's nonce claim. Off until the mobile app sends a nonce for both
    // Google and Apple — turning it on earlier would reject every sign-in.
    requireNonce: parseBooleanEnv('REQUIRE_PROVIDER_NONCE', false),
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

  // Sign in with Apple server-to-server (token revocation on account deletion,
  // Apple Guideline 5.1.1(v)). All four are required to enable it; empty disables.
  apple: {
    revokeClientId: process.env.APPLE_REVOKE_CLIENT_ID?.trim() || '',
    teamId: process.env.APPLE_TEAM_ID?.trim() || '',
    keyId: process.env.APPLE_KEY_ID?.trim() || '',
    privateKey: (process.env.APPLE_PRIVATE_KEY || '').trim(),
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

  // Moderation / admin API. `apiKey` gates /v1/admin (fail-closed: empty = admin
  // disabled). `dashboardOrigin` is added to the CORS allowlist so a separate web
  // admin panel can call the API from the browser.
  admin: {
    apiKey: adminApiKey,
    apiKeyTooShort: adminApiKeyTooShort,
    dashboardOrigin: adminDashboardOrigin,
  },

  socket: {
    // Disconnect a socket when the access token it connected with expires.
    // Off until the mobile app reconnects with a fresh token on its own
    // (otherwise realtime would drop every hour).
    enforceTokenExpiry: parseBooleanEnv('SOCKET_ENFORCE_TOKEN_EXPIRY', false),
    // Newest connection wins; older sockets beyond this are disconnected.
    maxConnectionsPerUser: parseNumberEnv('SOCKET_MAX_CONNECTIONS_PER_USER', 5),
  },

  reports: {
    // Reports (with the copy of a reported message) are deleted automatically
    // this long after they are filed. The privacy policy states two years.
    retentionDays: parseNumberEnv('REPORT_RETENTION_DAYS', 730),
  },

  auditLog: {
    // Moderation-action records are deleted automatically this long after the
    // action. The privacy policy states two years.
    retentionDays: parseNumberEnv('AUDIT_LOG_RETENTION_DAYS', 730),
  },

  // Proactive content filtering at post time. blockedTerms extends the built-in
  // text blocklist (comma-separated CONTENT_BLOCKLIST). imageModeration plugs in
  // an image-safety provider; empty = disabled (uploads allowed).
  contentFilter: {
    blockedTerms: parseList(process.env.CONTENT_BLOCKLIST),
    imageModeration: {
      provider: process.env.IMAGE_MODERATION_PROVIDER?.trim() || '',
      apiKey: process.env.IMAGE_MODERATION_API_KEY?.trim() || '',
      apiSecret: process.env.IMAGE_MODERATION_API_SECRET?.trim() || '',
    },
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
