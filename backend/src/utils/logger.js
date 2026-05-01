const SENSITIVE_KEYS = new Set([
  'password',
  'apikey',
  'api_key',
  'token',
  'secret',
  'authorization',
  'cookie'
]);

const isProduction = () => process.env.NODE_ENV === 'production';

function maskValue(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }
  if (value.length < 8) {
    return '***';
  }
  return value.substring(0, 4) + '***';
}

export function sanitizeForLog(obj, depth = 0) {
  if (depth > 10) return '[MaxDepth]';
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return obj;
  if (typeof obj === 'boolean') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLog(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        result[key] = maskValue(value);
      } else if (lowerKey === 'content' && isProduction()) {
        if (typeof value === 'string') {
          result[key] = `[length: ${value.length}]`;
        } else {
          result[key] = sanitizeForLog(value, depth + 1);
        }
      } else if (typeof value === 'object' && value !== null) {
        result[key] = sanitizeForLog(value, depth + 1);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return obj;
}

export function safeLog(level, message, data) {
  const sanitizedData = data !== undefined ? sanitizeForLog(data) : undefined;

  const logFn = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  }[level] || console.log;

  if (sanitizedData !== undefined) {
    logFn(message, sanitizedData);
  } else {
    logFn(message);
  }
}
