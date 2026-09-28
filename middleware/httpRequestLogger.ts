import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { HttpLogBodyMode, config } from '../config/index.js';
import logger from '../utils/logger.js';
import { getLoggablePath, getPathname } from '../utils/requestPath.js';
import { getClientIp } from '../utils/trustedProxy.js';

interface AuthContext {
  userId?: string;
}

interface RequestWithLoggingContext extends Request {
  requestId?: string;
  user?: AuthContext;
}

const TRUNCATED_SUFFIX = '...[truncated]';
const REDACTED_VALUE = '[REDACTED]';

// Request bodies are client-controlled, so anything we walk or serialize for a
// log line is bounded (depth, array length, key count).
const MAX_LOG_DEPTH = 8;
const MAX_LOG_ARRAY_ITEMS = 50;
const MAX_LOG_OBJECT_KEYS = 50;

// Routes whose request bodies are never logged: the Apple Android callback
// carries the authorization code, id_token and the user's name/email.
const BODY_LOG_EXCLUDED_PATHS = new Set([config.authProviders.appleAndroidRedirectPath]);

const redactedFieldSet = new Set(config.httpLogging.bodyRedactFields.map((field) => field.toLowerCase()));

function shouldLogBodies(mode: HttpLogBodyMode, statusCode: number): boolean {
  if (mode === 'all') {
    return true;
  }

  if (mode === 'errors') {
    return statusCode >= 400;
  }

  return false;
}

function parseNumericHeader(value: string | string[] | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    if (!first) {
      return undefined;
    }

    const parsed = Number(first);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function truncateUtf8String(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const sourceBuffer = Buffer.from(value, 'utf8');
  if (sourceBuffer.byteLength <= maxBytes) {
    return { value, truncated: false };
  }

  const sliced = sourceBuffer.subarray(0, maxBytes).toString('utf8');
  return {
    value: `${sliced}${TRUNCATED_SUFFIX}`,
    truncated: true,
  };
}

/**
 * Copies a payload into a log-safe shape: depth, array length and key count are
 * capped, circular references are cut, and (when `redact` is on) sensitive keys
 * are masked. The result is plain data that JSON serialization can't choke on.
 */
function boundPayload(
  value: unknown,
  redact: boolean,
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (depth >= MAX_LOG_DEPTH) {
    return '[MaxDepth]';
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_LOG_ARRAY_ITEMS)
      .map((entry) => boundPayload(entry, redact, seen, depth + 1));
    if (value.length > MAX_LOG_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_LOG_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const boundedObject: Record<string, unknown> = {};
  for (const [key, nestedValue] of entries.slice(0, MAX_LOG_OBJECT_KEYS)) {
    boundedObject[key] = redact && redactedFieldSet.has(key.toLowerCase())
      ? REDACTED_VALUE
      : boundPayload(nestedValue, redact, seen, depth + 1);
  }
  if (entries.length > MAX_LOG_OBJECT_KEYS) {
    boundedObject['[truncatedKeys]'] = entries.length - MAX_LOG_OBJECT_KEYS;
  }

  return boundedObject;
}

function transformPayloadForLogging(payload: unknown): { payload: unknown; truncated: boolean } {
  const boundedPayload = boundPayload(payload, config.httpLogging.redactBodies);

  if (!config.httpLogging.truncateBodies) {
    return { payload: boundedPayload, truncated: false };
  }

  if (typeof boundedPayload === 'string') {
    const truncated = truncateUtf8String(boundedPayload, config.httpLogging.maxBodyBytes);
    return {
      payload: truncated.value,
      truncated: truncated.truncated,
    };
  }

  if (boundedPayload === undefined) {
    return { payload: boundedPayload, truncated: false };
  }

  const serialized = JSON.stringify(boundedPayload);
  const truncated = truncateUtf8String(serialized, config.httpLogging.maxBodyBytes);

  if (!truncated.truncated) {
    return { payload: boundedPayload, truncated: false };
  }

  return {
    payload: truncated.value,
    truncated: true,
  };
}

function hasMeaningfulRequestBody(payload: unknown): boolean {
  if (payload === undefined || payload === null) {
    return false;
  }

  if (typeof payload === 'string') {
    return payload.length > 0;
  }

  if (Array.isArray(payload)) {
    return payload.length > 0;
  }

  if (typeof payload === 'object') {
    return Object.keys(payload as Record<string, unknown>).length > 0;
  }

  return true;
}

export function httpRequestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = crypto.randomUUID();
  const request = req as RequestWithLoggingContext;
  request.requestId = requestId;

  res.setHeader('x-request-id', requestId);

  const startedAt = Date.now();
  const requestPath = getLoggablePath(req);
  const clientIp = getClientIp(req);
  const requestBody = req.body;
  const logRequestBody = !BODY_LOG_EXCLUDED_PATHS.has(getPathname(req));
  let responseBody: unknown;

  const originalJson = res.json.bind(res) as (body?: unknown) => Response;
  const originalSend = res.send.bind(res) as (body?: unknown) => Response;

  res.json = ((body?: unknown): Response => {
    responseBody = body;
    return originalJson(body);
  }) as Response['json'];

  res.send = ((body?: unknown): Response => {
    if (responseBody === undefined) {
      responseBody = body;
    }

    return originalSend(body);
  }) as Response['send'];

  logger.info('http.request.start', {
    requestId,
    method: req.method,
    path: requestPath,
    ip: clientIp,
    userAgent: req.get('user-agent'),
  });

  res.on('finish', () => {
    // Logging must never be able to take the process down: this runs outside
    // any request error handling, so an exception here would be uncaught.
    try {
      const statusCode = res.statusCode;
      const shouldIncludeBody = shouldLogBodies(config.httpLogging.bodyMode, statusCode);

      const baseContext: Record<string, unknown> = {
        requestId,
        method: req.method,
        path: requestPath,
        statusCode,
        durationMs: Date.now() - startedAt,
        userId: request.user?.userId,
        ip: clientIp,
        userAgent: req.get('user-agent'),
        requestSizeBytes: parseNumericHeader(req.headers['content-length']),
        responseSizeBytes: parseNumericHeader(res.getHeader('content-length')),
      };

      if (shouldIncludeBody) {
        if (logRequestBody && hasMeaningfulRequestBody(requestBody)) {
          const transformedRequestBody = transformPayloadForLogging(requestBody);
          baseContext.requestBody = transformedRequestBody.payload;
          if (transformedRequestBody.truncated) {
            baseContext.requestBodyTruncated = true;
          }
        }

        if (responseBody !== undefined) {
          const transformedResponseBody = transformPayloadForLogging(responseBody);
          baseContext.responseBody = transformedResponseBody.payload;
          if (transformedResponseBody.truncated) {
            baseContext.responseBodyTruncated = true;
          }
        }
      }

      logger.info('http.request.finish', baseContext);
    } catch (error) {
      try {
        logger.warn('http.request.log_failed', {
          requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Nothing else we can safely do.
      }
    }
  });

  next();
}
