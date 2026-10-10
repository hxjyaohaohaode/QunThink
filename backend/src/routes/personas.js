import express from 'express';
import { withWriteLock } from '../models/db.js';
import { AI_PERSONAS } from '../config/personas.js';
import { loadCustomPersonas } from '../services/scheduler/index.js';
import { validateBody, updatePersonaSchema } from '../validators/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { broadcastPersonaUpdate, broadcastPersonasSync } from '../websocket/index.js';
import { getCatalogData, modelPersona } from '../services/ai/catalog.js';

const router = express.Router();

const PERSONA_ALLOWED_FIELDS = [
  'name', 'systemPrompt', 'avatar', 'avatar_url', 'color', 'styleTag', 'style', 'replyStyle', 'personality',
  'typicalPhrases', 'expertise', 'speakingTraits', 'keywords', 'messageLength',
  'responseConfig', 'socialConfig', 'modelConfig', 'debateConfig',
  'preferredRole', 'customRoleName', 'questionProbability', 'debateTendency',
  'silenceProbability', 'refusalProbability', 'speakingOrder', 'firstSpeakerTopics',
  'relationships'
];

const PERSONA_NESTED_FIELDS = ['responseConfig', 'socialConfig', 'modelConfig', 'debateConfig', 'relationships'];

async function resolveAiId(req, res) {
  const { aiId } = req.params;
  const db = await req.getUserDb();
  await db.read();
  if (getCatalogData(db.data).models.some(model => model.id === aiId)) return aiId;
  if (db.data.customPersonas && Object.hasOwn(db.data.customPersonas, aiId)) return aiId;
  res.status(404).json({ error: '未找到该AI' });
  return null;
}

export function getCustomPersonaUpdatedAt(customPersona) {
  if (!customPersona || typeof customPersona !== 'object') return null;
  if (customPersona._meta && Number.isFinite(customPersona._meta.updatedAt)) {
    return customPersona._meta.updatedAt;
  }
  if (Number.isFinite(customPersona._updatedAt)) return customPersona._updatedAt;
  return null;
}

const defaultResponseConfig = {
  enabled: true,
  responseFrequency: 0.8,
  minDelay: 1000,
  maxDelay: 4000,
  activeHours: { start: 0, end: 24 },
  maxResponsesPerConversation: 10,
  cooldownBetweenResponses: 2000
};

const defaultSocialConfig = {
  maxMessageLength: 800,
  enableQuoting: true,
  enableSocialFeedback: true,
  quoteProbability: 0.4,
  maxQuotesPerMessage: 2,
  likeProbability: 0.3,
  commentProbability: 0.15,
  dislikeProbability: 0.05,
  interactionProbability: 0.75
};

const defaultModelConfig = {
  maxTokens: 1500,
  temperature: 0.5,
  topP: 0.9,
  frequencyPenalty: 0.3,
  presencePenalty: 0.2
};

const defaultDebateConfig = {
  debateStyle: 'formal',
  preferredRole: 'any'
};

function mergePersona(defaultPersona, customPersona = {}) {
  const defaultResp = defaultPersona.responseConfig || defaultResponseConfig;
  const defaultSocial = defaultPersona.socialConfig || defaultSocialConfig;
  const defaultModel = defaultPersona.modelConfig || defaultModelConfig;
  const defaultDebate = defaultPersona.debateConfig || defaultDebateConfig;
  return {
    id: defaultPersona.id,
    name: customPersona.name !== undefined ? customPersona.name : defaultPersona.name,
    avatar: customPersona.avatar !== undefined ? customPersona.avatar : (defaultPersona.avatar || null),
    avatar_url: customPersona.avatar_url !== undefined ? customPersona.avatar_url : (customPersona.avatar !== undefined ? customPersona.avatar : null),
    color: customPersona.color !== undefined ? customPersona.color : defaultPersona.color,
    styleTag: customPersona.styleTag !== undefined ? customPersona.styleTag : (defaultPersona.styleTag || defaultPersona.style),
    style: customPersona.style !== undefined ? customPersona.style : defaultPersona.style,
    personality: customPersona.personality !== undefined ? customPersona.personality : (defaultPersona.personality || ''),
    replyStyle: customPersona.replyStyle !== undefined ? customPersona.replyStyle : defaultPersona.replyStyle,
    typicalPhrases: customPersona.typicalPhrases !== undefined ? customPersona.typicalPhrases : defaultPersona.typicalPhrases,
    expertise: customPersona.expertise !== undefined ? customPersona.expertise : (defaultPersona.expertise || []),
    speakingTraits: customPersona.speakingTraits !== undefined ? customPersona.speakingTraits : (defaultPersona.speakingTraits || ''),
    keywords: customPersona.keywords !== undefined ? customPersona.keywords : defaultPersona.keywords,
    firstSpeakerTopics: customPersona.firstSpeakerTopics !== undefined ? customPersona.firstSpeakerTopics : (defaultPersona.firstSpeakerTopics || []),
    messageLength: customPersona.messageLength !== undefined ? customPersona.messageLength : defaultPersona.messageLength,
    debateTendency: customPersona.debateTendency !== undefined ? customPersona.debateTendency : (defaultPersona.debateTendency || 'medium'),
    questionProbability: customPersona.questionProbability !== undefined ? customPersona.questionProbability : (defaultPersona.questionProbability ?? 0.3),
    silenceProbability: customPersona.silenceProbability !== undefined ? customPersona.silenceProbability : (defaultPersona.silenceProbability ?? 0.1),
    refusalProbability: customPersona.refusalProbability !== undefined ? customPersona.refusalProbability : (defaultPersona.refusalProbability ?? 0),
    speakingOrder: customPersona.speakingOrder !== undefined ? customPersona.speakingOrder : (defaultPersona.speakingOrder ?? 3),
    preferredRole: customPersona.preferredRole !== undefined ? customPersona.preferredRole : (defaultPersona.preferredRole || 'analyst'),
    customRoleName: customPersona.customRoleName !== undefined ? customPersona.customRoleName : (defaultPersona.customRoleName || ''),
    responseConfig: customPersona.responseConfig !== undefined ? { ...defaultResp, ...customPersona.responseConfig } : defaultResp,
    socialConfig: customPersona.socialConfig !== undefined ? { ...defaultSocial, ...customPersona.socialConfig } : defaultSocial,
    modelConfig: customPersona.modelConfig !== undefined ? { ...defaultModel, ...customPersona.modelConfig } : defaultModel,
    debateConfig: customPersona.debateConfig !== undefined ? { ...defaultDebate, ...customPersona.debateConfig } : defaultDebate,
    // relationships:用户自定义覆盖默认(空对象表示走自动推断)
    relationships: customPersona.relationships !== undefined ? customPersona.relationships : (defaultPersona.relationships || {})
  };
}

export function buildMergedPersonas(customPersonas = {}, catalog = null) {
  const merged = {};
  const defaults = catalog ? Object.fromEntries(catalog.models.map(m => [m.id, { ...AI_PERSONAS[m.id], ...modelPersona(m) }])) : {};
  for (const [aiId, defaultPersona] of Object.entries(defaults)) {
    const custom = customPersonas[aiId] || {};
    merged[aiId] = mergePersona(defaultPersona, custom);
  }
  return merged;
}

router.get('/personas', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  const customPersonas = db.data.customPersonas || {};
  const merged = buildMergedPersonas(customPersonas, getCatalogData(db.data));

  // 无缓存头 - 确保前端始终获取最新数据
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  res.json({ success: true, personas: merged, _timestamp: Date.now() });
}));

// PATCH /api/personas/:aiId - 实时部分更新人设（轻量级，快速生效）
const updatePersonaHandler = asyncHandler(async (req, res) => {
  const { aiId } = req.params;
  const resolvedAiId = await resolveAiId(req, res);
  if (!resolvedAiId) return;

  const db = await req.getUserDb();

  const updates = req.body;
  if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
    return res.status(400).json({ error: '更新数据不能为空' });
  }

  await withWriteLock(req.userId, async () => {
    await db.read();

    if (!db.data.customPersonas) {
      db.data.customPersonas = {};
    }
    if (!db.data.customPersonas[resolvedAiId]) {
      db.data.customPersonas[resolvedAiId] = {};
    }

    // 支持嵌套对象的部分更新
    for (const key of Object.keys(updates)) {
      if (!PERSONA_ALLOWED_FIELDS.includes(key)) continue;

      if (PERSONA_NESTED_FIELDS.includes(key) && updates[key] && typeof updates[key] === 'object') {
        if (!db.data.customPersonas[resolvedAiId][key]) {
          db.data.customPersonas[resolvedAiId][key] = {};
        }
        Object.assign(db.data.customPersonas[resolvedAiId][key], updates[key]);
      } else {
        db.data.customPersonas[resolvedAiId][key] = updates[key];
      }
    }

    // 标记最后更新时间戳
    if (!db.data.customPersonas[resolvedAiId]._meta || typeof db.data.customPersonas[resolvedAiId]._meta !== 'object') {
      db.data.customPersonas[resolvedAiId]._meta = {};
    }
    db.data.customPersonas[resolvedAiId]._meta.updatedAt = Date.now();

    await db.write();
  });

  // 立即重新加载调度器缓存（而非仅删除），确保下一次AI调用使用最新人设
  await loadCustomPersonas(req.userId);

  // 通过WebSocket广播人设更新，确保前端和其他进程立即感知变更
  broadcastPersonaUpdate(resolvedAiId, req.userId).catch(err =>
    console.error('广播人设更新失败:', err)
  );

  // 构建合并后的人设返回
  const custom = db.data.customPersonas[resolvedAiId];
  const defaultPersona = modelPersona(getCatalogData(db.data).models.find(m => m.id === resolvedAiId) || { id: resolvedAiId, name: resolvedAiId });
  const merged = mergePersona(defaultPersona, custom);

  // 确保响应不会被缓存
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ success: true, persona: merged, _timestamp: Date.now() });
});

router.put('/personas/:aiId', validateBody(updatePersonaSchema), updatePersonaHandler);
router.patch('/personas/:aiId', validateBody(updatePersonaSchema), updatePersonaHandler);

router.put('/personas/:aiId/reset', asyncHandler(async (req, res) => {
  const resolvedAiId = await resolveAiId(req, res);
  if (!resolvedAiId) return;
  const db = await req.getUserDb();
  await withWriteLock(req.userId, async () => {
    await db.read();
    if (db.data.customPersonas) delete db.data.customPersonas[resolvedAiId];
    await db.write();
  });
  // 立即重新加载调度器缓存，确保重置后下一次AI调用使用默认人设
  await loadCustomPersonas(req.userId);
  const defaultPersona = modelPersona(getCatalogData(db.data).models.find(m => m.id === resolvedAiId) || { id: resolvedAiId, name: resolvedAiId });
  const resetPersona = mergePersona(defaultPersona);

  // 通过WebSocket广播人设更新（重置为默认）
  broadcastPersonaUpdate(resolvedAiId, req.userId).catch(err =>
    console.error('广播人设重置更新失败:', err)
  );

  res.json({
    success: true,
    persona: resetPersona
  });
}));

export default router;
