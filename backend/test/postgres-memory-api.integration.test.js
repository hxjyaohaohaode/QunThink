import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const url = process.env.QUNTHINK_TEST_MEMORY_TLS_URL;
test('real PostgreSQL independent ledger protects every persisted memory API and restored source routes', { skip: !url }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qt-pg-memory-api-'));
  Object.assign(process.env, { ENCRYPTION_KEY: randomBytes(32).toString('hex'), NODE_ENV: 'test', AUTH_MODE: 'session', DATA_DIR: root,
    SUPABASE_DB_URL: url, SUPABASE_DB_CA_FILE: process.env.QUNTHINK_TEST_MEMORY_TLS_CA,
    MEMORY_DELETION_DATABASE_URL: process.env.QUNTHINK_TEST_MEMORY_LEDGER_TLS_URL,
    MEMORY_DELETION_DATABASE_CA_FILE: process.env.QUNTHINK_TEST_MEMORY_TLS_CA,
    MEMORY_DELETION_INSTALLATION_ID: randomUUID(), MEMORY_DELETION_MODE: 'independent',
    MEMORY_DELETION_CONNECTION_MODE: 'session' });
  const { buildPostgresTlsConfig } = await import('../src/models/postgresTls.js');
  const { ensureKvSchema, getPool, closeSupabaseConnection } = await import('../src/models/supabaseAdapter.js');
  const { installPostgresLedger } = await import('../src/services/memory/postgresLedgerInstallation.js');
  const { closePostgresMemoryLedger } = await import('../src/services/memory/postgresDeletionLedger.js');
  const businessPool = await getPool();
  const ledgerPool = new pg.Pool(buildPostgresTlsConfig(process.env.MEMORY_DELETION_DATABASE_URL, process.env.MEMORY_DELETION_DATABASE_CA_FILE));
  try {
    await ensureKvSchema(businessPool);
    await installPostgresLedger({ businessPool, ledgerPool, installationId: process.env.MEMORY_DELETION_INSTALLATION_ID });
    const { initDatabase, getUserDb, clearUserDbCache, withWriteLock } = await import('../src/models/db.js');
    const { initAuthDb } = await import('../src/models/authDb.js');
    const { initializeKeyManager } = await import('../src/utils/keyManager.js');
    await initializeKeyManager();
    await initDatabase(); await initAuthDb();
    const { createTestApp } = await import('./helpers/createTestApp.js');
    const request = (await import('supertest')).default(createTestApp());
    const registered = await request.post('/api/auth/register').send({ username: 'synthetic_pg_owner', password: 'Synthetic123!', nickname: 'Fixture' });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const cookie = registered.headers['set-cookie'];
    const userId = registered.body.user.id;
    const db = await getUserDb(userId);
    const groupId = db.data.groups[0].id;
    const msg = { id: 'synthetic_message', group_id: groupId, sender_id: userId, sender_type: 'user', content: 'synthetic source searchable', metadata: {}, created_at: new Date().toISOString() };
    await withWriteLock(userId, async () => { await db.read(); db.data.messages.push(msg); await db.write(); });
    const stored = await request.post('/api/memory/store').set('Cookie', cookie).set('Idempotency-Key', 'synthetic-note').send({ content: 'synthetic note searchable', category: 'note' });
    assert.equal(stored.status, 200, JSON.stringify(stored.body));
    const noteId = stored.body.memoryId;
    assert.equal((await request.post('/api/memory/store').set('Cookie', cookie).set('Idempotency-Key', 'synthetic-note').send({ content: 'synthetic note searchable', category: 'note' })).body.replayed, true);
    const quote = await request.post('/api/memory/store-messages').set('Cookie', cookie).send({ messageIds: [msg.id], groupId });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    const quoteId = quote.body.results[0].memoryId;
    for (const endpoint of ['/api/memory', '/api/memory/stats', '/api/memory/digest', `/api/memory/${noteId}`]) {
      const response = await request.get(endpoint).set('Cookie', cookie); assert.equal(response.status, 200, endpoint + JSON.stringify(response.body));
    }
    for (const [endpoint, body] of [
      ['/api/memory/retrieve', { query: 'searchable' }],
      ['/api/memory/retrieve-for-conversation', { groupId }],
      ['/api/memory/reference', { memoryId: quoteId, context: { content: 'synthetic', groupId } }],
      [`/api/memory/${noteId}/correct`, { content: 'synthetic corrected', expectedRevision: 0 }]
    ]) { const response = await request.post(endpoint).set('Cookie', cookie).send(body); assert.equal(response.status, 200, endpoint + JSON.stringify(response.body)); }
    const backup = await businessPool.query('SELECT key,data,revision FROM kv_store');
    assert.equal((await request.post(`/api/memory/${noteId}/forget`).set('Cookie', cookie).send({})).status, 200);
    const deletion = await request.delete(`/api/messages/${msg.id}`).set('Cookie', cookie);
    assert.equal(deletion.status, 200, JSON.stringify(deletion.body));
    // Entire application business store restored, ledger DB left untouched.
    await businessPool.query('TRUNCATE kv_store');
    for (const row of backup.rows) await businessPool.query('INSERT INTO kv_store(key,data,revision) VALUES($1,$2,$3)', [row.key,row.data,row.revision]);
    clearUserDbCache(userId);
    assert.equal((await request.get(`/api/memory/${noteId}`).set('Cookie', cookie)).status, 410);
    assert.equal((await request.get(`/api/memory/${quoteId}`).set('Cookie', cookie)).status, 410);
    const messages = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', cookie);
    assert.equal(messages.status, 200, JSON.stringify(messages.body));
    assert.equal(JSON.stringify(messages.body).includes('synthetic source searchable'), false);
    const source = await import('../src/services/memory/persistentMemory.js');
    const sourceDb = await getUserDb(userId);
    await withWriteLock(userId, async () => {
      const db = sourceDb;
      await db.read();
      const revision = { ...msg, id: 'synthetic_revision' };
      db.data.messages.push(revision);
      db.data.files.push({ id: 'synthetic_file', group_id: groupId, owner_user_id: userId });
      await db.write();
      await source.markMessageRevisionRevoked(userId, db, revision);
      assert.equal((await source.readableSourceMessages(userId, db)).some(item => item.id === revision.id), false);
      await source.markFileDeleted(userId, db, groupId, 'synthetic_file');
      assert.equal((await source.readableSourceFiles(userId, db)).some(item => item.id === 'synthetic_file'), false);
      await source.markGroupDeleted(userId, db, groupId);
      assert.equal((await source.readableSourceGroups(userId, db)).some(item => item.id === groupId), false);
    });
    const savedUrl = process.env.MEMORY_DELETION_DATABASE_URL;
    delete process.env.MEMORY_DELETION_DATABASE_URL;
    const missing = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', cookie);
    assert.equal(missing.status, 503, JSON.stringify(missing.body));
    process.env.MEMORY_DELETION_DATABASE_URL = savedUrl;
    process.env.ADMIN_USER_IDS = userId;
    assert.equal((await request.post('/api/memory/clear').set('Cookie', cookie).send({ confirm: 'CLEAR_ALL_MEMORIES' })).status, 200);
    const savedConfig = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MEMORY_DELETION_')));
    for (const key of Object.keys(savedConfig)) delete process.env[key];
    assert.equal((await request.get(`/api/groups/${groupId}/messages`).set('Cookie', cookie)).status, 503, 'persisted marker prevents missing-config downgrade');
    Object.assign(process.env, savedConfig);
    // Legacy remains usable when neither marker nor any independent config exists.
    await businessPool.query("DELETE FROM kv_store WHERE key='memory:deletion-installation'");
    for (const key of Object.keys(process.env).filter(key => key.startsWith('MEMORY_DELETION_'))) delete process.env[key];
    const legacy = await request.get(`/api/groups/${groupId}/messages`).set('Cookie', cookie);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal((await request.get('/api/memory').set('Cookie', cookie)).status, 503);
  } finally { await closePostgresMemoryLedger(); await ledgerPool.end(); await closeSupabaseConnection(); await fs.rm(root, { recursive: true, force: true }); }
});
