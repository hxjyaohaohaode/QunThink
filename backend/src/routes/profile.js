import express from 'express';
import { getDb } from '../models/db.js';

const router = express.Router();

router.get('/profile', async (req, res) => {
  try {
    const db = getDb();
    await db.read();
    res.json({ success: true, profile: db.data.userProfile });
  } catch (error) {
    console.error('获取用户画像错误:', error);
    res.status(500).json({ success: false, error: '获取用户画像失败', details: error.message });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const db = getDb();
    await db.read();
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: '更新数据不能为空' });
    }
    const allowedFields = ['nickname', 'gender', 'age', 'height', 'weight', 'occupation', 'education', 'hobbies', 'personality', 'goals', 'bio'];
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        db.data.userProfile[key] = updates[key];
      }
    }
    await db.write();
    res.json({ success: true, profile: db.data.userProfile });
  } catch (error) {
    console.error('更新用户画像错误:', error);
    res.status(500).json({ success: false, error: '更新用户画像失败', details: error.message });
  }
});

export default router;
