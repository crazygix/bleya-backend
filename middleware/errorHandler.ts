import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AppError, ErrorResponse, ErrorCode } from '../utils/errors.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { getLoggablePath } from '../utils/requestPath.js';

interface RequestWithUser extends Request {
  requestId?: string;
  user?: {
    userId?: string;
  };
}

// Copy that is sent straight to clients. Keep it friendly and free of any
// internal or technical detail (config state, field names, raw values, stack
// traces) — that information belongs in the logs, never in the response body.
const GENERIC_SERVER_ERROR_MESSAGE =
  'Something went wrong on our end. Please try again in a bit.';

const INVALID_REQUEST_MESSAGE =
  "That request wasn't quite right. Please check it and try again.";

const UPLOAD_ERROR_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: 'That file is too large. Please choose a smaller one.',
  LIMIT_FILE_COUNT: 'Too many files at once. Please upload fewer.',
  LIMIT_PART_COUNT: "We couldn't process that upload. Please try again.",
  LIMIT_UNEXPECTED_FILE: "We couldn't accept that upload. Please try again.",
};
const GENERIC_UPLOAD_ERROR_MESSAGE = "We couldn't process that upload. Please try again.";

interface LogErrorOptions {
  level?: 'warn' | 'error';
  includeStack?: boolean;
  userId?: string;
  unexpected?: boolean;
}

// Multer attaches `name === 'MulterError'` and a string `code` describing the
// limit that was hit. Detect by shape so we don't have to import multer here.
function isMulterError(error: unknown): error is { name: string; code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'MulterError' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

// body-parser raises errors (malformed JSON, oversized payloads, bad charset)
// that carry a string `type` and a 4xx `status`/`statusCode`. These are client
// mistakes, not server faults, so report them as such instead of as a 500.
function getBodyParserStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (typeof candidate.type !== 'string') {
    return null;
  }

  const status =
    typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : typeof candidate.status === 'number'
        ? candidate.status
        : null;

  if (status === null || status < 400 || status >= 500) {
    return null;
  }

  return status;
}

// MongoServerError for a unique-index violation carries the numeric code 11000.
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

const logError = (error: Error, req: Request, options: LogErrorOptions = {}) => {
  const { level = 'error', includeStack = true, userId, unexpected } = options;
  const request = req as RequestWithUser;

  logger[level]('request.error', {
    requestId: request.requestId,
    method: req.method,
    path: getLoggablePath(req),
    error: {
      name: error.name,
      message: error.message,
      ...(error instanceof AppError
        ? {
            code: error.code,
            statusCode: error.statusCode,
            details: error.details,
          }
        : {}),
      // Logs are internal only, so always keep the stack for anything we
      // couldn't classify as an expected client error.
      stack: includeStack ? error.stack : undefined,
    },
    ...(userId ? { userId } : {}),
    ...(unexpected ? { unexpected: true } : {}),
  });
};

const sendError = (
  res: Response,
  statusCode: number,
  code: ErrorCode,
  message: string,
  details?: unknown
): Response => {
  const responseError: ErrorResponse['error'] = { code, message };

  if (details !== undefined) {
    responseError.details = details;
  }

  const response: ErrorResponse = { error: responseError };
  return res.status(statusCode).json(response);
};

export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const userId = (req as RequestWithUser).user?.userId;

  if (error instanceof AppError) {
    const isServerError = error.statusCode >= 500;

    logError(error, req, {
      level: isServerError ? 'error' : 'warn',
      includeStack: isServerError,
      userId,
    });

    // Server-side AppErrors (500s) can carry internal detail in their message
    // (e.g. "X is not configured on the server"). Never relay that to the
    // client — the code still tells them what category of failure occurred.
    if (isServerError) {
      return sendError(res, error.statusCode, error.code, GENERIC_SERVER_ERROR_MESSAGE);
    }

    return sendError(res, error.statusCode, error.code, error.message, error.details);
  }

  if (error instanceof mongoose.Error.ValidationError) {
    logError(error, req, { level: 'warn', includeStack: false, userId });

    // Mongoose validator messages are technical ("Path `x` is required");
    // surface friendly copy and keep the field detail in the logs instead.
    return sendError(
      res,
      400,
      ErrorCode.VALIDATION_ERROR,
      "Some of the details you entered aren't valid. Please check and try again."
    );
  }

  if (error instanceof mongoose.Error.CastError) {
    logError(error, req, { level: 'warn', includeStack: false, userId });

    // Don't echo the raw rejected value (error.value) back to the client.
    return sendError(res, 400, ErrorCode.INVALID_INPUT, INVALID_REQUEST_MESSAGE);
  }

  if (isDuplicateKeyError(error)) {
    logError(error, req, { level: 'warn', includeStack: false, userId });

    return sendError(
      res,
      409,
      ErrorCode.ALREADY_EXISTS,
      'That already exists. Please try something different.'
    );
  }

  if (isMulterError(error)) {
    logError(error, req, { level: 'warn', includeStack: false, userId });

    const message = UPLOAD_ERROR_MESSAGES[error.code] ?? GENERIC_UPLOAD_ERROR_MESSAGE;
    return sendError(res, 400, ErrorCode.VALIDATION_ERROR, message);
  }

  const bodyParserStatus = getBodyParserStatus(error);
  if (bodyParserStatus !== null) {
    logError(error, req, { level: 'warn', includeStack: false, userId });

    // Use our own copy rather than the parser's technical message
    // (e.g. "Unexpected token } in JSON at position 5").
    const message =
      bodyParserStatus === 413
        ? 'That request is too large. Please try again with less data.'
        : "We couldn't read that request. Please check the format and try again.";
    const code =
      bodyParserStatus === 413 ? ErrorCode.VALIDATION_ERROR : ErrorCode.INVALID_INPUT;

    return sendError(res, bodyParserStatus, code, message);
  }

  // Anything reaching here is unexpected/unhandled: log it in full (including
  // the stack) and return a safe, generic message to the client.
  logError(error, req, { level: 'error', includeStack: true, unexpected: true, userId });

  return sendError(
    res,
    500,
    ErrorCode.INTERNAL_ERROR,
    // Real messages are exposed only outside production to aid local debugging;
    // production clients always receive the generic copy.
    config.isProduction ? GENERIC_SERVER_ERROR_MESSAGE : error.message
  );
};

// Catch-all for routes that matched no handler. Returns the standard error
// shape instead of Express's default HTML 404 page.
export const notFoundHandler = (req: Request, res: Response) => {
  return sendError(
    res,
    404,
    ErrorCode.NOT_FOUND,
    "We couldn't find what you were looking for."
  );
};

export const asyncHandler = <TReq extends Request = Request>(
  fn: (req: TReq, res: Response, next: NextFunction) => Promise<unknown> | unknown
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as TReq, res, next)).catch(next);
  };
};
