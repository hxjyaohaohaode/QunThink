// Uses unchanged, hash-verified public533 production functions to create a
// neutral runtime-only sample, then exercises the real current HTTP consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
const same = (actual, expected) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'Runtime legacy values match; sample diagnostics are suppressed');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPublic533LegacySample } from './fixtures/generate-public-533-legacy.mjs';
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-page-legacy-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
const fixture = await createPublic533LegacySample();
process.env.ENCRYPTION_KEY = fixture.encryptionKey;
for (const key of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(key)) delete process.env[key];
const { initializeEmptyInstallation, initDatabase, createNewUserDatabase, getUserDb, clearUserDbCache } = await import('../src/models/db.js');
const { initAuthDb, getAuthDb, generateSessionToken } = await import('../src/models/authDb.js');
const { provisionNewLocalMemoryAccount } = await import('../src/services/memory/persistentMemory.js');
const { buildLegacyMessageOrder } = await import('../src/services/messageOrder.js');
const { sourceHash } = await import('../src/services/taskSources.js');
const { createTestApp } = await import('./helpers/createTestApp.js');
await initializeEmptyInstallation(); await initDatabase(); await initAuthDb();
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));

test('actual HTTP page decrypts all 51 runtime public533 ciphertexts while preserving receipt/source proof and physical order', async t => {
  assert.equal(sha(fixture.snapshot), fixture.provenance.snapshot_sha256);
  const fresh = await createNewUserDatabase(fixture.owner); await provisionNewLocalMemoryAccount(fixture.owner, fresh);
  const token = generateSessionToken(), auth = getAuthDb(); await auth.read();
  auth.data.users.push({ id: fixture.owner, username: 'synthetic-public533', password: 'not-used' });
  auth.data.sessions.push({ userId: fixture.owner, token, expires_at: new Date(Date.now() + 86400000).toISOString() }); await auth.write();
  const migrated = { ...structuredClone(fixture.snapshot), message_order: buildLegacyMessageOrder(fixture.snapshot, fixture.owner, { generationForGroup: () => randomUUID() }) };
  // Explicit offline fixture install, before exposing any of its HTTP history.
  await clearUserDbCache(fixture.owner);
  const file = path.join(process.env.DATA_DIR, 'users', `db_${fixture.owner}.json`), bytes = JSON.stringify(migrated);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  const server = createTestApp().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/groups/${fixture.snapshot.groups[0].id}/messages`;
    const get = async query => { const r = await fetch(`${endpoint}?order=sequence_v1&${query}`, { headers: { Cookie: `session_token=${token}` } }); const body = await r.json(); assert.equal(r.status, 200, 'Legacy HTTP page failed; response body suppressed'); return body; };
    const first = await get('limit=50'), second = await get(`limit=50&before_cursor=${first.before_cursor}`);
    assert.equal(first.messages.length, 50); assert.equal(second.messages.length, 1);
    const expectedIds = migrated.message_order.groups[0].bindings.map(row => row.message_id), rows = [...second.messages, ...first.messages];
    same(rows.map(row => row.id), expectedIds);
    const expectedText = new Map(fixture.snapshot.messages.map((message, i) => [message.id, fixture.expected_plaintext[i]]));
    for (const row of rows) assert.ok(row.content === expectedText.get(row.id), 'HTTP consumer returns the matching legacy plaintext');
    assert.ok(await fs.readFile(file, 'utf8') === bytes, 'HTTP reads preserve runtime fixture bytes');
    const current = await getUserDb(fixture.owner); assert.ok(JSON.stringify(current.data) === JSON.stringify(migrated), 'HTTP reads preserve complete original values');
    for (const version of [1, 2]) {
      assert.equal(sourceHash(current.data.messages, current, version), fixture.hashes[`all_v${version}`]);
      assert.equal(sourceHash(current.data.messages.slice(-40), current, version), fixture.hashes[`last40_v${version}`]);
    }
    same(current.data.taskCreateRequests, fixture.snapshot.taskCreateRequests); same(current.data.taskMetadataCommands, fixture.snapshot.taskMetadataCommands);
    assert.equal(sha(fixture.snapshot), fixture.provenance.snapshot_sha256);
    t.diagnostic(JSON.stringify({ producerCommit: fixture.provenance.public_commit, runtimeLegacyCiphertexts: 51, pages: [50, 1], actualHttp: true, oldHashV1V2AllAndLast40Unchanged: true, taskReceiptsUnchanged: true, physicalOrderUnchanged: true }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
