import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorResponse, ErrorCode } from '../utils/errors.js';
import mongoose from 'mongoose';

// Helper function for structured logging
const logError = (error: Error, req: Request, context?: any) => {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    method: req.method,
    path: req.path,
    error: {
      name: error.name,
      message: error.message,
      ...(error instanceof AppError && {
        code: error.code,
        statusCode: error.statusCode,
        details: error.details,
      }),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    },
    ...context,
  };
  console.error(JSON.stringify(logData, null, 2));
};

export const errorHandler = (
  error: Error | AppError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Handle known AppError
  if (error instanceof AppError) {
    logError(error, req, { userId: (req as any).user?.userId });
    
    const response: ErrorResponse = {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: error.details }),
      },
    };

    return res.status(error.statusCode).json(response);
  }

  // Handle Mongoose validation errors
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

  // Handle Mongoose cast errors (invalid ObjectId, etc.)
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

  // Handle Multer errors (file upload)
  if ((error as any).code === 'LIMIT_FILE_SIZE') {
    logError(error, req);
    
    const response: ErrorResponse = {
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'File size exceeds the maximum allowed limit',
      },
    };

    return res.status(400).json(response);
  }

  // Handle unknown errors
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

// Async handler wrapper to catch errors in async route handlers
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<any> | any
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

