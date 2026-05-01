import express from 'express';
import { withWriteLock } from '../models/db.js';
import { sanitizeObject, PROFILE_SANITIZE_CONFIG } from '../utils/sanitize.js';

const router = express.Router();

const PROFILE_ALLOWED_FIELDS = (process.env.PROFILE_EXTRA_FIELDS 
  ? ['nickname', 'gender', 'age', 'height', 'weight', 'occupation', 'education', 'hobbies', 'personality', 'goals', 'bio', ...process.env.PROFILE_EXTRA_FIELDS.split(',')]
  : ['nickname', 'gender', 'age', 'height', 'weight', 'occupation', 'education', 'hobbies', 'personality', 'goals', 'bio']
);

router.get('/profile', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    res.json({ success: true, profile: db.data.userProfile });
  } catch (error) {
    console.error('获取用户画像错误:', error);
    res.status(500).json({ success: false, error: '获取用户画像失败', details: error.message });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const db = await req.getUserDb();
    await db.read();
    const sanitizedBody = sanitizeObject(req.body, PROFILE_SANITIZE_CONFIG);
    const updates = sanitizedBody;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: '更新数据不能为空' });
    }
    for (const key of Object.keys(updates)) {
      if (PROFILE_ALLOWED_FIELDS.includes(key)) {
        db.data.userProfile[key] = updates[key];
      }
    }
    await withWriteLock(req.userId, async () => {
      await db.write();
    });
    res.json({ success: true, profile: db.data.userProfile });
  } catch (error) {
    console.error('更新用户画像错误:', error);
    res.status(500).json({ success: false, error: '更新用户画像失败', details: error.message });
  }
});

export default router;
