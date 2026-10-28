/**
 * Typed application errors + helpers used by every controller.
 *
 * Every error surfaced to the client has the shape:
 *   { success: false, error: { code, message, details? } }
 */

export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = undefined) {
    super(message, 422, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
    this.name = 'ConflictError';
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later', retryAfter = 60) {
    super(message, 429, 'RATE_LIMITED');
    this.name = 'TooManyRequestsError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Wrap async route handlers so rejected promises reach the error middleware.
 * Express 4 does not do this automatically.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export default { AppError, ValidationError, UnauthorizedError, ForbiddenError, NotFoundError, ConflictError, TooManyRequestsError, asyncHandler };
