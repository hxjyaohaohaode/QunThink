import express from 'express';
import { createRateLimiter } from '../middleware/rateLimiter.js';
import { createSiteBasicChat } from '../services/ai/siteBasicChat.js';

export function createSiteBasicChatRouter(service = createSiteBasicChat()) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.session || !req.userId || req.session.userId !== req.userId) {
      return res.status(401).json({ error: '站点基础 AI 需要会话登录' });
    }
    next();
  });
  router.get('/status', async (_req, res) => res.json(await service.status()));
  router.post('/chat', createRateLimiter({ windowMs: 60000, maxRequests: 3 }), async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    const timer = setTimeout(() => controller.abort(), 25000);
    try { res.json(await service.chat(req.body, { signal: controller.signal })); }
    catch (error) {
      const known = error.siteAiPublic === true && [400, 409, 429, 502, 503].includes(error.status);
      res.status(known ? error.status : 503).json({ error: known ? error.message : '站点基础 AI 暂不可用' });
    } finally { clearTimeout(timer); res.off('close', abort); }
  });
  return router;
}
export default createSiteBasicChatRouter();
