import express from 'express';
import { withWriteLock } from '../models/db.js';
import { AI_PERSONAS } from '../config/personas.js';
import { invalidateCustomPersonasCache } from '../services/scheduler/index.js';
import { validateBody, updatePersonaSchema } from '../validators/index.js';
import { broadcastPersonaUpdate, broadcastPersonasSync } from '../websocket/index.js';

const router = express.Router();

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

export function buildMergedPersonas(customPersonas = {}) {
  const merged = {};
  for (const [aiId, defaultPersona] of Object.entries(AI_PERSONAS)) {
    const custom = customPersonas[aiId] || {};
    merged[aiId] = mergePersona(defaultPersona, custom);
  }
  return merged;
}

router.get('/personas', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const customPersonas = db.data.customPersonas || {};
    const merged = buildMergedPersonas(customPersonas);

    // 无缓存头 - 确保前端始终获取最新数据
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    res.json({ success: true, personas: merged, _timestamp: Date.now() });
  } catch (error) {
    console.error('获取AI人设错误:', error);
    res.status(500).json({ success: false, error: '获取AI人设失败', details: error.message });
  }
});

router.put('/personas/:aiId', validateBody(updatePersonaSchema), async (req, res) => {
  try {
    const { aiId } = req.params;
    if (!AI_PERSONAS[aiId]) {
      return res.status(404).json({ error: '未找到该AI' });
    }
    const db = await req.getUserDb();
    await db.read();
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: '更新数据不能为空' });
    }
    const allowedFields = [
      'name', 'avatar', 'avatar_url', 'color', 'styleTag', 'style', 'replyStyle', 'personality',
      'typicalPhrases', 'expertise', 'speakingTraits', 'keywords', 'messageLength',
      'responseConfig', 'socialConfig', 'modelConfig', 'debateConfig',
      'preferredRole', 'customRoleName', 'questionProbability', 'debateTendency',
      'silenceProbability', 'refusalProbability', 'speakingOrder', 'firstSpeakerTopics',
      'relationships'
    ];
    if (!db.data.customPersonas[aiId]) {
      db.data.customPersonas[aiId] = {};
    }
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        if (key === 'responseConfig' && updates.responseConfig) {
          db.data.customPersonas[aiId].responseConfig = {
            ...db.data.customPersonas[aiId].responseConfig,
            ...updates.responseConfig
          };
        } else if (key === 'socialConfig' && updates.socialConfig) {
          db.data.customPersonas[aiId].socialConfig = {
            ...db.data.customPersonas[aiId].socialConfig,
            ...updates.socialConfig
          };
        } else if (key === 'modelConfig' && updates.modelConfig) {
          db.data.customPersonas[aiId].modelConfig = {
            ...db.data.customPersonas[aiId].modelConfig,
            ...updates.modelConfig
          };
        } else if (key === 'debateConfig' && updates.debateConfig) {
          db.data.customPersonas[aiId].debateConfig = {
            ...db.data.customPersonas[aiId].debateConfig,
            ...updates.debateConfig
          };
        } else {
          db.data.customPersonas[aiId][key] = updates[key];
        }
      }
    }
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
    invalidateCustomPersonasCache(req.userId);
    const custom = db.data.customPersonas[aiId];
    const defaultPersona = AI_PERSONAS[aiId];
    const merged = mergePersona(defaultPersona, custom);
    res.json({ success: true, persona: merged });
  } catch (error) {
    console.error('更新AI人设错误:', error);
    res.status(500).json({ success: false, error: '更新AI人设失败', details: error.message });
  }
});

// PATCH /api/personas/:aiId - 实时部分更新人设（轻量级，快速生效）
router.patch('/personas/:aiId', async (req, res) => {
  try {
    const { aiId } = req.params;
    if (!AI_PERSONAS[aiId]) {
      return res.status(404).json({ error: '未找到该AI' });
    }

    const db = await req.getUserDb();
    await db.read();

    const updates = req.body;
    if (!updates || typeof updates !== 'object' || Object.keys(updates).length === 0) {
      return res.status(400).json({ error: '更新数据不能为空' });
    }

    const allowedFields = [
      'name', 'avatar', 'avatar_url', 'color', 'styleTag', 'style', 'replyStyle', 'personality',
      'typicalPhrases', 'expertise', 'speakingTraits', 'keywords', 'messageLength',
      'responseConfig', 'socialConfig', 'modelConfig', 'debateConfig',
      'preferredRole', 'customRoleName', 'questionProbability', 'debateTendency',
      'silenceProbability', 'refusalProbability', 'speakingOrder', 'firstSpeakerTopics',
      'relationships'
    ];

    if (!db.data.customPersonas) {
      db.data.customPersonas = {};
    }
    if (!db.data.customPersonas[aiId]) {
      db.data.customPersonas[aiId] = {};
    }

    // 支持嵌套对象的部分更新
    const nestedKeys = ['responseConfig', 'socialConfig', 'modelConfig', 'debateConfig', 'relationships'];
    for (const key of Object.keys(updates)) {
      if (!allowedFields.includes(key)) continue;

      if (nestedKeys.includes(key) && updates[key] && typeof updates[key] === 'object') {
        if (!db.data.customPersonas[aiId][key]) {
          db.data.customPersonas[aiId][key] = {};
        }
        Object.assign(db.data.customPersonas[aiId][key], updates[key]);
      } else {
        db.data.customPersonas[aiId][key] = updates[key];
      }
    }

    // 标记最后更新时间戳
    db.data.customPersonas[aiId]._updatedAt = Date.now();

    // 立即写入并失效所有相关缓存
    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    // 失效调度器中的自定义人设缓存
    invalidateCustomPersonasCache(req.userId);

    // 构建合并后的人设返回
    const custom = db.data.customPersonas[aiId];
    const defaultPersona = AI_PERSONAS[aiId];
    const merged = mergePersona(defaultPersona, custom);

    // 确保响应不会被缓存
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ success: true, persona: merged, _timestamp: Date.now() });
  } catch (error) {
    console.error('实时更新AI人设错误:', error);
    res.status(500).json({ success: false, error: '实时更新AI人设失败', details: error.message });
  }
});

router.put('/personas/:aiId/reset', async (req, res) => {
  try {
    const { aiId } = req.params;
    if (!AI_PERSONAS[aiId]) {
      return res.status(404).json({ error: '未找到该AI' });
    }
    const db = await req.getUserDb();
    await db.read();
    delete db.data.customPersonas[aiId];
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
    invalidateCustomPersonasCache(req.userId);
    const defaultPersona = AI_PERSONAS[aiId];
    const resetPersona = mergePersona(defaultPersona);

    // 通过WebSocket广播人设更新（重置为默认）
    broadcastPersonaUpdate(aiId, req.userId).catch(err =>
      console.error('广播人设重置更新失败:', err)
    );

    res.json({
      success: true,
      persona: resetPersona
    });
  } catch (error) {
    console.error('重置AI人设错误:', error);
    res.status(500).json({ success: false, error: '重置AI人设失败', details: error.message });
  }
});

export default router;
