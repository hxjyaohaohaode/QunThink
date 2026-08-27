import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import supertest from 'supertest';
import { createRateLimiter } from '../src/middleware/rateLimiter.js';

test('unauthenticated x-user-id cannot select a fresh rate-limit bucket', async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(createRateLimiter({ windowMs: 60_000, maxRequests: 1 }));
  app.get('/', (req, res) => res.json({ ok: true }));
  const request = supertest(app);

  assert.equal((await request.get('/').set('x-user-id', 'attacker-a')).status, 200);
  assert.equal((await request.get('/').set('x-user-id', 'attacker-b')).status, 429);
  assert.ok(true, 'spoofing the header did not bypass the IP bucket');
});
