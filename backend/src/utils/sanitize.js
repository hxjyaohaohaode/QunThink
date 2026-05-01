const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#96;',
};

const HTML_ENTITY_REGEX = /[&<>"'\/`]/g;

function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(HTML_ENTITY_REGEX, (char) => HTML_ENTITIES[char] || char);
}

function sanitizeString(input, maxLength = 10000) {
  if (typeof input !== 'string') return input;
  let sanitized = input;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  return sanitized;
}

function sanitizeObject(obj, options = {}) {
  const { escapeHtmlFields = [], trimFields = [], maxLengthFields = {} } = options;

  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item, options));
  if (typeof obj !== 'object') return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      let sanitized = value;
      if (trimFields.includes(key)) {
        sanitized = sanitized.trim();
      }
      if (maxLengthFields[key]) {
        sanitized = sanitizeString(sanitized, maxLengthFields[key]);
      }
      if (escapeHtmlFields.includes(key)) {
        sanitized = escapeHtml(sanitized);
      }
      result[key] = sanitized;
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeObject(value, options);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const GROUP_SANITIZE_CONFIG = {
  escapeHtmlFields: ['name', 'description', 'announcement'],
  trimFields: ['name', 'description', 'announcement'],
  maxLengthFields: { name: 100, description: 500, announcement: 1000 }
};

const MESSAGE_SANITIZE_CONFIG = {
  maxLengthFields: { content: 10000 }
};

const COMMENT_SANITIZE_CONFIG = {
  escapeHtmlFields: ['content'],
  trimFields: ['content'],
  maxLengthFields: { content: 2000 }
};

const AGENT_SANITIZE_CONFIG = {
  escapeHtmlFields: ['name', 'description', 'opening_message', 'openingMessage'],
  trimFields: ['name', 'description', 'opening_message', 'openingMessage'],
  maxLengthFields: { name: 100, description: 500, opening_message: 1000, openingMessage: 1000 }
};

const PROFILE_SANITIZE_CONFIG = {
  escapeHtmlFields: ['nickname', 'bio'],
  trimFields: ['nickname', 'bio'],
  maxLengthFields: { nickname: 50, bio: 500 }
};

export {
  escapeHtml,
  sanitizeString,
  sanitizeObject,
  GROUP_SANITIZE_CONFIG,
  MESSAGE_SANITIZE_CONFIG,
  COMMENT_SANITIZE_CONFIG,
  AGENT_SANITIZE_CONFIG,
  PROFILE_SANITIZE_CONFIG
};
