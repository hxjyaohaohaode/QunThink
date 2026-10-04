import { getUserDb } from '../models/db.js';
import { runAsUser } from '../services/userScope.js';

export function injectUserDb(req, res, next) {
  const requestPath = req.path || req.originalUrl?.split('?')[0] || '';
  if (requestPath.startsWith('/api/auth/')) {
    return next();
  }

  const userId = req.userId;
  if (!userId) {
    // 公开路径（如签名下载）不携带身份：不注入但放行；
    // 受保护路径的 userId 已由认证中间件保证。
    return next();
  }

  req.getUserDb = async () => {
    return getUserDb(userId);
  };

  runAsUser(userId, next);
}

export function requireGroupMembership(req, res, next) {
  const groupId = req.params.id || req.params.groupId || req.params.group_id || req.body?.group_id;
  if (!groupId) {
    return res.status(400).json({ error: '缺少群组ID' });
  }

  if (typeof req.getUserDb !== 'function') {
    return res.status(500).json({ error: '用户数据库未注入' });
  }

  req.getUserDb().then(async db => {
    try {
      await db.read();
    } catch (err) {
      console.error('群组权限检查读取失败:', err);
      return res.status(500).json({ error: '服务器错误' });
    }
    const group = db.data.groups?.find(g => g.id === groupId);
    if (!group) {
      return res.status(404).json({ error: '群组不存在或无权访问' });
    }
    next();
  }).catch(err => {
    console.error('群组权限检查失败:', err);
    res.status(500).json({ error: '服务器错误' });
  });
}

export function requireGroupOwner(req, res, next) {
  const groupId = req.params.id || req.params.groupId || req.params.group_id || req.body?.group_id;
  if (!groupId) {
    return res.status(400).json({ error: '缺少群组ID' });
  }

  if (typeof req.getUserDb !== 'function') {
    return res.status(500).json({ error: '用户数据库未注入' });
  }

  req.getUserDb().then(async db => {
    try {
      await db.read();
    } catch (err) {
      console.error('群主权限检查读取失败:', err);
      return res.status(500).json({ error: '服务器错误' });
    }
    const group = db.data.groups?.find(g => g.id === groupId);
    if (!group) {
      return res.status(404).json({ error: '群组不存在' });
    }
    const ownerId = group.created_by || group.owner;
    if (!ownerId || ownerId !== req.userId) {
      return res.status(403).json({ error: '仅群主可执行此操作' });
    }
    next();
  }).catch(err => {
    console.error('群主权限检查失败:', err);
    res.status(500).json({ error: '服务器错误' });
  });
}
