import express from 'express';
import { withWriteLock } from '../models/db.js';
import { sanitizeObject, PROFILE_SANITIZE_CONFIG } from '../utils/sanitize.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

const BASE_PROFILE_FIELDS = ['nickname', 'gender', 'age', 'height', 'weight', 'occupation', 'education', 'hobbies', 'personality', 'goals', 'bio', 'avatar_url'];
const PROFILE_ALLOWED_FIELDS = (process.env.PROFILE_EXTRA_FIELDS
  ? [...BASE_PROFILE_FIELDS, ...process.env.PROFILE_EXTRA_FIELDS.split(',')]
  : BASE_PROFILE_FIELDS);

const PROFILE_STRING_FIELDS = new Set(['nickname', 'gender', 'occupation', 'education', 'goals', 'bio', 'avatar_url']);
const PROFILE_NUMBER_FIELDS = new Set(['age', 'height', 'weight']);
const PROFILE_ARRAY_FIELDS = new Set(['hobbies', 'personality']);
const PROFILE_STRING_MAX_LENGTH = 2000;
const PROFILE_ARRAY_MAX_ITEMS = 50;
const PROFILE_ARRAY_ITEM_MAX_LENGTH = 100;

const DEFAULT_USER_PROFILE = {
  nickname: '',
  gender: '',
  age: null,
  height: null,
  weight: null,
  occupation: '',
  education: '',
  hobbies: [],
  personality: [],
  goals: '',
  bio: ''
};

function validateProfileUpdates(updates) {
  const validated = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!PROFILE_ALLOWED_FIELDS.includes(key)) {
      return { error: `不支持的字段：${key}` };
    }
    if (PROFILE_STRING_FIELDS.has(key)) {
      if (typeof value !== 'string' || value.length > PROFILE_STRING_MAX_LENGTH) {
        return { error: `字段 ${key} 必须为不超过${PROFILE_STRING_MAX_LENGTH}字符的字符串` };
      }
      validated[key] = value;
    } else if (PROFILE_NUMBER_FIELDS.has(key)) {
      if (value !== null && typeof value !== 'number') {
        return { error: `字段 ${key} 必须为数字或null` };
      }
      validated[key] = value;
    } else if (PROFILE_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(value)
        || value.length > PROFILE_ARRAY_MAX_ITEMS
        || value.some(item => typeof item !== 'string' || item.length > PROFILE_ARRAY_ITEM_MAX_LENGTH)) {
        return { error: `字段 ${key} 必须为字符串数组（每项不超过${PROFILE_ARRAY_ITEM_MAX_LENGTH}字符，最多${PROFILE_ARRAY_MAX_ITEMS}项）` };
      }
      validated[key] = value;
    } else if (typeof value !== 'string' || value.length > PROFILE_STRING_MAX_LENGTH) {
      return { error: `字段 ${key} 必须为不超过${PROFILE_STRING_MAX_LENGTH}字符的字符串` };
    } else {
      validated[key] = value;
    }
  }
  return { validated };
}

router.get('/profile', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  res.json({ success: true, profile: db.data.userProfile });
}));

router.put('/profile', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();
  if (!db.data.userProfile || typeof db.data.userProfile !== 'object' || Array.isArray(db.data.userProfile)) {
    db.data.userProfile = JSON.parse(JSON.stringify(DEFAULT_USER_PROFILE));
  }
  const updates = sanitizeObject(req.body, PROFILE_SANITIZE_CONFIG);
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: '更新数据不能为空' });
  }
  const { validated, error } = validateProfileUpdates(updates);
  if (error) {
    return res.status(400).json({ error });
  }
  for (const [key, value] of Object.entries(validated)) {
    db.data.userProfile[key] = value;
  }
  await withWriteLock(req.userId, async () => {
    await db.write();
  });
  res.json({ success: true, profile: db.data.userProfile });
}));

export default router;
