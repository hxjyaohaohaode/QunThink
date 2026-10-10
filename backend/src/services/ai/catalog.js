import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LEGACY_MODEL_METADATA } from '../../config/legacyModels.js';
import { AI_PERSONAS } from '../../config/personas.js';
import { getUserDb, withWriteLock, readCommittedUserDb } from '../../models/db.js';
import { decryptStoredApiKey, encryptApiKeyForStorage } from '../../utils/apiConfigSecurity.js';
import { getSafeAiRequestOptions } from '../../utils/safeExternalUrl.js';
import { normalizeBaseUrl, normalizeEndpoint } from './endpoints.js';

const providers = {
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  zhipu: { name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  mimo: { name: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' },
  qwen: { name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }
};
const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const providerSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(80),
  protocol: z.enum(['openai', 'anthropic']), baseUrl: z.string().trim().min(1).max(500),
  enabled: z.boolean(), keyRequired: z.boolean().default(true),
  apiKey: z.string().trim().max(4096).optional(), clearApiKey: z.boolean().optional()
});
const modelSchema = z.object({
  id: idSchema, providerId: idSchema, name: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200), enabled: z.boolean(),
  capabilities: z.array(z.enum(['chat', 'vision', 'audio', 'video', 'tts'])).min(1).max(5),
  contextWindow: z.number().int().min(1024).max(2000000).default(32000),
  maxTokens: z.number().int().min(1).max(131072).default(4096),
  temperature: z.number().min(0).max(2).nullable().default(null),
  tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).default('max_tokens'),
  ttsMode: z.enum(['speech', 'chat-audio']).default('speech'),
  ttsVoice: z.string().trim().min(1).max(80).nullable().default(null),
  color: z.string().regex(/^#[\da-f]{6}$/i).default('#6366f1')
}).refine(m => m.maxTokens < m.contextWindow, { message: '输出上限必须小于上下文窗口', path: ['maxTokens'] });
export const catalogSchema = z.object({
  revision: z.number().int().nonnegative(), providers: z.array(providerSchema).max(40),
  models: z.array(modelSchema).max(200),
  defaults: z.object({ chat: idSchema.nullable(), vision: idSchema.nullable(), tts: idSchema.nullable() })
});

export function catalogError(message, status = 400) { return Object.assign(new Error(message), { status }); }
function legacyVendor(id) {
  if (id.startsWith('glm_')) return 'zhipu';
  if (id.startsWith('mimo_')) return 'mimo';
  if (id.startsWith('qwen_')) return 'qwen';
  return 'deepseek';
}

export function getCatalogData(data = {}) {
  // A saved catalog is owned by this account. Preserve all explicit models,
  // credentials and defaults, including models whose IDs match older presets.
  if (data.modelCatalog) return data.modelCatalog;
  const models = Object.entries(data.aiModels || {}).flatMap(([id, saved]) => {
    const m = LEGACY_MODEL_METADATA[id];
    if (!m || typeof saved?.model !== 'string' || !saved.model.trim()) return [];
    return [{
      id, providerId: legacyVendor(id), name: saved.name || m.name, model: saved.model,
      enabled: saved.enabled !== false, capabilities: m.isTTS ? ['tts'] : ['chat', ...(m.capabilities || [])],
      contextWindow: 32000, maxTokens: Math.max(512, m.params.max_tokens),
      temperature: null, tokenParameter: 'max_tokens', ttsMode: m.isTTS ? 'chat-audio' : 'speech',
      ttsVoice: m.isTTS ? 'mimo_default' : null, color: AI_PERSONAS[id]?.color || '#6366f1'
    }];
  });
  return {
    revision: 0,
    // Retain user-saved legacy connections without inventing models for them.
    // Empty slots created by the old API config form are not connections.
    providers: Object.entries(providers).filter(([id]) => {
      const saved = data.aiApiConfigs?.[id];
      return Boolean(saved?.apiKey || saved?.baseUrl || models.some(m => m.providerId === id));
    }).map(([id, p]) => ({
      id, name: p.name, protocol: 'openai', enabled: true, keyRequired: true,
      baseUrl: normalizeBaseUrl(data.aiApiConfigs?.[id]?.baseUrl || p.baseUrl)
    })),
    models,
    defaults: { chat: null, vision: null, tts: null }
  };
}

function resolveProvider(provider, data) {
  const stored = Object.hasOwn(provider, 'apiKey') ? provider : data.aiApiConfigs?.[provider.id];
  const apiKey = decryptStoredApiKey(stored);
  // BYOK only: server environment keys are never consulted, even when an old
  // deployment still has the retired shared-provider-key switch enabled.
  return { apiKey, source: apiKey ? 'user' : 'none',
    ready: provider.enabled && (!provider.keyRequired || Boolean(apiKey)) };
}

export function capabilityFingerprint(model, provider, data = {}) {
  const connection = resolveProvider(provider, data);
  return createHash('sha256').update(JSON.stringify([
    model.model, model.providerId, model.contextWindow, model.maxTokens, model.ttsMode, model.ttsVoice,
    model.tokenParameter, model.temperature, provider?.protocol, provider?.baseUrl,
    connection.source, connection.apiKey
  ])).digest('hex');
}

export async function recordCapabilityProbe(userId, modelId, capability, result) {
  const db = await getUserDb(userId);
  return withWriteLock(userId, async () => {
    await db.read();
    const catalog = getCatalogData(db.data);
    const model = catalog.models.find(m => m.id === modelId);
    const provider = catalog.providers.find(p => p.id === model?.providerId);
    if (!model || !provider || !model.capabilities.includes(capability) ||
        (result.expectedRevision !== undefined && result.expectedRevision !== catalog.revision) ||
        (result.expectedFingerprint && result.expectedFingerprint !== capabilityFingerprint(model, provider, db.data))) {
      throw catalogError('模型配置已变化，请重新测试', 409);
    }
    db.data.modelCapabilityChecks ||= {};
    db.data.modelCapabilityChecks[modelId] ||= {};
    db.data.modelCapabilityChecks[modelId][capability] = {
      status: result.verified ? 'verified' : 'unknown',
      fingerprint: capabilityFingerprint(model, provider, db.data),
      checkedAt: new Date().toISOString(),
      evidence: result.verified ? { protocol: provider.protocol, responseTime: result.responseTime } : null
    };
    await db.write();
  });
}

export function publicCatalog(data) {
  const catalog = getCatalogData(data);
  const publicProviders = catalog.providers.map(p => {
    const secret = resolveProvider(p, data);
    return {
      id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, enabled: p.enabled,
      keyRequired: p.keyRequired, apiKeyConfigured: Boolean(secret.apiKey), keySource: secret.source,
      ready: secret.ready
    };
  });
  return {
    revision: catalog.revision, providers: publicProviders, defaults: catalog.defaults,
    models: catalog.models.map(m => {
      const provider = catalog.providers.find(p => p.id === m.providerId);
      const checks = data.modelCapabilityChecks?.[m.id] || {};
      const verifiedCapabilities = m.capabilities.filter(cap => checks[cap]?.status === 'verified' &&
        checks[cap]?.fingerprint === capabilityFingerprint(m, provider, data));
      return { ...m, ready: m.enabled && !!publicProviders.find(p => p.id === m.providerId)?.ready,
        verifiedCapabilities };
    })
  };
}

export async function readCatalog(userId) {
  const db = await getUserDb(userId);
  return readCommittedUserDb(db, publicCatalog);
}

export async function saveCatalog(userId, input) {
  const parsed = catalogSchema.parse(input);
  if (new Set(parsed.providers.map(p => p.id)).size !== parsed.providers.length ||
      new Set(parsed.models.map(m => m.id)).size !== parsed.models.length) throw catalogError('服务商或模型标识重复');
  for (const model of parsed.models) {
    if (!parsed.providers.some(p => p.id === model.providerId)) throw catalogError(`模型 ${model.name} 的服务商不存在`);
  }
  for (const [capability, id] of Object.entries(parsed.defaults)) {
    if (!id) continue;
    const model = parsed.models.find(m => m.id === id && m.enabled && m.capabilities.includes(capability));
    if (!model || !parsed.providers.find(p => p.id === model.providerId)?.enabled) throw catalogError(`默认 ${capability} 模型未启用或不具备所需能力`);
  }
  const db = await getUserDb(userId);
  await db.read();
  const previous = getCatalogData(db.data);
  // Validate only new/changed endpoints here; every actual request validates again.
  for (const p of parsed.providers) {
    try {
      p.baseUrl = normalizeBaseUrl(p.baseUrl);
      if (!previous.providers.some(old => old.id === p.id && old.baseUrl === p.baseUrl)) {
        await getSafeAiRequestOptions(normalizeEndpoint(p.baseUrl, p.protocol));
      }
    } catch { throw catalogError('服务地址无效或未获准访问。内网服务需要由服务器配置允许的地址。'); }
  }
  return withWriteLock(userId, async () => {
    await db.read();
    const old = getCatalogData(db.data);
    if (old.revision !== parsed.revision) throw catalogError('配置已在其他页面更新，请刷新后重试', 409);
    const removed = old.models.filter(m => !parsed.models.some(next => next.id === m.id));
    for (const model of removed) {
      const inUse = db.data.groups?.some(g => g.ai_members?.includes(model.id)) ||
        db.data.agents?.some(a => a.model_roles?.some(r => r.modelId === model.id)) ||
        db.data.tasks?.some(t => t.model_id === model.id);
      if (inUse) throw catalogError(`${model.name} 仍被会话、智能体或任务使用，请禁用或先更换引用`, 409);
    }
    const changedConnections = new Set(parsed.providers.filter(p => {
      const prior = old.providers.find(v => v.id === p.id);
      return !prior || prior.baseUrl !== p.baseUrl || prior.protocol !== p.protocol ||
        Boolean(p.apiKey) || Boolean(p.clearApiKey);
    }).map(p => p.id));
    parsed.providers = parsed.providers.map(p => {
      const prior = old.providers.find(v => v.id === p.id);
      const priorSecret = prior && (Object.hasOwn(prior, 'apiKey') ? prior : db.data.aiApiConfigs?.[p.id]);
      const { apiKey, clearApiKey, ...clean } = p;
      if (clearApiKey) return { ...clean, apiKey: '', apiKeyEncrypted: false, keyCleared: true };
      if (apiKey) return { ...clean, ...encryptApiKeyForStorage(apiKey), keyCleared: false };
      if (prior && (prior.baseUrl !== p.baseUrl || prior.protocol !== p.protocol)) {
        // A credential authorizes one destination and protocol, not an arbitrary
        // replacement host. Require an explicit credential at the new endpoint.
        return { ...clean, apiKey: '', apiKeyEncrypted: false, keyCleared: true };
      }
      return { ...clean, ...encryptApiKeyForStorage(decryptStoredApiKey(priorSecret)), keyCleared: prior?.keyCleared || false };
    });
    db.data.modelCatalog = { ...parsed, revision: old.revision + 1 };
    for (const model of parsed.models) {
      if (changedConnections.has(model.providerId)) delete db.data.modelCapabilityChecks?.[model.id];
    }
    await db.write();
    return publicCatalog(db.data);
  });
}

export async function resolveModel(userId, modelId, capability = null, options = {}) {
  const db = await getUserDb(userId || 'default');
  return readCommittedUserDb(db, data => resolveModelSnapshot(data, modelId, capability, options));
}

// Pure resolution lets paid-effect admission use the same authoritative data
// and CAS revision for configuration, idempotency and the intent checkpoint.
// Do not insert an additional DB read between those decisions and their write.
export function resolveModelSnapshot(data, modelId, capability = null, { allowUnverified = false } = {}) {
  const catalog = getCatalogData(data);
  const model = catalog.models.find(m => m.id === modelId);
  if (!model) throw catalogError('模型不存在，请在模型中心重新选择', 404);
  const provider = catalog.providers.find(p => p.id === model.providerId);
  if (!model.enabled || !provider?.enabled) throw catalogError('模型或服务商已停用，请在模型中心启用', 409);
  if (capability && !model.capabilities.includes(capability)) throw catalogError(`所选模型不支持 ${capability}`);
  const check = capability && data.modelCapabilityChecks?.[model.id]?.[capability];
  if (capability && !allowUnverified &&
      (check?.status !== 'verified' || check.fingerprint !== capabilityFingerprint(model, provider, data))) {
    throw catalogError(`所选模型的 ${capability} 能力尚未通过当前连接的测试，请在模型中心测试`, 409);
  }
  const secret = resolveProvider(provider, data);
  if (!secret.ready) throw catalogError('请先在模型中心为这个服务商配置 API Key', 409);
  return {
    ...model, catalogRevision: catalog.revision,
    capabilityFingerprint: capabilityFingerprint(model, provider, data),
    apiKey: secret.apiKey, protocol: provider.protocol, keyRequired: provider.keyRequired,
    endpoint: normalizeEndpoint(provider.baseUrl, provider.protocol), baseUrl: provider.baseUrl,
    params: { max_tokens: model.maxTokens, ...(model.temperature === null ? {} : { temperature: model.temperature }) }
  };
}

export async function resolveProviderConnection(userId, providerId) {
  const db = await getUserDb(userId); await db.read();
  const provider = getCatalogData(db.data).providers.find(p => p.id === providerId);
  if (!provider) throw catalogError('服务商不存在', 404);
  const secret = resolveProvider(provider, db.data);
  if (!secret.ready) throw catalogError('请先启用服务商并配置连接凭据', 409);
  return { baseUrl: provider.baseUrl, protocol: provider.protocol, apiKey: secret.apiKey };
}

export async function defaultModelId(userId, capability = 'chat') {
  const db = await getUserDb(userId || 'default');
  return readCommittedUserDb(db, data => defaultModelIdSnapshot(data, capability));
}

// Admission must choose defaults from the same snapshot as its command ledger.
export function defaultModelIdSnapshot(data, capability = 'chat') {
  const catalog = publicCatalog(data);
  const explicitId = catalog.defaults[capability];
  const preferred = catalog.models.find(m => m.id === explicitId && m.ready && m.verifiedCapabilities.includes(capability));
  if (explicitId && !preferred) {
    throw catalogError(`你选择的默认 ${capability} 模型暂不可用或尚未通过测试。请重新测试或明确更改默认模型；不会自动改用其他服务商。`, 409);
  }
  const selected = explicitId ? preferred : catalog.models.find(m => m.ready && m.verifiedCapabilities.includes(capability));
  if (!selected) throw catalogError(`还没有经过测试的 ${capability} 模型，请在模型中心配置并测试，或明确选择模型`, 409);
  return selected.id;
}

export function modelPersona(model) {
  const legacy = AI_PERSONAS[model.id] || {};
  return {
    id: model.id, name: model.name, color: model.color, style: '清晰、友好、务实',
    personality: '', replyStyle: '围绕当前目标提供准确、有帮助的回答', typicalPhrases: [],
    expertise: [], keywords: [], silenceProbability: 0, refusalProbability: 0,
    ...legacy,
    id: model.id, name: model.name, color: model.color || legacy.color,
    modelConfig: { ...legacy.modelConfig, maxTokens: Math.min(model.maxTokens || 4096, legacy.modelConfig?.maxTokens || model.maxTokens || 4096) },
    responseConfig: { enabled: model.enabled, responseFrequency: 1, minDelay: 200, maxDelay: 500, maxResponsesPerConversation: 3, ...legacy.responseConfig, enabled: model.enabled && legacy.responseConfig?.enabled !== false },
    socialConfig: { maxMessageLength: 12000, enableSocialFeedback: false, ...legacy.socialConfig }
  };
}
