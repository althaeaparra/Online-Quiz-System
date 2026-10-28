import mongoose from 'mongoose';
import multer from 'multer';
import { AppError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export const notFoundHandler = (req, _res, next) => {
  const err = new AppError(`Route ${req.method} ${req.originalUrl} not found`, 404, 'ROUTE_NOT_FOUND');
  next(err);
};

const normalize = (err) => {
  if (err instanceof AppError) return { status: err.statusCode, code: err.code, message: err.message, details: err.details };

  if (err instanceof mongoose.Error.ValidationError) {
    return {
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Please check the highlighted fields',
      details: Object.entries(err.errors).map(([field, e]) => ({ field, message: e.message })),
    };
  }

  if (err instanceof mongoose.Error.CastError) {
    return { status: 400, code: 'INVALID_ID', message: `Invalid value for ${err.path}` };
  }

  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return { status: 409, code: 'CONFLICT', message: `That ${field} is already in use` };
  }

  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is too large (max ${process.env.MAX_UPLOAD_MB || 2}MB)`
        : 'Upload failed';
    return { status: 400, code: err.code, message };
  }

  if (err?.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong on our end' };
};

export const errorHandler = (err, req, res, _next) => {
  const { status, code, message, details } = normalize(err);

  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${err.message}`, { stack: err.stack });
  } else {
    logger.debug(`${req.method} ${req.originalUrl} → ${status} ${message}`);
  }

  if (res.headersSent) return undefined;

  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
    ...(process.env.NODE_ENV === 'development' && status >= 500 ? { stack: err.stack } : {}),
  });
};

export default { errorHandler, notFoundHandler };
