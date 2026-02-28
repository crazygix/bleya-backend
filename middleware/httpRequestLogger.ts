import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { HttpLogBodyMode, config } from '../config/index.js';
import logger from '../utils/logger.js';

interface AuthContext {
  userId?: string;
}

interface RequestWithLoggingContext extends Request {
  requestId?: string;
  user?: AuthContext;
}

const TRUNCATED_SUFFIX = '...[truncated]';
const REDACTED_VALUE = '[REDACTED]';

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

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, currentValue: unknown) => {
    if (typeof currentValue === 'bigint') {
      return currentValue.toString();
    }

    if (Buffer.isBuffer(currentValue)) {
      return `[Buffer ${currentValue.length} bytes]`;
    }

    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === 'object' && currentValue !== null) {
      if (seen.has(currentValue)) {
        return '[Circular]';
      }

      seen.add(currentValue);
    }

    return currentValue;
  });
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

function redactPayload(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
  ) {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    const redactedObject: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (redactedFieldSet.has(key.toLowerCase())) {
        redactedObject[key] = REDACTED_VALUE;
      } else {
        redactedObject[key] = redactPayload(nestedValue, seen);
      }
    }

    return redactedObject;
  }

  return String(value);
}

function transformPayloadForLogging(payload: unknown): { payload: unknown; truncated: boolean } {
  let transformedPayload = payload;

  if (config.httpLogging.redactBodies) {
    transformedPayload = redactPayload(transformedPayload);
  }

  if (!config.httpLogging.truncateBodies) {
    return { payload: transformedPayload, truncated: false };
  }

  if (typeof transformedPayload === 'string') {
    const truncated = truncateUtf8String(transformedPayload, config.httpLogging.maxBodyBytes);
    return {
      payload: truncated.value,
      truncated: truncated.truncated,
    };
  }

  if (transformedPayload === undefined) {
    return { payload: transformedPayload, truncated: false };
  }

  const serialized = safeStringify(transformedPayload);
  const truncated = truncateUtf8String(serialized, config.httpLogging.maxBodyBytes);

  if (!truncated.truncated) {
    return { payload: transformedPayload, truncated: false };
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
  const requestPath = req.originalUrl || req.url;
  const requestBody = req.body;
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
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  res.on('finish', () => {
    const statusCode = res.statusCode;
    const shouldIncludeBody = shouldLogBodies(config.httpLogging.bodyMode, statusCode);

    const baseContext: Record<string, unknown> = {
      requestId,
      method: req.method,
      path: requestPath,
      statusCode,
      durationMs: Date.now() - startedAt,
      userId: request.user?.userId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      requestSizeBytes: parseNumericHeader(req.headers['content-length']),
      responseSizeBytes: parseNumericHeader(res.getHeader('content-length')),
    };

    if (shouldIncludeBody) {
      if (hasMeaningfulRequestBody(requestBody)) {
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
  });

  next();
}
