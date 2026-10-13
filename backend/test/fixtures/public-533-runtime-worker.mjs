// Private IPC worker: only unchanged byte-verified legacy business logic runs.
// Infrastructure adapters below are memory-only. Unknown imports fail closed.
import * as vm from 'node:vm';
import * as crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { z } from 'zod';
import { verifyPublic533Sources } from './generate-public-533-legacy.mjs';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const blocked = () => { throw new Error('Legacy fixture infrastructure boundary blocked'); };
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function produce(fault) {
  const { manifest, sources } = await verifyPublic533Sources();
  if (fault === 'before-generation') blocked();
  if (fault === 'source-hash') {
    sources.set('backend/src/utils/encryption.js', sources.get('backend/src/utils/encryption.js') + '\n');
  }
  // Entire scenario is created here. No retired owner/title/prompt/cipher bytes
  // are read, copied, decoded, transformed, or used to seed this sample.
  const key = crypto.randomBytes(32).toString('base64');
  const owner = crypto.randomUUID();
  const groupId = crypto.randomUUID();
  const dataDir = '/fixture-runtime-only';
  const db = { data: { groups: [], messages: [], files: [], tasks: [], taskCreateRequests: [], taskMetadataCommands: [] },
    async read() {}, async write() { if (fault === 'write') blocked(); }, invalidateReadCache() {} };
  const currentDb = userId => { check(userId === owner, 'Unexpected synthetic owner'); return db; };
  const context = vm.createContext({ Buffer, structuredClone,
    process: { env: { NODE_ENV: 'test', DATA_DIR: dataDir, ENCRYPTION_KEY: key }, platform: 'fixture' },
    // Historical migration warnings carry no values, but no producer logging
    // is allowed to cross this boundary, including unexpected error details.
    console: { log() {}, warn() {}, error() {} },
  });
  const modules = new Map();
  const synthetic = (name, values) => {
    const mod = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context, identifier: name });
    modules.set(name, mod); return mod;
  };
  synthetic('node:crypto', crypto); synthetic('crypto', crypto);
  synthetic('path', { default: path }); synthetic('url', { fileURLToPath });
  synthetic('zod', { z }); synthetic('child_process', { spawnSync: blocked });
  // KeyManager's historical metadata probes see an empty synthetic directory.
  // Any actual file access/write or subprocess creation is forbidden.
  synthetic('fs/promises', { default: new Proxy({}, { get: () => blocked }) });
  const fs = new Proxy({ lstatSync(file) {
    if (file === dataDir) return { isSymbolicLink: () => false, isDirectory: () => true };
    throw Object.assign(new Error('Absent synthetic metadata'), { code: 'ENOENT' });
  } }, { get: (target, name) => Object.hasOwn(target, name) ? target[name] : blocked });
  synthetic('fs', { default: fs }); synthetic('node:fs', { default: fs });
  synthetic('node:path', { default: path });
  synthetic('backend/src/models/db.js', {
    getUserDb: async userId => currentDb(userId), listUserDatabases: blocked,
    withWriteLock: async (userId, action) => { currentDb(userId); return action(); },
    beginUserDbWriteBarrier: candidate => { check(candidate === db, 'Unexpected synthetic database'); return () => {}; },
  });
  synthetic('backend/src/services/memory/persistentMemory.js', {
    readableSourceGroups: async userId => currentDb(userId).data.groups,
    readableSourceMessages: async (userId, _db, messages) => messages || currentDb(userId).data.messages,
    readableSourceFiles: async userId => currentDb(userId).data.files,
  });
  synthetic('backend/src/services/ai/catalog.js', Object.fromEntries([
    'defaultModelId', 'defaultModelIdSnapshot', 'resolveModel', 'resolveModelSnapshot', 'catalogError',
  ].map(name => [name, blocked])));
  synthetic('backend/src/services/ai/transport.js', { requestCompletion: blocked, describeProviderError: blocked });
  synthetic('backend/src/services/userScope.js', { runAsUser: blocked });
  synthetic('backend/src/utils/logger.js', { safeLog: blocked });
  for (const [name, source] of sources) {
    check(crypto.createHash('sha256').update(source).digest('hex') === manifest.source_sha256[name], 'Historical source hash mismatch');
    modules.set(name, new vm.SourceTextModule(source, { context, identifier: name,
      initializeImportMeta(meta) { meta.url = pathToFileURL(`/fixture-producer/${name}`).href; } }));
  }
  const linker = (specifier, importer) => {
    const name = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(importer.identifier), specifier)) : specifier;
    const module = modules.get(name); check(!!module, 'Unpinned historical import blocked'); return module;
  };
  const entry = modules.get('backend/src/services/tasks.js');
  await entry.link(linker); await entry.evaluate();
  const encryption = modules.get('backend/src/utils/encryption.js').namespace;
  const taskSources = modules.get('backend/src/services/taskSources.js').namespace;
  if (fault === 'network') modules.get('backend/src/services/ai/transport.js').namespace.requestCompletion();
  const createInput = { client_request_id: crypto.randomUUID(), title: 'Fixture compatibility task',
    prompt: 'Fixture-only synthetic task input.', category: 'work', model_id: null,
    group_id: null, run_at: null, repeat_minutes: null, auto_run: false };
  const created = await entry.namespace.createTask(owner, createInput);
  const metadataInput = { client_request_id: crypto.randomUUID(), expected_revision: 0,
    changes: { title: 'Fixture compatibility task updated', auto_run: true, run_at: '2040-01-02T03:04:00.000Z' } };
  const updated = await entry.namespace.updateTaskMetadata(owner, created.id, metadataInput);
  const authority = structuredClone({ tasks: db.data.tasks, taskCreateRequests: db.data.taskCreateRequests,
    taskMetadataCommands: db.data.taskMetadataCommands });
  db.data.groups.push({ id: groupId, name: 'Fixture synthetic message group', owner_user_id: owner });
  const expectedById = new Map(), filePlaintext = new Map();
  for (let index = 0; index < 51; index++) {
    const id = crypto.randomUUID();
    const plaintext = `Fixture-only synthetic message ${index}.`;
    const attachments = [];
    if (index % 11 === 0) {
      const fileId = crypto.randomUUID(), text = `Fixture-only synthetic attachment ${index}.`;
      db.data.files.push({ id: fileId, group_id: groupId, filename: `fixture-${index}.txt`,
        parsed_content: encryption.encryptText(text), media_description: '', parse_status: 'completed' });
      attachments.push({ id: fileId }); filePlaintext.set(fileId, text);
    }
    const sender = index % 2 ? 'ai' : 'user';
    db.data.messages.push({ id, group_id: groupId, owner_user_id: owner, sender_type: sender,
      sender_id: sender === 'user' ? owner : 'fixture-synthetic-assistant', content_type: 'text',
      content: encryption.encryptText(plaintext), attachments, revision: index % 3 + 1,
      edited_at: null, created_at: new Date(Date.UTC(2040, 0, 1) + Math.floor(index / 2)).toISOString(),
      metadata: { encryption: { encrypted: true } } });
    expectedById.set(id, plaintext);
  }
  // Intentionally non-chronological storage, with equal-millisecond collisions.
  // The consumer must retain this physical order and all original IDs/times.
  db.data.messages.reverse();
  const snapshot = structuredClone(db.data);
  const hashes = { all_v1: taskSources.sourceHash(snapshot.messages, { data: snapshot }, 1),
    all_v2: taskSources.sourceHash(snapshot.messages, { data: snapshot }, 2),
    last40_v1: taskSources.sourceHash(snapshot.messages.slice(-40), { data: snapshot }, 1),
    last40_v2: taskSources.sourceHash(snapshot.messages.slice(-40), { data: snapshot }, 2) };
  if (fault === 'after-generation') blocked();
  return { ok: true, key, sample: { owner, snapshot, hashes,
    expected_plaintext: snapshot.messages.map(message => expectedById.get(message.id)),
    expected_file_plaintext: Object.fromEntries(filePlaintext),
    tasks: { userId: owner, createInput, metadataInput, responseReceipt: structuredClone(updated.receipt), authority,
      provenance: { ...manifest, synthetic_only: true, authority_json_sha256: sha(authority) } },
    provenance: { synthetic_only: true, node: process.version, snapshot_sha256: sha(snapshot),
      method: 'Unchanged public533 production functions; random runtime-only fixture; synthetic infrastructure' } } };
}

if (!process.send || process.argv.length !== 2) throw new Error('Legacy runtime worker requires private parent IPC');
process.once('message', async ({ fault } = {}) => {
  try {
    const result = await produce(fault);
    process.send(result, error => { if (error) process.exitCode = 1; process.disconnect(); });
  } catch {
    // Never attach an exception, sample, key, or captured console output.
    process.exitCode = 1; process.disconnect();
  }
});
