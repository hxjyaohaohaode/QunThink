import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'site-ai-budget-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); // synthetic fixture only
const { initDatabase } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb } = await import('../src/models/authDb.js');
const { reserveSiteAiBudget } = await import('../src/services/ai/siteBasicChat.js');
await initDatabase(); await initAuthDb();
const reset = async () => { const db = getAuthDb(); await db.read(); delete db.data.siteAiBudget; await db.write(); };
test('shared admission accepts exactly ten concurrent reservations per minute', async () => {
  await reset(); const now = Date.UTC(2026, 9, 10, 12);
  const results = await Promise.allSettled(Array.from({ length: 30 }, () => reserveSiteAiBudget(now)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  const saved = JSON.parse(await fs.readFile(process.env.AUTH_DB_PATH, 'utf8'));
  assert.equal(saved.siteAiBudget.count, 10); assert.equal(saved.siteAiBudget.recent.length, 10);
  await initAuthDb(); await assert.rejects(reserveSiteAiBudget(now + 1000), { status: 429 });
});
test('daily cap is persisted and resets only on UTC date change', async () => {
  await reset(); const now = Date.UTC(2026, 9, 10, 12);
  for (let i = 0; i < 100; i++) await reserveSiteAiBudget(now + i * 61000);
  await initAuthDb(); await assert.rejects(reserveSiteAiBudget(now + 101 * 61000), { status: 429 });
  await reserveSiteAiBudget(Date.UTC(2026, 9, 11));
  await getAuthDb().read(); assert.equal(getAuthDb().data.siteAiBudget.count, 1);
});
test('corrupt budget state cannot silently reset spend history', async () => {
  const db = getAuthDb(); await db.read(); db.data.siteAiBudget = { version: 1, count: 'broken', recent: [] }; await db.write();
  await assert.rejects(reserveSiteAiBudget(), { status: 503 });
});
test.after(async () => { await fs.rm(process.env.DATA_DIR, { recursive: true, force: true }); });
