import express from 'express';
import { withWriteLock } from '../models/db.js';

const router = express.Router();

const DEFAULT_VENDORS = ['deepseek', 'zhipu', 'mimo', 'qwen'];

function sanitizeApiConfig(body) {
  const config = {};
  for (const vendor of DEFAULT_VENDORS) {
    if (body[vendor] && typeof body[vendor] === 'object') {
      config[vendor] = {
        apiKey: typeof body[vendor].apiKey === 'string' ? body[vendor].apiKey.trim() : '',
        baseUrl: typeof body[vendor].baseUrl === 'string' ? body[vendor].baseUrl.trim() : ''
      };
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

// GET /api/user/apiconfig - 获取用户自定义API配置
router.get('/apiconfig', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const aiApiConfigs = db.data.aiApiConfigs || getDefaultConfig();
    res.json({ success: true, config: aiApiConfigs });
  } catch (error) {
    console.error('获取API配置错误:', error);
    res.status(500).json({ success: false, error: '获取API配置失败', details: error.message });
  }
});

// PUT /api/user/apiconfig - 保存用户自定义API配置
router.put('/apiconfig', async (req, res) => {
  try {
    const body = req.body || {};
    const sanitized = sanitizeApiConfig(body);

    if (Object.keys(sanitized).length === 0) {
      return res.status(400).json({ success: false, error: '配置数据无效，请提供至少一个厂商的配置' });
    }

    const db = await req.getUserDb();
    await db.read();

    if (!db.data.aiApiConfigs) {
      db.data.aiApiConfigs = getDefaultConfig();
    }

    // 深度合并：只更新传入的字段
    for (const vendor of Object.keys(sanitized)) {
      if (!db.data.aiApiConfigs[vendor]) {
        db.data.aiApiConfigs[vendor] = { apiKey: '', baseUrl: '' };
      }
      if (sanitized[vendor].apiKey !== undefined) {
        db.data.aiApiConfigs[vendor].apiKey = sanitized[vendor].apiKey;
      }
      if (sanitized[vendor].baseUrl !== undefined) {
        db.data.aiApiConfigs[vendor].baseUrl = sanitized[vendor].baseUrl;
      }
    }

    await withWriteLock(req.userId, async () => {
      await db.write();
    });

    res.json({ success: true, config: db.data.aiApiConfigs });
  } catch (error) {
    console.error('保存API配置错误:', error);
    res.status(500).json({ success: false, error: '保存API配置失败', details: error.message });
  }
});

export default router;