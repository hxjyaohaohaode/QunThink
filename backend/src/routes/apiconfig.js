import express from 'express';
import axios from 'axios';
import { withWriteLock } from '../models/db.js';
import { normalizeEndpoint } from '../services/ai/index.js';
import { safeLog } from '../utils/logger.js';
import { decryptStoredApiKey, encryptApiKeyForStorage } from '../utils/apiConfigSecurity.js';
import { getSafeExternalRequestOptions } from '../utils/safeExternalUrl.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

const DEFAULT_VENDORS = ['deepseek', 'zhipu', 'mimo', 'qwen'];
const CLEAR_API_KEY_SENTINEL = '__CLEAR__';

// 各厂商默认的测试模型（用于配置测试，选择最便宜/最快的模型）
const VENDOR_TEST_MODELS = {
  deepseek: 'deepseek-chat',
  zhipu: 'glm-4-flash',
  mimo: 'mimo-v2.5',
  qwen: 'qwen3.5-flash'
};

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

/**
 * 从 axios 错误中提取可读的诊断信息（与 ai/index.js 中保持一致）
 */
function describeAxiosError(error) {
  if (!error) return '未知错误';
  if (error.code === 'ENOTFOUND') return `域名无法解析(${error.hostname || ''})`;
  if (error.code === 'ECONNABORTED') return `请求超时(${error.message || ''})`;
  if (error.code === 'ECONNREFUSED') return '连接被拒绝';
  if (error.code === 'ECONNRESET') return '连接被重置';
  if (error.code === 'ERR_CANCELED' || error.name === 'AbortError') return '请求被取消';
  if (error.response) {
    const status = error.response.status;
    let detail = '';
    try {
      const data = error.response.data;
      if (typeof data === 'string') {
        detail = data.substring(0, 200);
      } else if (data && typeof data === 'object') {
        detail = (data.error?.message || data.message || JSON.stringify(data)).substring(0, 200);
      }
    } catch { /* ignore */ }
    if (status === 401) return `鉴权失败(401)，API Key无效${detail ? `：${detail}` : ''}`;
    if (status === 403) return `访问被拒绝(403)${detail ? `：${detail}` : ''}`;
    if (status === 404) return `接口路径不存在(404)，请检查Base URL是否正确${detail ? `：${detail}` : ''}`;
    if (status === 429) return `请求过于频繁(429)，触发限流`;
    if (status >= 500) return `服务端错误(${status})${detail ? `：${detail}` : ''}`;
    return `HTTP错误(${status})${detail ? `：${detail}` : ''}`;
  }
  return error.message || '未知错误';
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
        db.data.aiApiConfigs[vendor].baseUrl = sanitized[vendor].baseUrl;
      }
    }

    await db.write();
  });

  res.json({ success: true, config: toClientApiConfigs(db.data.aiApiConfigs) });
}));

/**
 * POST /api/user/apiconfig/test - 测试用户自定义API配置是否可用
 * 请求体：{ vendor: 'deepseek'|'zhipu'|'mimo'|'qwen', apiKey?: string, baseUrl?: string }
 * 若未提供 apiKey/baseUrl，则使用已保存的配置；若仍未保存，则使用系统默认
 * 返回：{ success: boolean, healthy: boolean, endpoint: string, model: string, responseTime?: number, error?: string }
 * 测试失败返回 HTTP 502（healthy:false + 详情），成功返回 HTTP 200
 */
router.post('/apiconfig/test', asyncHandler(async (req, res) => {
  const { vendor } = req.body || {};
  if (!VENDOR_TEST_MODELS[vendor]) {
    return res.status(400).json({ success: false, error: `无效的厂商，支持：${DEFAULT_VENDORS.join(', ')}` });
  }

  // 优先使用请求体中的临时配置（用户可能尚未保存就测试）
  let apiKey = typeof req.body.apiKey === 'string' ? req.body.apiKey.trim() : '';
  let baseUrl = typeof req.body.baseUrl === 'string' ? req.body.baseUrl.trim() : '';

  // 若请求体未提供，则回退到用户已保存的配置
  if (!apiKey || !baseUrl) {
    const db = await req.getUserDb();
    await db.read();
    const saved = (db.data.aiApiConfigs || {})[vendor] || {};
    if (!apiKey) apiKey = decryptStoredApiKey(saved);
    if (!baseUrl) baseUrl = (saved.baseUrl || '').trim();
  }

  // 若仍未获取到 apiKey，则回退到系统默认（环境变量）
  if (!apiKey) {
    const envKeyMap = {
      deepseek: process.env.DEEPSEEK_API_KEY,
      zhipu: process.env.GLM_API_KEY,
      mimo: process.env.MIMO_API_KEY,
      qwen: process.env.QWEN_API_KEY
    };
    apiKey = (envKeyMap[vendor] || '').trim();
  }

  if (!apiKey) {
    return res.status(502).json({
      success: true,
      healthy: false,
      vendor,
      error: '未配置API Key，请填写API Key后重试'
    });
  }

  // 规范化 endpoint：用户填写了 baseUrl 则使用，否则使用系统默认
  const endpoint = baseUrl ? normalizeEndpoint(baseUrl) : VENDOR_DEFAULT_ENDPOINTS[vendor];
  let safeRequestOptions = { maxRedirects: 0 };
  if (baseUrl) {
    try {
      safeRequestOptions = await getSafeExternalRequestOptions(endpoint);
    } catch (error) {
      safeLog('warn', '[API配置测试] Base URL安全校验失败', { userId: req.userId, error: error.message });
      return res.status(400).json({ success: false, healthy: false, error: 'Base URL未通过安全校验' });
    }
  }
  const testModel = VENDOR_TEST_MODELS[vendor];

  safeLog('info', `[API配置测试] 用户${req.userId}测试${vendor}`, { endpoint, model: testModel });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const startTime = Date.now();

  try {
    const response = await axios.post(endpoint, {
      model: testModel,
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: 5,
      stream: false
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      timeout: 15000,
      validateStatus: () => true,
      ...safeRequestOptions
    });

    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    const status = response.status;

    if (status >= 200 && status < 300) {
      // 验证响应格式
      const hasChoices = response.data?.choices?.[0]?.message;
      if (hasChoices) {
        return res.json({
          success: true,
          healthy: true,
          vendor,
          endpoint,
          model: testModel,
          responseTime,
          message: '连接成功，API配置可用'
        });
      }
      return res.status(502).json({
        success: true,
        healthy: false,
        vendor,
        endpoint,
        model: testModel,
        responseTime,
        error: `响应格式异常：缺少choices字段，可能模型名"${testModel}"不正确`
      });
    }

    // 4xx/5xx 错误
    let detail = '';
    try {
      const data = response.data;
      if (typeof data === 'string') {
        detail = data.substring(0, 200);
      } else if (data && typeof data === 'object') {
        detail = (data.error?.message || data.message || JSON.stringify(data)).substring(0, 200);
      }
    } catch { /* ignore */ }

    return res.status(502).json({
      success: true,
      healthy: false,
      vendor,
      endpoint,
      model: testModel,
      responseTime,
      error: describeAxiosError({ response: { status, data: response.data } }),
      detail
    });
  } catch (error) {
    clearTimeout(timeoutId);
    const responseTime = Date.now() - startTime;
    return res.status(502).json({
      success: true,
      healthy: false,
      vendor,
      endpoint,
      model: testModel,
      responseTime,
      error: describeAxiosError(error)
    });
  }
}));

export default router;
