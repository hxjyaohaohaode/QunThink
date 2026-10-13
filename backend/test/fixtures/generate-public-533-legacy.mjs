// Runtime-only, fictional compatibility samples. There is no export interface.
// Historical production sources are unchanged and verified before evaluation.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = new URL('./public-533-producer/', import.meta.url);
const manifestHash = 'e175f005939fb54af1974cacb051dfabbb351ff1c659a142fc1a80396b816c73';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = () => new Error('Legacy fixture producer failed; runtime sample output is suppressed');

export async function verifyPublic533Sources() {
  const bytes = await readFile(new URL('manifest.json', directory));
  if (digest(bytes) !== manifestHash) throw new Error('Legacy producer manifest hash mismatch');
  const manifest = JSON.parse(bytes);
  const sources = new Map();
  for (const [name, expected] of Object.entries(manifest.source_sha256)) {
    const source = await readFile(new URL(name, directory));
    if (digest(source) !== expected) throw new Error(`Legacy producer source hash mismatch: ${name}`);
    sources.set(name, source.toString('utf8'));
  }
  return { manifest, sources };
}

// Fault modes are deliberately bounded test-only failures, never caller data.
export async function createPublic533LegacySample({ fault = null } = {}) {
  if (![null, 'before-generation', 'after-generation', 'write', 'network', 'source-hash'].includes(fault)) {
    throw new Error('Unknown legacy fixture fault mode');
  }
  const { manifest } = await verifyPublic533Sources();
  const packet = await new Promise((resolveSample, reject) => {
    let worker;
    try {
      worker = fork(fileURLToPath(new URL('./public-533-runtime-worker.mjs', import.meta.url)), [], {
        execPath: process.execPath, execArgv: ['--experimental-vm-modules', '--no-warnings'],
        // Do not inherit service URLs, real keys, preloads, or any account state.
        env: { NODE_ENV: 'test', TZ: 'UTC' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      });
    } catch { reject(failure()); return; }
    let result, received = false, settled = false, failed = false;
    let timeout, cleanupTimeout;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(cleanupTimeout);
      if (error) reject(error); else resolveSample(value);
    };
    const terminate = () => {
      if (settled || failed) return;
      failed = true; result = undefined; clearTimeout(timeout);
      // A failed spawn has no OS process to terminate or reap.
      if (!worker.pid) { finish(failure()); return; }
      // `killed` only records sending a signal. A stopped worker ignores TERM,
      // so use KILL for this test-owned process and await a real exit/close event.
      if (worker.exitCode === null && worker.signalCode === null) {
        try { worker.kill('SIGKILL'); } catch { /* Close may already be queued. */ }
      }
      // Do not report the ordinary failure while cleanup is still uncertain.
      // An exceptional OS cleanup failure is explicit and bounded, never hidden.
      cleanupTimeout = setTimeout(() => finish(new Error(
        'Legacy fixture producer cleanup failed; exit not confirmed; runtime sample output is suppressed'
      )), 2000);
    };
    worker.on('error', terminate);
    worker.on('message', value => {
      if (failed || settled) return;
      if (received) { terminate(); return; }
      received = true; result = value;
    });
    worker.once('disconnect', () => { if (!received) terminate(); });
    // A pre-send IPC disconnect can omit close even after the OS child exits.
    // Failure has no output to drain, so an actual exit is sufficient evidence.
    worker.once('exit', () => { if (failed) finish(failure()); });
    worker.once('close', code => {
      if (failed || code !== 0 || result?.ok !== true || typeof result.key !== 'string') finish(failure());
      else finish(null, result);
    });
    timeout = setTimeout(terminate, 15000);
    try { worker.send({ fault }, error => { if (error) terminate(); }); }
    catch { terminate(); }
  });
  const sample = { ...packet.sample, provenance: { ...manifest, ...packet.sample.provenance },
    toJSON() { throw new Error('Legacy samples are runtime-only and must not be exported'); } };
  // The key stays out of enumerable objects, JSON, summaries and TAP diagnostics.
  Object.defineProperty(sample, 'encryptionKey', { value: packet.key });
  return Object.freeze(sample);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('Fixture file export is retired; no output path is accepted');
  const sample = await createPublic533LegacySample();
  console.log(JSON.stringify({ publicCommit: sample.provenance.public_commit, syntheticOnly: true,
    runtimeOnly: true, sourceFiles: Object.keys(sample.provenance.source_sha256).length,
    messages: sample.snapshot.messages.length, files: sample.snapshot.files.length }));
}
