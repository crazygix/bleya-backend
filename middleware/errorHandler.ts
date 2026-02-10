import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { AppError, ErrorResponse, ErrorCode } from '../utils/errors.js';
import logger from '../utils/logger.js';

interface RequestWithUser extends Request {
  user?: {
    userId?: string;
  };
}

function hasErrorCode(value: unknown): value is { code: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { code?: unknown };
  return typeof candidate.code === 'string';
}

const logError = (error: Error, req: Request, context?: Record<string, unknown>) => {
  logger.error('request.error', {
    method: req.method,
    path: req.path,
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
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    },
    ...context,
  });
};

export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (error instanceof AppError) {
    const userId = (req as RequestWithUser).user?.userId;
    logError(error, req, { userId });

    const responseError: ErrorResponse['error'] = {
      code: error.code,
      message: error.message,
    };

    if (error.details !== undefined) {
      responseError.details = error.details;
    }

    const response: ErrorResponse = {
      error: responseError,
    };

    return res.status(error.statusCode).json(response);
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((err) => ({
      field: err.path,
      message: err.message,
    }));

    logError(error, req);

    const response: ErrorResponse = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details,
      },
    };

    return res.status(400).json(response);
  }

  if (error instanceof mongoose.Error.CastError) {
    logError(error, req);

    const response: ErrorResponse = {
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: `Invalid ${error.path}: ${error.value}`,
      },
    };

    return res.status(400).json(response);
  }

  if (hasErrorCode(error) && error.code === 'LIMIT_FILE_SIZE') {
    logError(error instanceof Error ? error : new Error('File size limit exceeded'), req);

    const response: ErrorResponse = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'File size exceeds the maximum allowed limit',
      },
    };

    return res.status(400).json(response);
  }

  logError(error, req, { unexpected: true });

  const response: ErrorResponse = {
    error: {
      code: ErrorCode.INTERNAL_ERROR,
      message: process.env.NODE_ENV === 'production'
        ? 'An unexpected error occurred'
        : error.message,
    },
  };

  return res.status(500).json(response);
};

export const asyncHandler = <TReq extends Request = Request>(
  fn: (req: TReq, res: Response, next: NextFunction) => Promise<unknown> | unknown
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req as TReq, res, next)).catch(next);
  };
};
