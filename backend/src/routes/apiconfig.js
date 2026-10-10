import express from 'express';
import { withWriteLock } from '../models/db.js';
import { normalizeEndpoint } from '../services/ai/index.js';
import { safeLog } from '../utils/logger.js';
import { decryptStoredApiKey, encryptApiKeyForStorage } from '../utils/apiConfigSecurity.js';
import { getSafeExternalRequestOptions } from '../utils/safeExternalUrl.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

const DEFAULT_VENDORS = ['deepseek', 'zhipu', 'mimo', 'qwen'];
const CLEAR_API_KEY_SENTINEL = '__CLEAR__';

// 各厂商默认的 base_url（用户未填写时使用）
const VENDOR_DEFAULT_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com/chat/completions',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  mimo: 'https://api.xiaomimimo.com/v1/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
};

function sanitizeApiConfig(body) {
  const config = {};
  for (const vendor of DEFAULT_VENDORS) {
    if (body[vendor] && typeof body[vendor] === 'object') {
      const vendorConfig = {};
      if (Object.hasOwn(body[vendor], 'apiKey') && typeof body[vendor].apiKey === 'string') {
        vendorConfig.apiKey = body[vendor].apiKey.trim();
      }
      if (Object.hasOwn(body[vendor], 'baseUrl') && typeof body[vendor].baseUrl === 'string') {
        vendorConfig.baseUrl = body[vendor].baseUrl.trim();
      }
      if (Object.keys(vendorConfig).length > 0) config[vendor] = vendorConfig;
    }
  }
  return config;
}

function getDefaultConfig() {
  const config = {};
  for (const vendor of DEFAULT_VENDORS) {
    config[vendor] = { apiKey: '', baseUrl: '' };
  }
  return config;
}

function maskApiKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return '';
  if (key.length < 8) return '****';
  return `sk-****${key.slice(-4)}`;
}

function toClientApiConfigs(configs = {}) {
  const result = {};
  for (const vendor of DEFAULT_VENDORS) {
    const stored = configs[vendor] || {};
    const storedKey = decryptStoredApiKey(stored);
    const apiKeyConfigured = Boolean(storedKey);
    result[vendor] = {
      apiKey: '',
      apiKeyConfigured,
      apiKeyMasked: maskApiKey(storedKey),
      baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : ''
    };
  }
  return result;
}

// GET /api/user/apiconfig - 获取用户自定义API配置（密钥只返回掩码，不返回明文）
router.get('/apiconfig', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const aiApiConfigs = db.data.aiApiConfigs || getDefaultConfig();
  res.json({ success: true, config: toClientApiConfigs(aiApiConfigs) });
}));

// PUT /api/user/apiconfig - 保存用户自定义API配置（apiKey 为 write-only：
// 空值/缺省=保留现有值；'__CLEAR__'=清除；非空字符串=更新为新值并加密存储）
router.put('/apiconfig', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sanitized = sanitizeApiConfig(body);

  if (Object.keys(sanitized).length === 0) {
    return res.status(400).json({ success: false, error: '配置数据无效，请提供至少一个厂商的配置' });
  }

  // 在持久化前校验用户可控的 Base URL。请求时仍会再次校验（防止
  // DNS 变化/重绑定），这里先拒绝明显的内网、环回、元数据和非法地址，
  // 避免把危险配置写入数据库后再被其它后台任务读取。
  for (const [vendor, vendorConfig] of Object.entries(sanitized)) {
    if (vendorConfig.baseUrl === undefined || vendorConfig.baseUrl === '') continue;
    try {
      const endpoint = normalizeEndpoint(vendorConfig.baseUrl);
      await getSafeExternalRequestOptions(endpoint);
    } catch (error) {
      safeLog('warn', '[API配置] Base URL保存前安全校验失败', {
        userId: req.userId,
        vendor,
        error: error.message
      });
      return res.status(400).json({
        success: false,
        error: `${vendor} 的 Base URL 未通过安全校验`
      });
    }
  }

  const db = await req.getUserDb();

  await withWriteLock(req.userId, async () => {
    await db.read();

    if (!db.data.aiApiConfigs) {
      db.data.aiApiConfigs = getDefaultConfig();
    }

    for (const vendor of Object.keys(sanitized)) {
      if (!db.data.aiApiConfigs[vendor]) {
        db.data.aiApiConfigs[vendor] = { apiKey: '', baseUrl: '' };
      }
      if (sanitized[vendor].apiKey !== undefined) {
        if (sanitized[vendor].apiKey === CLEAR_API_KEY_SENTINEL) {
          db.data.aiApiConfigs[vendor].apiKey = '';
          db.data.aiApiConfigs[vendor].apiKeyEncrypted = false;
        } else if (sanitized[vendor].apiKey !== '') {
          Object.assign(db.data.aiApiConfigs[vendor], encryptApiKeyForStorage(sanitized[vendor].apiKey));
        }
      }
      if (sanitized[vendor].baseUrl !== undefined) {
        const oldEndpoint = db.data.aiApiConfigs[vendor].baseUrl
          ? normalizeEndpoint(db.data.aiApiConfigs[vendor].baseUrl) : VENDOR_DEFAULT_ENDPOINTS[vendor];
        const newEndpoint = sanitized[vendor].baseUrl
          ? normalizeEndpoint(sanitized[vendor].baseUrl) : VENDOR_DEFAULT_ENDPOINTS[vendor];
        if (oldEndpoint !== newEndpoint && !sanitized[vendor].apiKey) {
          db.data.aiApiConfigs[vendor].apiKey = '';
          db.data.aiApiConfigs[vendor].apiKeyEncrypted = false;
        }
        db.data.aiApiConfigs[vendor].baseUrl = sanitized[vendor].baseUrl;
      }
    }

    await db.write();
  });

  res.json({ success: true, config: toClientApiConfigs(db.data.aiApiConfigs) });
}));

// Old probes chose a platform preset model implicitly and had no paid-effect
// idempotency. Keep a truthful migration response instead of dispatching them.
router.post('/apiconfig/test', (_req, res) => res.status(410).json({
  success: false,
  healthy: false,
  error: '旧版连接测试已停用。请在模型中心添加并明确选择自己的模型后测试能力。',
  replacement: '/api/user/model-catalog/test'
}));

export default router;
