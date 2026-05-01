import { safeLog } from '../utils/logger.js';

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

export function createError(message, statusCode = 500, code = 'INTERNAL_ERROR') {
  return new AppError(message, statusCode, code);
}

export function errorHandler(err, req, res, _next) {
  const isProduction = process.env.NODE_ENV === 'production';

  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = '服务器内部错误';

  if (err.isOperational) {
    statusCode = err.statusCode;
    errorCode = err.code;
    message = err.message;
  } else if (err.name === 'ZodError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
  } else if (err.name === 'SyntaxError' && err.status === 400) {
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = '请求体JSON格式错误';
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 400;
    errorCode = 'FILE_TOO_LARGE';
    message = '文件大小超过限制';
  } else if (err.code === 'ENOENT') {
    statusCode = 404;
    errorCode = 'NOT_FOUND';
    message = '请求的资源不存在';
  } else if (!isProduction) {
    message = err.message || '服务器内部错误';
  }

  if (statusCode >= 500) {
    safeLog('error', `服务器错误 [${req.method} ${req.path}]`, {
      error: err.message,
      stack: isProduction ? undefined : err.stack,
      statusCode,
      errorCode
    });
  }

  const response = {
    success: false,
    error: message,
    code: errorCode
  };

  if (!isProduction) {
    response.stack = err.stack;
    response.details = err.details || undefined;
  }

  res.status(statusCode).json(response);
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export { AppError };
