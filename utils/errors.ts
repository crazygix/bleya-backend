import { Response } from 'express';

export enum ErrorCode {
  // Validation errors (400)
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',
  
  // Authentication errors (401)
  UNAUTHORIZED = 'UNAUTHORIZED',
  INVALID_TOKEN = 'INVALID_TOKEN',
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  
  // Authorization errors (403)
  FORBIDDEN = 'FORBIDDEN',
  
  // Not found errors (404)
  NOT_FOUND = 'NOT_FOUND',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ROOM_NOT_FOUND = 'ROOM_NOT_FOUND',
  
  // Conflict errors (409)
  CONFLICT = 'CONFLICT',
  ALREADY_EXISTS = 'ALREADY_EXISTS',
  
  // Rate limiting (429)
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',
  
  // Server errors (500)
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
}

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    details?: any;
  };
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: any;
  public readonly isOperational: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    details?: any,
    isOperational: boolean = true
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(ErrorCode.UNAUTHORIZED, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(ErrorCode.FORBIDDEN, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code: ErrorCode = ErrorCode.NOT_FOUND) {
    super(code, message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: any) {
    super(ErrorCode.CONFLICT, message, 409, details);
  }
}

export class InternalError extends AppError {
  constructor(message: string = 'Internal server error', details?: any) {
    super(ErrorCode.INTERNAL_ERROR, message, 500, details, false);
  }
}

