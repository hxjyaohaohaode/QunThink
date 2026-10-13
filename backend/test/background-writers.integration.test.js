// Execute the complete current scheduler/debate module bodies. Only module
// imports, timers, randomness and console are injected for deterministic local
// tests. AI/provider imports have synthetic implementations: zero network/model
// requests. Persistence uses the actual domain adapter, wrapper, required JSON
// adapter and independent deletion journal. This is not native/browser or PG QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.NODE_ENV = 'test'; process.env.AUTH_MODE = 'session';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-background-writers-'));
process.env.AUTH_DB_PATH = path.join(process.env.DATA_DIR, 'auth.json');
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_)/.test(name)) delete process.env[name];
const dbModule = await import('../src/models/db.js');
const auth = await import('../src/models/authDb.js');
const memory = await import('../src/services/memory/persistentMemory.js');
const domain = await import('../src/services/backgroundMessageCommit.js');
const ordering = await import('../src/services/messageOrder.js');
const scope = await import('../src/services/userScope.js');
const encryption = await import('../src/utils/encryption.js');
await dbModule.initializeEmptyInstallation(); await dbModule.initDatabase(); await auth.initAuthDb();
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const source = {};
for (const module of ['scheduler', 'debate']) source[module] = await fs.readFile(new URL(`../src/services/${module}/index.js`, import.meta.url), 'utf8');
const websocketSource = await fs.readFile(new URL('../src/websocket/index.js', import.meta.url), 'utf8');
const streamSource = websocketSource.slice(websocketSource.indexOf('function confirmedBroadcastMessage('), websocketSource.indexOf('\nexport function broadcastAIMessage')) + '\n' +
  websocketSource.slice(websocketSource.indexOf('export function broadcastStreamEnd('), websocketSource.indexOf('\nexport function broadcastSystemMessage'));
const fault = code => Object.assign(new Error(code), { code });
function evaluate(text, imports, names) {
  const executable = text.replace(/import\s+([\s\S]*?)\s+from\s+(['"])(.*?)\2\s*;/g, (_, spec, quote, name) => {
    assert.ok(imports[name], `Synthetic import must be explicit: ${name}`);
    const binding = spec.trim().startsWith('{') ? spec.trim().replace(/\bas\b/g, ':') : `{ default: ${spec.trim()} }`;
    return `const ${binding} = __imports[${JSON.stringify(name)}];`;
  }).replace(/await import\((['"])(.*?)\1\)/g, (_, q, name) => `__imports[${JSON.stringify(name)}]`)
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '').replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|class))/g, '');
  return new Function('__imports', 'setTimeout', 'setInterval', 'clearInterval', 'console', 'Math', `${executable}\nreturn {${names.join(',')}};`)(
    imports, callback => { queueMicrotask(callback); return { unref() {} }; }, () => ({ unref() {} }), () => {},
    { log() {}, info() {}, debug() {}, warn() {}, error() {} }, Object.assign(Object.create(Math), { random: () => 0.1 }));
}
async function fixture(kind, mode) {
  const userId = randomUUID(), db = await dbModule.createNewUserDatabase(userId);
  await memory.provisionNewLocalMemoryAccount(userId, db);
  const groupId = db.data.groups[0].id, sourceId = randomUUID();
  const persona = id => ({ id, name: id, personality: '合成角色', responseConfig: { enabled: true,
    responseFrequency: kind === 'continuation-refusal' ? 0 : 1, minDelay: 0, maxDelay: 0,
    maxResponsesPerConversation: kind === 'queue-mixed' ? 2 : 1, cooldownBetweenResponses: 0 }, socialConfig: { maxMessageLength: 1000,
      enableSocialFeedback: true, likeProbability: 1, dislikeProbability: 1, interactionProbability: 0 },
    refusalProbability: kind.includes('refusal') ? 1 : 0 });
  const personas = { 'fixture-ai': persona('fixture-ai'), 'fixture-other': persona('fixture-other') };
  let candidate = structuredClone(db.data);
  const group = candidate.groups.find(row => row.id === groupId);
  group.ai_members = ['fixture-ai']; group.autonomous_chat_enabled = false;
  if (['spontaneous', 'autonomous', 'private', 'debate-formal', 'debate-inter', 'debate-audience-two', 'queue-mixed'].includes(kind)) group.ai_members.push('fixture-other');
  if (['spontaneous', 'queue-mixed'].includes(kind)) group.autonomous_chat_enabled = true;
  for (const [id, type, sender] of [[sourceId, 'user', userId], [randomUUID(), 'ai', 'prior-fixture-ai']]) {
    candidate = ordering.prepareOrderedAppend(candidate, userId, { id, group_id: groupId, sender_type: type,
      sender_id: sender, content: '合成历史', content_type: 'text', created_at: '2026-10-13T03:00:00.000Z' },
      { creationIntentHash: 'a'.repeat(64) }).data;
  }
  await db.write({ snapshot: candidate });
  const file = path.join(process.env.DATA_DIR, 'users', `db_${userId}.json`), events = [], attempts = [];
  let models = 0, commitCalls = 0, scheduler, debate, committing = false, committingContext;
  const originalWrite = db.write.bind(db);
  db.write = async options => {
    if (options?.snapshot.messages.length > 2) {
      attempts.push(structuredClone(options.snapshot));
      if (mode === 'cas' && attempts.length < 3) throw fault('REVISION_CONFLICT');
      if (mode === 'unknown' || (mode === 'mixed' && attempts.length === 2)) throw fault('SYNTHETIC_WRITE_UNKNOWN');
      await originalWrite(options);
      if (mode === 'inflight-cancel') committingContext.cancel = true;
      if (mode === 'ack' || (mode === 'inter-ack' && options.snapshot.messages.at(-1).content.startsWith('@'))) throw fault('SYNTHETIC_LOST_ACK');
      return;
    }
    return originalWrite(options);
  };
  const capture = (id, event) => {
    events.push(structuredClone(event));
    if (event.durable) {
      assert.equal(committing, false, 'durable event is outside the complete commit promise');
      if (mode !== 'ack' && kind !== 'queue-mixed' &&
          (kind !== 'debate-inter' || (event.content?.startsWith('@') && mode !== 'inter-ack'))) {
        for (const ctx of scheduler?.activeGroups.values() || []) ctx.cancel = true;
        for (const ctx of debate?.activeDebates.values() || []) ctx.cancel = true;
      }
    }
  };
  const broadcastStreamEnd = new Function('broadcastToGroup', `${streamSource.replace('export ', '')}; return broadcastStreamEnd;`)(capture);
  const ws = { broadcastToGroup: capture, broadcastStreamEnd,
    broadcastStreamStart: (group_id, sender_id, message_id) => capture(group_id, { type: 'message_stream_start', group_id, sender_id, message_id }),
    broadcastStreamChunk: () => {}, broadcastTypingStatus: (group_id, sender_id, typing) => capture(group_id, { type: typing ? 'ai_typing' : 'ai_typing_stop', group_id, sender_id }) };
  const ai = {
    callAI: async () => { models++; return '这次不想回答'; },
    callAIStream: async (...args) => {
      if (args[18] && !(await args[18]())) return '';
      models++;
      if (kind === 'generation-error') throw fault('SYNTHETIC_PROVIDER_ERROR');
      if (kind === 'empty') return '';
      return mode === 'ack' ? `【回复消息ID:${sourceId}】合成模型回复【点赞】【评论：不能重放的评论】` : '合成模型回复';
    },
    callAIDebate: async () => {
      models++;
      if (mode === 'provider-error-first' && models === 1) throw fault('SYNTHETIC_PROVIDER_ERROR');
      if (mode === 'pre-save-read') {
        const read = db.read.bind(db); db.read = async (...args) => { db.read = read; throw fault('SYNTHETIC_SOURCE_READ_FAILURE'); };
      }
      return '合成辩论回复';
    },
    normalizeResponse: value => value, applyMessageLengthLimit: value => value, cancelStream() {}
  };
  const imports = {
    '../backgroundMessageCommit.js': { commitBackgroundMessage: async args => {
      commitCalls++; committingContext = args.context;
      if (mode === 'revoked') await memory.markGroupDeleted(userId, db, groupId);
      if (mode === 'cancel') { assert.ok(args.context, 'this caller must carry its cancellation context'); args.context.cancel = true; }
      if (mode === 'source-revoked') {
        assert.equal(args.sourceMessageId || args.context?.sourceMessageId, sourceId, 'the original source identity must reach the final gate');
        await memory.markMessageDeleted(userId, db, groupId, [sourceId]);
      }
      committing = true;
      try { return await domain.commitBackgroundMessage(args); } finally { committing = false; }
    } },
    'uuid': { v4: randomUUID }, '../../models/db.js': dbModule, '../userScope.js': scope,
    '../memory/persistentMemory.js': memory, '../../utils/encryption.js': encryption,
    '../../websocket/index.js': ws, '../ai/index.js': ai,
    '../mentions.js': { mentionedModelIds: () => [] },
    '../../config/personas.js': { AI_PERSONAS: personas, TEXT_CHAT_AIS: [], getEffectiveRelationship: () => ({ affinity: 0, description: '' }) },
    '../../config/constants.js': { AI_NAMES: {}, AI_MENTION_ALIASES: {}, calculateSimilarity: () => 0 },
    '../agent/index.js': { invokeAgentInGroup: () => { throw new Error('Unexpected nested model dispatch'); } },
    '../fileAnnotation/index.js': { generateMediaDescription() { throw new Error('Unexpected media dispatch'); } },
    '../fileParser/index.js': { parseFile() { throw new Error('Unexpected file parse'); } },
    'path': { default: path },
    '../ai/catalog.js': { readCatalog: async () => ({ models: Object.keys(personas).map(id => ({ id, ready: true, verifiedCapabilities: ['chat'] })) }),
      getCatalogData: () => ({ models: [] }), modelPersona: () => ({}) }
  };
  scheduler = evaluate(source.scheduler, imports, ['triggerSpontaneousChat', 'generateAIResponse', 'queueAIMessages', 'continueAIConversation',
    'startAutonomousChat', 'handleUserReaction', 'startAIPrivateChat', 'parseAndSaveMessage', 'activeGroups']);
  imports['../scheduler/index.js'] = { getEffectivePersona: id => personas[id], loadCustomPersonas: async () => {} };
  debate = evaluate(source.debate, imports, ['saveMessage', 'broadcastDebateMessage', 'startFormalDebate', 'triggerAudienceComment', 'activeDebates']);
  const context = { cancel: false, sourceMessageId: sourceId, maxConversationDepth: 1, conversationDepth: 0,
    conversationActive: true, attemptsByModel: new Map() };
  const run = () => scope.runAsUser(userId, async () => {
    const messages = structuredClone(db.data.messages);
    switch (kind) {
      case 'spontaneous': return scheduler.triggerSpontaneousChat(groupId, Object.keys(personas));
      case 'initial-refusal':
      case 'generation-error':
      case 'empty': return scheduler.generateAIResponse('fixture-ai', groupId, '合成请求', messages, ['fixture-ai'], context,
        true, [], true, null, null, userId);
      case 'queue-mixed':
      case 'queued': return scheduler.queueAIMessages(groupId, '合成请求', null, userId, sourceId);
      case 'continuation-refusal':
      case 'continuation': return scheduler.continueAIConversation(groupId, context, ['fixture-ai'], [], null, userId);
      case 'autonomous': return scheduler.startAutonomousChat(groupId, '合成话题');
      case 'reaction': return scheduler.handleUserReaction(groupId, sourceId, 'like', userId, userId);
      case 'private': return scheduler.startAIPrivateChat(groupId, '合成话题');
      case 'parse-save': return scheduler.parseAndSaveMessage(groupId, 'fixture-ai', mode === 'ack'
        ? `【回复消息ID:${sourceId}】预先生成的内容【点赞】【评论：不能重放的评论】` : '预先生成的内容', null, messages, null, mode !== 'ack');
      case 'debate': {
        const committed = await debate.saveMessage(groupId, 'fixture-ai', '预先生成的辩论内容', 'proponent', context);
        if (committed) debate.broadcastDebateMessage(groupId, committed.result);
        return committed;
      }
      case 'debate-inter':
      case 'debate-formal': return debate.startFormalDebate(groupId, '合成话题');
      case 'debate-audience-two': return debate.triggerAudienceComment(groupId, ['fixture-ai', 'fixture-other']);
      case 'debate-audience': return debate.triggerAudienceComment(groupId, ['fixture-ai']);
      default: throw new Error(kind);
    }
  });
  return { run, events, attempts, get models() { return models; }, get commitCalls() { return commitCalls; },
    durable: async () => JSON.parse(await fs.readFile(file, 'utf8')), context };
}
const writers = ['spontaneous', 'initial-refusal', 'generation-error', 'queued', 'continuation-refusal', 'continuation',
  'autonomous', 'reaction', 'private', 'parse-save', 'debate', 'debate-formal', 'debate-audience'];
for (const kind of writers) for (const mode of ['success', 'cas', 'revoked', 'unknown', 'ack']) {
  test(`${kind}: ${mode} uses one prepared creation, the account wrapper and confirmed event identity`, async () => {
    const f = await fixture(kind, mode);
    let error; try { await f.run(); } catch (caught) { error = caught; }
    const saved = await f.durable(), output = saved.messages.slice(2), durableEvents = f.events.filter(event => event.durable);
    if (mode === 'ack') {
      assert.equal(f.events.some(event => ['message_liked', 'message_disliked', 'new_comment'].includes(event.type)), false, 'recovered creation must not replay social side effects');
      assert.ok(saved.messages.slice(0, 2).every(message => !message.likes_count && !message.comments?.length));
    }
    assert.equal(f.commitCalls, 1, 'the selected real append site must be reached exactly once');
    assert.equal(f.models, ['parse-save', 'debate'].includes(kind) ? 0 : 1, 'CAS/ACK processing cannot redispatch models');
    if (['revoked', 'unknown'].includes(mode)) {
      assert.equal(output.length, 0); assert.equal(durableEvents.length, 0);
      assert.equal(f.attempts.length, mode === 'revoked' ? 0 : 1);
      if (error) assert.equal(error.code, 'MESSAGE_COMMIT_UNKNOWN');
    } else {
      assert.ifError(error); assert.equal(output.length, 1); ordering.validateMessageOrder(saved, saved.message_order.owner_id);
      assert.equal(f.attempts.length, mode === 'cas' ? 3 : 1);
      for (const candidate of f.attempts) assert.deepEqual(candidate, f.attempts[0], 'no regenerated random preview, UUID, timestamp, body or hash');
      if (kind !== 'parse-save') {
        assert.equal(durableEvents.length, 1);
        const event = durableEvents[0], stored = output[0];
        assert.equal(event.id, stored.id); assert.equal(event.group_id, stored.group_id);
        assert.equal(event.created_at, stored.created_at); assert.equal(event.content, stored.content);
        assert.deepEqual(event.metadata, stored.metadata); assert.equal(event.server_order.sequence, '3');
        assert.equal(event.persistence_status, 'confirmed');
      }
    }
  });
}
test('empty generation completion is explicitly not saved, with no invented created_at or sequence', async () => {
  const f = await fixture('empty', 'success'); await f.run();
  assert.equal(f.models, 1); assert.equal(f.commitCalls, 0);
  const event = f.events.find(row => row.type === 'message_stream_end'); assert.ok(event);
  assert.equal(event.durable, false); assert.equal(event.persistence_status, 'not_saved');
  assert.equal(Object.hasOwn(event, 'created_at'), false); assert.equal(Object.hasOwn(event, 'server_order'), false);
  assert.equal((await f.durable()).messages.length, 2);
});

for (const kind of writers.filter(name => !['reaction', 'parse-save', 'debate-audience'].includes(name))) {
  test(`${kind}: explicit cancellation after generation and before final commit prevents storage and durable publication`, async () => {
    const f = await fixture(kind, 'cancel'); await f.run();
    assert.equal(f.commitCalls, 1); assert.equal(f.attempts.length, 0);
    assert.equal((await f.durable()).messages.length, 2);
    assert.equal(f.events.some(event => event.durable), false);
  });
}
for (const kind of ['initial-refusal', 'generation-error', 'queued', 'continuation-refusal', 'continuation', 'reaction', 'debate']) {
  test(`${kind}: the original triggering source remains journal-authorized in the final commit`, async () => {
    const f = await fixture(kind, 'source-revoked'); await f.run();
    assert.equal(f.commitCalls, 1); assert.equal(f.attempts.length, 0);
    assert.equal((await f.durable()).messages.length, 2);
    assert.equal(f.events.some(event => event.durable), false);
  });
}

test('one successful sibling plus one unknown commit cannot restart paid conversation rounds', async () => {
  const f = await fixture('queue-mixed', 'mixed'); await f.run();
  assert.equal(f.models, 2, 'only the original two parallel provider calls');
  assert.equal(f.commitCalls, 2); assert.equal(f.attempts.length, 2);
  assert.equal((await f.durable()).messages.length, 3);
  assert.equal(f.events.filter(event => event.durable).length, 1);
});

for (const mode of ['inter-success', 'inter-ack']) test(`actual formal inter-AI save caller: ${mode} retains the confirmed message and stops on recovery`, async () => {
  const f = await fixture('debate-inter', mode); await f.run();
  const saved = (await f.durable()).messages.slice(2), events = f.events.filter(event => event.durable);
  assert.equal(saved.length, 5); assert.equal(f.models, 5); assert.equal(f.commitCalls, 5);
  assert.equal(events.length, 5); assert.match(saved.at(-1).content, /^@/);
  for (let i = 0; i < saved.length; i++) {
    assert.equal(events[i].id, saved[i].id); assert.equal(events[i].created_at, saved[i].created_at);
    assert.deepEqual(events[i].metadata, saved[i].metadata); assert.equal(events[i].server_order.sequence, String(i + 3));
  }
});
for (const kind of writers.filter(name => !['reaction', 'parse-save', 'debate-audience'].includes(name))) {
  test(`${kind}: stop arriving during storage cannot produce a live durable success`, async () => {
    const f = await fixture(kind, 'inflight-cancel'); await f.run();
    assert.equal(f.commitCalls, 1); assert.equal(f.attempts.length, 1);
    assert.equal((await f.durable()).messages.length, 3, 'the in-flight original may already be durable');
    assert.equal(f.events.some(event => event.durable), false);
  });
}

for (const mode of ['success', 'unknown', 'ack', 'revoked', 'cancel', 'inflight-cancel', 'pre-save-read', 'provider-error-first']) {
  test(`two-audience serial caller: ${mode} preserves generation versus persistence failure boundaries`, async () => {
    const f = await fixture('debate-audience-two', mode), result = await f.run();
    const saved = (await f.durable()).messages.slice(2), durableEvents = f.events.filter(event => event.durable);
    if (['success', 'provider-error-first'].includes(mode)) {
      assert.equal(result.success, true); assert.equal(f.models, 2);
      assert.equal(saved.length, mode === 'success' ? 2 : 1); assert.equal(durableEvents.length, saved.length);
      assert.equal(f.events.some(event => event.type === 'audience_comment_finished'), true);
    } else {
      assert.equal(result.success, false); assert.equal(f.models, 1, 'a persistence boundary cannot trigger the next paid model');
      assert.equal(f.events.some(event => event.type === 'audience_comment_finished'), false);
      assert.equal(f.commitCalls, mode === 'pre-save-read' ? 0 : 1);
      assert.equal(saved.length, ['ack', 'inflight-cancel'].includes(mode) ? 1 : 0);
      assert.equal(durableEvents.length, mode === 'ack' ? 1 : 0);
      if (mode === 'unknown') assert.equal(result.outcomeUnknown, true);
      if (mode === 'ack') assert.equal(result.recovered, true);
    }
    const starts = f.events.filter(event => event.type === 'ai_typing'), stops = f.events.filter(event => event.type === 'ai_typing_stop');
    assert.equal(starts.length, stops.length, 'every started typing status must be cleared in finally');
    assert.deepEqual(starts.map(event => event.sender_id), stops.map(event => event.sender_id));
  });
}
