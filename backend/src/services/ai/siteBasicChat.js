import { createHash } from 'node:crypto';
import axios from 'axios';
import { normalizeBaseUrl, normalizeEndpoint } from './endpoints.js';
import { getSafeExternalRequestOptions } from '../../utils/safeExternalUrl.js';
import { responseText } from './transport.js';
import { getAuthDb } from '../../models/authDb.js';
import { withWriteLock } from '../../models/db.js';

const SITE_PROVIDERS = new Map([
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', /^qwen[a-z0-9._-]*$/i],
  ['https://api.deepseek.com', /^deepseek-[a-z0-9._-]+$/i],
  ['https://api.xiaomimimo.com/v1', /^mimo-[a-z0-9._-]+$/i]
]);

const failure = (status, message) => Object.assign(new Error(message), { status, siteAiPublic: true });
export function siteAiConfig(env = process.env) {
  if (env.SERVER_AI_ENABLED !== 'true') return null;
  const apiKey = env.SERVER_AI_API_KEY?.trim();
  const model = env.SERVER_AI_MODEL?.trim();
  if (!apiKey || apiKey.length > 4096 || !model || model.length > 200 || /[\r\n]/.test(apiKey + model)) return null;
  try {
    const baseUrl = normalizeBaseUrl(env.SERVER_AI_BASE_URL);
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || !SITE_PROVIDERS.get(baseUrl)?.test(model)) return null;
    const endpoint = normalizeEndpoint(baseUrl);
    const consentToken = createHash('sha256').update(JSON.stringify([endpoint, model])).digest('hex');
    return { apiKey, model, endpoint, providerOrigin: url.origin, consentToken };
  } catch { return null; }
}

// The shared spending admission lives with the durable auth store, not a browser
// identity or local rate-limit cache. Count attempts before dispatch; never refund
// uncertain failures. This is a request cap, not a currency spending guarantee.
export async function reserveSiteAiBudget(now = Date.now()) {
  return withWriteLock('auth', async () => {
    const db = getAuthDb();
    await db.read();
    const day = new Date(now).toISOString().slice(0, 10);
    const saved = db.data.siteAiBudget;
    if (saved && (saved.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(saved.day || '') || saved.day > day ||
        !Number.isSafeInteger(saved.count) || saved.count < 0 || saved.count > 100 ||
        !Array.isArray(saved.recent) || saved.recent.length > 10 || saved.recent.some(t => !Number.isSafeInteger(t) || t < 0))) {
      throw failure(503, '站点基础 AI 额度状态不可用');
    }
    const count = saved?.day === day ? saved.count : 0;
    const recent = (saved?.recent || []).filter(t => now - t < 60000);
    if (count >= 100 || recent.length >= 10) throw failure(429, '站点基础 AI 共享额度已达上限，请稍后再试');
    db.data.siteAiBudget = { version: 1, day, count: count + 1, recent: [...recent, now] };
    await db.write();
  });
}

export function createSiteBasicChat({ env = () => process.env, safeOptions = getSafeExternalRequestOptions,
  post = axios.post, reserve = reserveSiteAiBudget } = {}) {
  let active = 0;
  let statusCheck = null;
  let statusKey = null;
  let statusExpires = 0;
  async function status() {
    const config = siteAiConfig(env());
    if (!config) return { available: false };
    if (!statusCheck || (statusExpires !== Infinity && (statusKey !== config.consentToken || Date.now() >= statusExpires))) {
      statusKey = config.consentToken;
      statusExpires = Infinity;
      statusCheck = Promise.resolve().then(() => safeOptions(config.endpoint)).then(() => true, () => false)
        .finally(() => { statusExpires = Date.now() + 30000; });
    }
    // One DNS lookup in flight, including when a client stops waiting. Never
    // create unbounded outstanding lookups or disclose a newly changed target
    // using the old target's validation result.
    if (statusKey !== config.consentToken) return { available: false };
    let timer;
    const valid = await Promise.race([statusCheck, new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
    clearTimeout(timer);
    if (!valid) return { available: false };
    return { available: true, providerOrigin: config.providerOrigin, model: config.model, consentToken: config.consentToken };
  }
  async function chat(input, { signal } = {}) {
    const config = siteAiConfig(env());
    if (!config) throw failure(503, '站点基础 AI 尚未启用');
    if (!input || input.consent !== true || input.consentToken !== config.consentToken) {
      throw failure(409, '请重新查看站点服务商，并明确同意发送本次文本');
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 ||
        Object.keys(input).some(key => !['prompt', 'consent', 'consentToken'].includes(key))) {
      throw failure(400, '请输入 1–4000 字的单次文本，不支持历史、文件或工具参数');
    }
    if (active >= 2) throw failure(429, '站点基础 AI 正忙，请稍后再试');
    active++;
    try {
      let safe;
      try { safe = await safeOptions(config.endpoint); } catch { throw failure(503, '站点基础 AI 服务地址不可用'); }
      if (signal?.aborted) throw failure(409, '请求已取消');
      await reserve();
      if (signal?.aborted) throw failure(409, '请求已取消');
      try {
        const response = await post(config.endpoint, {
          model: config.model, messages: [{ role: 'user', content: input.prompt }],
          stream: false, ...(config.providerOrigin === 'https://api.xiaomimimo.com'
            ? { max_completion_tokens: 1024, thinking: { type: 'disabled' } }
            : config.providerOrigin === 'https://dashscope.aliyuncs.com'
              ? { max_completion_tokens: 1024, enable_thinking: false }
              : { max_tokens: 1024, thinking: { type: 'disabled' } })
        }, { ...safe, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          timeout: 20000, signal, maxContentLength: 256 * 1024, maxBodyLength: 32 * 1024 });
        const content = responseText(response.data);
        if (!content.trim() || content.length > 16000) throw new Error('invalid response');
        return { content: content.split(config.apiKey).join('[redacted]'), generatedByAI: true,
          providerOrigin: config.providerOrigin, model: config.model };
      } catch { throw failure(502, '站点基础 AI 请求未完成；不会自动重试，请核对后再发送'); }
    } finally { active--; }
  }
  return { status, chat };
}
