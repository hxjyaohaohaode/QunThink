import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-image-annotation-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

let providerCalls = 0;
const provider = createServer(async (req, res) => {
  for await (const _chunk of req) { /* Drain the real HTTP request body. */ }
  providerCalls++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: '画面是一块红色背景' } }] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
process.env.AI_ALLOWED_LOCAL_ORIGINS = `http://127.0.0.1:${provider.address().port}`;
after(async () => {
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
});

const { initDatabase, initUserDatabase } = await import('../src/models/db.js');
const { initAuthDb } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { readCatalog, saveCatalog, recordCapabilityProbe } = await import('../src/services/ai/catalog.js');
const { annotateAndDescribe } = await import('../src/services/fileAnnotation/index.js');
const { runAsUser } = await import('../src/services/userScope.js');
await initDatabase(); await initAuthDb();

test('one image annotation reuses one verified vision result for search and media descriptions', async () => {
  const userId = crypto.randomUUID();
  const userDb = await initUserDatabase(userId);
  await provisionNewLocalMemoryAccount(userId, userDb);
  const catalog = await readCatalog(userId);
  catalog.providers.push({
    id: 'local_vision', name: '本地协议模拟', protocol: 'openai',
    baseUrl: process.env.AI_ALLOWED_LOCAL_ORIGINS + '/v1', enabled: true,
    keyRequired: true, apiKey: 'test-only-key'
  });
  catalog.models.push({
    id: 'image_vision_test', providerId: 'local_vision', name: '图片测试模型',
    model: 'future/vision-v100', enabled: true, capabilities: ['vision'],
    contextWindow: 32000, maxTokens: 1000, temperature: null,
    tokenParameter: 'max_tokens', color: '#6366f1'
  });
  catalog.defaults.vision = 'image_vision_test';
  await saveCatalog(userId, catalog);
  await recordCapabilityProbe(userId, 'image_vision_test', 'vision', { verified: true });

  const imagePath = path.join(process.env.DATA_DIR, 'sample.png');
  await fs.writeFile(imagePath, await sharp({ create: {
    width: 24, height: 24, channels: 3, background: { r: 255, g: 0, b: 0 }
  } }).png().toBuffer());
  const before = providerCalls;
  const result = await runAsUser(userId, () => annotateAndDescribe(
    imagePath, 'image/png', 'sample.png', 100, ''
  ));
  assert.equal(providerCalls - before, 1);
  assert.equal(result.annotation.source, 'vision');
  assert.equal(result.annotation.description, '画面是一块红色背景');
  assert.equal(result.description, result.annotation.description);
});
