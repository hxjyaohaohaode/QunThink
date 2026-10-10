import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createSiteBasicChatRouter } from '../src/routes/siteBasicChat.js';
import { cleanup } from '../src/middleware/rateLimiter.js';
function appFor(session, service) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.userId = 'fixture-user'; req.session = session; next(); });
  app.use('/api/site-ai', createSiteBasicChatRouter(service)); return app;
}
test('dev-header identity cannot access shared AI without actual session', async () => {
  let calls = 0; const app = appFor(null, { status: async () => { calls++; return {}; }, chat: async () => { calls++; return {}; } });
  assert.equal((await request(app).get('/api/site-ai/status')).status, 401);
  assert.equal((await request(app).post('/api/site-ai/chat').send({})).status, 401); assert.equal(calls, 0);
});
test('mismatched session cannot access shared AI', async () => {
  const app = appFor({ userId: 'other' }, {}); assert.equal((await request(app).get('/api/site-ai/status')).status, 401);
});
test('session status has no-store and internal exception text is sanitized', async () => {
  const app = appFor({ userId: 'fixture-user' }, { status: async () => ({ available: false }), chat: async () => { throw Object.assign(new Error('PRIVATE_DATABASE_PATH'), { status: 503 }); } });
  const result = await request(app).get('/api/site-ai/status'); assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  const error = await request(app).post('/api/site-ai/chat').send({}); assert.equal(error.status, 503); assert.doesNotMatch(JSON.stringify(error.body), /PRIVATE/);
});
test.after(() => cleanup());
