import express from 'express';
import { getDb } from '../models/db.js';
import { AI_PERSONAS } from '../config/personas.js';

const router = express.Router();

router.get('/personas', async (req, res) => {
  try {
    const db = getDb();
    await db.read();
    const customPersonas = db.data.customPersonas || {};
    const merged = {};
    for (const [aiId, defaultPersona] of Object.entries(AI_PERSONAS)) {
      const custom = customPersonas[aiId] || {};
      merged[aiId] = {
        id: defaultPersona.id,
        name: custom.name !== undefined ? custom.name : defaultPersona.name,
        style: custom.style !== undefined ? custom.style : defaultPersona.style,
        replyStyle: custom.replyStyle !== undefined ? custom.replyStyle : defaultPersona.replyStyle,
        personality: custom.personality !== undefined ? custom.personality : '',
        typicalPhrases: custom.typicalPhrases !== undefined ? custom.typicalPhrases : defaultPersona.typicalPhrases,
        color: custom.color !== undefined ? custom.color : defaultPersona.color,
        avatar_url: custom.avatar_url !== undefined ? custom.avatar_url : null,
        keywords: defaultPersona.keywords,
        firstSpeakerTopics: defaultPersona.firstSpeakerTopics,
        speakingOrder: defaultPersona.speakingOrder,
        messageLength: defaultPersona.messageLength,
        questionProbability: defaultPersona.questionProbability,
        debateTendency: defaultPersona.debateTendency,
        silenceProbability: defaultPersona.silenceProbability
      };
    }
    res.json({ success: true, personas: merged });
  } catch (error) {
    console.error('获取AI人设错误:', error);
    res.status(500).json({ success: false, error: '获取AI人设失败', details: error.message });
  }
});

router.put('/personas/:aiId', async (req, res) => {
  try {
    const { aiId } = req.params;
    if (!AI_PERSONAS[aiId]) {
      return res.status(404).json({ error: '未找到该AI' });
    }
    const db = getDb();
    await db.read();
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: '更新数据不能为空' });
    }
    const allowedFields = ['name', 'style', 'replyStyle', 'personality', 'typicalPhrases', 'color', 'avatar_url'];
    if (!db.data.customPersonas[aiId]) {
      db.data.customPersonas[aiId] = {};
    }
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        db.data.customPersonas[aiId][key] = updates[key];
      }
    }
    await db.write();
    const custom = db.data.customPersonas[aiId];
    const defaultPersona = AI_PERSONAS[aiId];
    const merged = {
      id: defaultPersona.id,
      name: custom.name !== undefined ? custom.name : defaultPersona.name,
      style: custom.style !== undefined ? custom.style : defaultPersona.style,
      replyStyle: custom.replyStyle !== undefined ? custom.replyStyle : defaultPersona.replyStyle,
      personality: custom.personality !== undefined ? custom.personality : '',
      typicalPhrases: custom.typicalPhrases !== undefined ? custom.typicalPhrases : defaultPersona.typicalPhrases,
      color: custom.color !== undefined ? custom.color : defaultPersona.color
    };
    res.json({ success: true, persona: merged });
  } catch (error) {
    console.error('更新AI人设错误:', error);
    res.status(500).json({ success: false, error: '更新AI人设失败', details: error.message });
  }
});

router.put('/personas/:aiId/reset', async (req, res) => {
  try {
    const { aiId } = req.params;
    if (!AI_PERSONAS[aiId]) {
      return res.status(404).json({ error: '未找到该AI' });
    }
    const db = getDb();
    await db.read();
    delete db.data.customPersonas[aiId];
    await db.write();
    const defaultPersona = AI_PERSONAS[aiId];
    res.json({
      success: true,
      persona: {
        id: defaultPersona.id,
        name: defaultPersona.name,
        style: defaultPersona.style,
        replyStyle: defaultPersona.replyStyle,
        personality: '',
        typicalPhrases: defaultPersona.typicalPhrases
      }
    });
  } catch (error) {
    console.error('重置AI人设错误:', error);
    res.status(500).json({ success: false, error: '重置AI人设失败', details: error.message });
  }
});

export default router;
