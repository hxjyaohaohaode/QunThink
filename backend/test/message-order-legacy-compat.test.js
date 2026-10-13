import test from 'node:test';
import assert from 'node:assert/strict';
const same = (actual, expected) => assert.ok(JSON.stringify(actual) === JSON.stringify(expected), 'Runtime legacy values match; sample diagnostics are suppressed');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPublic533LegacySample } from './fixtures/generate-public-533-legacy.mjs';
import { execFileSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'qunthink-order-compat-'));
const fixture = await createPublic533LegacySample();
process.env.ENCRYPTION_KEY = fixture.encryptionKey;
for (const name of Object.keys(process.env)) if (/^(SUPABASE_|MONGO|MEMORY_DELETION_|SERVER_AI_|ALIYUN_)/.test(name)) delete process.env[name];
const tasks = fixture.tasks;
test.after(() => fs.rm(process.env.DATA_DIR, { recursive: true, force: true }));
const { buildLegacyMessageOrder, validateMessageOrder, projectMessageOrder } = await import('../src/services/messageOrder.js');
const { sourceHash } = await import('../src/services/taskSources.js');
const { decryptText } = await import('../src/utils/encryption.js');
const { taskInput } = await import('../src/services/tasks.js');
const { editTaskMetadataInput } = await import('../src/services/taskMetadata.js');
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const generation = randomUUID();
const generationForGroup = () => generation;
const migrate = data => ({ ...structuredClone(data), message_order: buildLegacyMessageOrder(data, fixture.owner, { generationForGroup }) });
const sourceHashes = data => ({ all_v1: sourceHash(data.messages, { data }, 1), all_v2: sourceHash(data.messages, { data }, 2),
  last40_v1: sourceHash(data.messages.slice(-40), { data }, 1), last40_v2: sourceHash(data.messages.slice(-40), { data }, 2) });
const authority = data => ({ tasks: data.tasks, taskCreateRequests: data.taskCreateRequests, taskMetadataCommands: data.taskMetadataCommands });

test('runtime fixture uses byte-verified public533 AES/sourceHash functions and real old task receipts', () => {
  assert.equal(fixture.provenance.public_commit, '533d7be3cdd47691602574ccac7c6524e7ed7ab3');
  assert.equal(fixture.provenance.tree, '9392ba1ec25863eaed1e00ece649479981d7e87a');
  assert.equal(fixture.provenance.synthetic_only, true);
  assert.equal(fixture.provenance.node, process.version);
  assert.equal(Object.keys(fixture.provenance.source_sha256).length, 8);
  assert.ok(new Set(fixture.snapshot.messages.map(message => message.created_at)).size < 51);
  assert.equal(sha(fixture.snapshot), fixture.provenance.snapshot_sha256);
  assert.equal(sha(authority(fixture.snapshot)), tasks.provenance.authority_json_sha256);
  assert.equal(fixture.snapshot.messages.length, 51);
});

test('current production decryptText reads all historical AES messages, files and task without re-encryption', () => {
  const before = JSON.stringify(fixture.snapshot);
  assert.ok(JSON.stringify(fixture.snapshot.messages.map(message => decryptText(message.content))) === JSON.stringify(fixture.expected_plaintext), 'legacy plaintext survives current reads');
  for (const file of fixture.snapshot.files) assert.ok(decryptText(file.parsed_content) === fixture.expected_file_plaintext[file.id], 'legacy attachment plaintext survives current reads');
  assert.ok(decryptText(fixture.snapshot.tasks[0].prompt) === tasks.createInput.prompt, 'legacy task plaintext survives current reads');
  assert.ok(JSON.stringify(fixture.snapshot) === before, 'runtime sample bytes are unchanged');
});

test('current production sourceHash v1/v2 agrees with historical producer including last40 physical ordering', () => {
  same(sourceHashes(fixture.snapshot), fixture.hashes);
  assert.notEqual(fixture.hashes.all_v1, fixture.hashes.all_v2);
});

test('offline sidecar preparation preserves every original value and original sourceHash v1/v2', () => {
  const before = JSON.stringify(fixture.snapshot), candidate = migrate(fixture.snapshot);
  const { message_order, ...original } = candidate;
  assert.ok(JSON.stringify(original) === before, 'migration preserves original sample bytes');
  assert.ok(JSON.stringify(fixture.snapshot) === before, 'runtime sample bytes are unchanged');
  same(sourceHashes(candidate), fixture.hashes);
  assert.equal(sha(authority(candidate)), tasks.provenance.authority_json_sha256);
  assert.equal(validateMessageOrder(candidate, fixture.owner).bindings.size, 51);
  assert.notDeepEqual(message_order.groups[0].bindings.map(row => row.message_id), candidate.messages.map(row => row.id));
  assert.ok(message_order.groups[0].bindings.every(row => !Object.hasOwn(row, 'creation_intent_hash')));
});

test('response-only sequence projections do not change the existing task sourceHash contract', () => {
  const candidate = migrate(fixture.snapshot), before = JSON.stringify(candidate), index = validateMessageOrder(candidate, fixture.owner);
  const projected = candidate.messages.map(message => projectMessageOrder(message, index));
  assert.ok(projected.every(message => message.server_order.generation === generationForGroup()));
  for (const version of [1, 2]) {
    assert.equal(sourceHash(projected, {data:candidate}, version), fixture.hashes[`all_v${version}`]);
    assert.equal(sourceHash(projected.slice(-40), {data:candidate}, version), fixture.hashes[`last40_v${version}`]);
  }
  assert.ok(JSON.stringify(candidate) === before, 'projection preserves original sample bytes');
});

test('existing command parser hashes still match old authoritative task receipts after sidecar preparation', () => {
  const candidate = migrate(fixture.snapshot);
  const { client_request_id, ...input } = taskInput.parse(tasks.createInput);
  assert.equal(candidate.taskCreateRequests[0].id, client_request_id);
  assert.equal(candidate.taskCreateRequests[0].input_hash, sha(input));
  const metadata = editTaskMetadataInput.parse(tasks.metadataInput);
  const command = candidate.taskMetadataCommands.find(row => row.id === metadata.client_request_id);
  assert.equal(command.input_hash, sha({ userId: fixture.owner, taskId: candidate.tasks[0].id, operation: 'metadata', input: metadata }));
  assert.equal(sha(authority(candidate)), tasks.provenance.authority_json_sha256);
});

// This proves old-producer -> current-consumer compatibility and complete
// within-run byte preservation. It does not certify a fixed cross-run cipher.
test('ephemeral serialization and a fresh process retain runtime legacy ciphertext, hashes and generation', async () => {
  const candidate = migrate(fixture.snapshot), file = path.join(process.env.DATA_DIR, 'fixture-migrated.json');
  const bytes = JSON.stringify(candidate);
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
  const code = `import fs from 'node:fs/promises';import {createHash} from 'node:crypto';
    const {decryptText}=await import(${JSON.stringify(new URL('../src/utils/encryption.js', import.meta.url).href)});
    const {sourceHash}=await import(${JSON.stringify(new URL('../src/services/taskSources.js', import.meta.url).href)});
    const {validateMessageOrder}=await import(${JSON.stringify(new URL('../src/services/messageOrder.js', import.meta.url).href)});
    const check=(value)=>{if(!value)throw new Error('Runtime legacy restart contract failed')};
    let input='';for await(const chunk of process.stdin)input+=chunk;const expected=JSON.parse(input);
    const bytes=await fs.readFile(process.argv[1],'utf8'),data=JSON.parse(bytes);
    validateMessageOrder(data,expected.owner);
    for(const version of [1,2]) {
      check(sourceHash(data.messages,{data},version)===expected.hashes['all_v'+version]);
      check(sourceHash(data.messages.slice(-40),{data},version)===expected.hashes['last40_v'+version]);
    }
    check(decryptText(data.tasks[0].prompt)===expected.prompt);
    check(JSON.stringify(data.messages.map(m=>decryptText(m.content)))===JSON.stringify(expected.plaintext));
    check(data.message_order.groups[0].generation===expected.generation);
    check(createHash('sha256').update(bytes).digest('hex')===expected.fileHash);
    process.stdout.write(JSON.stringify({ok:true,count:data.messages.length}));`;
  try {
    let output;
    try {
      output = execFileSync(process.execPath, ['--input-type=module', '-e', code, file], {
        encoding: 'utf8', input: JSON.stringify({ owner: fixture.owner, hashes: fixture.hashes,
          prompt: tasks.createInput.prompt, plaintext: fixture.expected_plaintext, generation,
          fileHash: createHash('sha256').update(bytes).digest('hex') }),
        env: { NODE_ENV: 'test', DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: fixture.encryptionKey, TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000,
      });
    } catch { throw new Error('Fresh-process legacy consumer failed; runtime output is suppressed'); }
    const result = JSON.parse(output); assert.equal(result.ok, true); assert.equal(result.count, 51);
    assert.ok(await fs.readFile(file, 'utf8') === bytes, 'restart leaves all stored bytes unchanged');
  } finally { await fs.rm(file, { force: true }); }
});

test('a deliberately reordered physical array changes last40 source proof and is never hidden by the sidecar', () => {
  const candidate = migrate(fixture.snapshot);
  candidate.messages.reverse();
  assert.notEqual(sourceHash(candidate.messages.slice(-40), {data:candidate}, 1), fixture.hashes.last40_v1);
  assert.notEqual(sourceHash(candidate.messages.slice(-40), {data:candidate}, 2), fixture.hashes.last40_v2);
  assert.equal(sha(fixture.snapshot), fixture.provenance.snapshot_sha256);
});
