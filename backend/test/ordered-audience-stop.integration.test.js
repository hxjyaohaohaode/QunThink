// Independent reproduction: execute the entire current debate module body;
// inject only imported model/persona/event dependencies and zero-delay sleep.
// Actual domain helper, commit wrapper, account JSON and deletion journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
const backend = new URL('../', import.meta.url);
const load = file => import(new URL(file, backend));
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-independent-audience-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name)) delete process.env[name];
const dbModule = await load('src/models/db.js'), auth = await load('src/models/authDb.js');
const memory = await load('src/services/memory/persistentMemory.js'), domain = await load('src/services/backgroundMessageCommit.js');
const scope = await load('src/services/userScope.js'), encryption = await load('src/utils/encryption.js');
await dbModule.initializeEmptyInstallation(); await dbModule.initDatabase(); await auth.initAuthDb();
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const source = await fs.readFile(new URL('src/services/debate/index.js', backend), 'utf8');
function evaluate(imports) {
 const executable = source.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2\s*;/g, (_, spec, quote, name) => {
  assert.ok(imports[name], `Explicit injected import required: ${name}`);
  const binding = spec.trim().startsWith('{') ? spec.trim().replace(/\bas\b/g, ':') : `{ default: ${spec.trim()} }`;
  return `const ${binding} = __imports[${JSON.stringify(name)}];`;
 }).replace(/^export\s*\{[^}]*\};?\s*$/gm, '').replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|class))/g, '');
 return new Function('__imports', 'setTimeout', `${executable}\nreturn { triggerAudienceComment };`)(imports, resolve => { queueMicrotask(resolve); return { unref() {} }; });
}

const modes = ['normal', 'provider-error', 'unknown-before', 'unknown-after', 'recovered', 'group-revoked', 'cancel-before', 'cancel-inflight', 'save-prelookup-unreadable'];
for (const mode of modes) test(`two-audience sequence: ${mode} stops or continues only at the verified boundary`, async t => {
 const userId = randomUUID(), db = await dbModule.createNewUserDatabase(userId); await memory.provisionNewLocalMemoryAccount(userId, db);
 const groupId = db.data.groups[0].id; db.data.groups[0].ai_members = ['audience_a', 'audience_b']; await db.write();
 const personas = Object.fromEntries(['audience_a', 'audience_b'].map(id => [id, { id, name: id, personality: 'synthetic persona', socialConfig: { maxMessageLength: 600 } }]));
 const models = [], events = [], typing = [], commits = []; const originalWrite = db.write, originalRead = db.read;
 let context, unavailable = false, commitCalls = 0;
 db.read = async function(options) { if (unavailable) throw new Error('Synthetic unreadable source or confirmation'); return originalRead.call(this, options); };
 db.write = async function(options) {
  commits.push(options.snapshot.messages.at(-1).sender_id);
  if (mode === 'unknown-before') throw new Error('Synthetic unknown before durable write');
  await originalWrite.call(this, options);
  if (mode === 'cancel-inflight') context.cancel = true;
  if (mode === 'unknown-after') { unavailable = true; throw new Error('Synthetic unknown after durable write'); }
  if (mode === 'recovered') throw new Error('Synthetic lost ACK, original still readable');
 };
 const debate = evaluate({
  '../backgroundMessageCommit.js': { commitBackgroundMessage: async args => {
   commitCalls++; context = args.context; assert.ok(context, 'audience sequence must carry a shared cancellation context');
   if (mode === 'group-revoked') await memory.markGroupDeleted(userId, db, groupId);
   if (mode === 'cancel-before') context.cancel = true;
   return domain.commitBackgroundMessage(args);
  } }, '../userScope.js': scope, 'uuid': { v4: randomUUID }, '../../models/db.js': dbModule,
  '../ai/index.js': { callAIDebate: async id => {
   models.push(id); if (mode === 'provider-error' && models.length === 1) throw new Error('Synthetic provider-only failure');
   if (mode === 'save-prelookup-unreadable') unavailable = true;
   return `Synthetic audience text from ${id}`;
  }, normalizeResponse: value => value, applyMessageLengthLimit: value => value },
  '../../websocket/index.js': { broadcastToGroup: (group, event) => events.push(structuredClone(event)), broadcastTypingStatus: (group, ai, active) => typing.push([ai, active]) },
  '../../config/personas.js': { AI_PERSONAS: personas }, '../scheduler/index.js': { getEffectivePersona: id => personas[id], loadCustomPersonas: async () => {} },
  '../../utils/encryption.js': encryption, '../memory/persistentMemory.js': memory
 });
 let result; try { result = await scope.runAsUser(userId, () => debate.triggerAudienceComment(groupId, ['audience_a', 'audience_b'])); } finally { db.write = originalWrite; db.read = originalRead; }
 await db.read({ force: true });
 const normal = ['normal', 'provider-error'].includes(mode), storedCount = mode === 'normal' ? 2 : ['provider-error', 'unknown-after', 'recovered', 'cancel-inflight'].includes(mode) ? 1 : 0;
 t.diagnostic(JSON.stringify({ mode, result, models, commitCalls, writes: commits.length, stored: db.data.messages.length, typing, durableEvents: events.filter(e => e.durable).length }));
 assert.deepEqual(models, normal ? ['audience_a', 'audience_b'] : ['audience_a']);
 assert.equal(db.data.messages.length, storedCount); assert.equal(result.success, normal);
 assert.equal(events.filter(e => e.type === 'audience_comment_finished').length, normal ? 1 : 0);
 assert.deepEqual(typing, models.flatMap(id => [[id, true], [id, false]]));
 assert.equal(events.filter(e => e.durable).length, normal ? storedCount : mode === 'recovered' ? 1 : 0);
 if (['unknown-before', 'unknown-after', 'cancel-inflight'].includes(mode)) assert.equal(result.outcomeUnknown, true);
 if (mode === 'recovered') { assert.equal(result.recovered, true); const event = events.find(e => e.durable); assert.equal(event.id, db.data.messages[0].id); assert.equal(event.created_at, db.data.messages[0].created_at); assert.equal(event.server_order.sequence, '1'); }
 if (!normal) assert.ok(commits.length <= 1, 'never rewrite or dispatch a replacement after uncertain/cancelled original');
});
