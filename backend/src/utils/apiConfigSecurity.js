import { decryptText, encryptText } from './encryption.js';

const SUPPORTED_VENDORS = ['deepseek', 'zhipu', 'mimo', 'qwen'];

export function decryptStoredApiKey(config) {
  if (!config || typeof config.apiKey !== 'string' || !config.apiKey) return '';
  if (!config.apiKeyEncrypted) return config.apiKey.trim();
  return decryptText(config.apiKey).trim();
}

export function encryptApiKeyForStorage(apiKey) {
  const normalized = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!normalized) return { apiKey: '', apiKeyEncrypted: false };
  return { apiKey: encryptText(normalized), apiKeyEncrypted: true };
}

export function toPublicApiConfigs(configs = {}) {
  const result = {};
  for (const vendor of SUPPORTED_VENDORS) {
    const stored = configs[vendor] || {};
    result[vendor] = {
      apiKey: '',
      apiKeyConfigured: Boolean(decryptStoredApiKey(stored)),
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : ''
    };
  }
  return result;
}

export { SUPPORTED_VENDORS };
