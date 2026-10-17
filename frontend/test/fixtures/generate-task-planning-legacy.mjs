// Memory-only compatibility producer. Never export a key or write a sample.
// The vendored production sources are byte-pinned to public commit 533d7be3.
// No git history, checkout, network, or current production modules are needed.
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const sourceCommit = '533d7be3cdd47691602574ccac7c6524e7ed7ab3';
// Provenance only. No static owner, task identity, or scenario artifact exists.
const sourceFiles = Object.freeze({
  'frontend/src/stores/tasksStore.ts': '80236b6e96a38641349f82ff9db161c957ae2e1b6e7c938721200984de54aadc',
  'frontend/src/stores/taskMetadataSlice.ts': '91442b45bc92c9eda7e78dc50f32924d7743692ea41a5a8d9d54d25d382cab61',
  'frontend/src/utils/taskMetadataRecovery.ts': '5fcfb830c8103e0ecfe2d4e05a463f686915f873c2ba2ac5be9fe38f6de503f8',
  'frontend/src/utils/taskRecovery.ts': '7cd45fb8b2e6ca9c5ee9eb84b2832962181dd4f982401cfa4558477f1d6435df',
  'frontend/src/utils/taskDependencyRecovery.ts': '67ae4eeb5ef9da954733f32b8572850add35955042b5ead81436181568fbc7f5',
  'frontend/src/observability/runtimeDiagnostics.ts': 'c6322f1ca3eebc98127291af0b807b4ccf0ffec28accd2f38ced14567e2d5820',
});
const producerPaths = [
  'frontend/src/stores/tasksStore.ts',
  'frontend/src/stores/taskMetadataSlice.ts',
  'frontend/src/utils/taskMetadataRecovery.ts',
  'frontend/src/utils/taskRecovery.ts',
  'frontend/src/utils/taskDependencyRecovery.ts',
  'frontend/src/observability/runtimeDiagnostics.ts',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function requireCondition(value, message) { if (!value) throw new Error(message); }

export async function verifyTaskPlanningLegacySources() {
  const manifest = Object.freeze({ sourceCommit, sourceFiles });
  requireCondition(Object.keys(manifest.sourceFiles).sort().join('\n') === [...producerPaths].sort().join('\n'), 'Legacy producer source set changed');
  const sources = new Map();
  for (const path of producerPaths) {
    const bytes = await readFile(resolve(directory, 'task-planning-legacy-533', path));
    requireCondition(digest(bytes) === manifest.sourceFiles[path], `Legacy producer source hash mismatch: ${path}`);
    sources.set(path, bytes.toString('utf8'));
  }
  return { manifest, sources };
}

function memoryIndexedDB(databases) {
  return { open(name) {
    const request = {};
    queueMicrotask(() => {
      let values = databases.get(name);
      const fresh = !values;
      if (!values) { values = new Map(); databases.set(name, values); }
      const db = { close() {}, createObjectStore() {}, transaction() {
        const tx = {};
        tx.objectStore = () => ({
          get(key) {
            const result = {};
            queueMicrotask(() => { result.result = values.get(key); result.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
            return result;
          },
          put(value, key) { values.set(key, value); },
        });
        return tx;
      } };
      request.result = db;
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  } };
}

export async function createTaskPlanningLegacySample() {
  const { manifest, sources } = await verifyTaskPlanningLegacySources();
  // Entirely fictional runtime-only test data. This does not reconstruct or
  // assert compatibility with the retired static scenario's particular values.
  const owner = `fixture-task-planning-${crypto.randomUUID()}`;
  const taskId = crypto.randomUUID();
  const createPayload = { title: 'Compatibility fixture task', prompt: 'Synthetic compatibility fixture input.', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false };
  const metadataChanges = { title: 'Updated compatibility fixture task', auto_run: true, run_at: '2040-01-02T03:04:00.000Z' };
  const task = { id: taskId, title: 'Compatibility fixture baseline', prompt: 'Synthetic fixture baseline input.', status: 'pending', category: 'work', auto_run: false, run_at: null, metadata_revision: 0, dependency_ids: [], dependency_revision: 0, history: [], result: 'Synthetic fixture baseline output.' };
  const built = await build({
    stdin: {
      resolveDir: resolve(directory, '../..'), loader: 'ts',
      contents: `export {useTasksStore} from 'legacy-entry';export * from 'legacy-recovery';export * from 'legacy-metadata';`,
    },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: [{ name: 'byte-verified-public-533', setup(build) {
      const entries = { 'legacy-entry': producerPaths[0], 'legacy-recovery': producerPaths[3], 'legacy-metadata': producerPaths[2] };
      build.onResolve({ filter: /^legacy-/ }, ({ path }) => ({ path: entries[path], namespace: 'legacy-source' }));
      build.onResolve({ filter: /.*/, namespace: 'legacy-source' }, async ({ path, importer }) => {
        if (path === 'zustand') return build.resolve(path, { resolveDir: resolve(directory, '../..'), kind: 'import-statement' });
        if (/services\/api$/.test(path)) return { path: 'api', namespace: 'legacy-transport' };
        if (/(?:utils\/|\.\/)cacheUtils$/.test(path)) return { path: 'cache', namespace: 'legacy-transport' };
        if (path === './modelsStore') return { path: 'models', namespace: 'legacy-transport' };
        // These are virtual Git paths, not paths on the host filesystem.
        const resolved = posix.resolve('/', posix.dirname(importer), path).slice(1) + '.ts';
        requireCondition(sources.has(resolved), 'Legacy producer attempted to import an unpinned source');
        return { path: resolved, namespace: 'legacy-source' };
      });
      build.onLoad({ filter: /.*/, namespace: 'legacy-source' }, ({ path }) => ({ loader: 'ts', contents: sources.get(path) }));
      build.onLoad({ filter: /.*/, namespace: 'legacy-transport' }, ({ path }) => ({ loader: 'js', contents:
        path === 'api' ? `export const getAuthGeneration=()=>globalThis.__taskPlanningLegacy.auth;export const axiosInstance=Object.fromEntries(['get','post','put','patch','delete'].map(method=>[method,(...args)=>globalThis.__taskPlanningLegacy[method](...args)]));`
          : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__taskPlanningLegacy.user;`
            : `export const requestError=error=>error.message;`,
      }));
    } }],
  });
  const window = new Window({ url: 'https://qunthink.test/' });
  const databases = new Map();
  const replaced = ['localStorage', 'indexedDB', '__taskPlanningLegacy'];
  const previous = new Map(replaced.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let store, producerFailed = false;
  try {
    let createDispatch, metadataDispatch;
    const transport = {
      user: owner, auth: 1,
      get: async () => { throw new Error('No service calls in the legacy producer'); },
      post: async (path, payload, config) => {
        requireCondition(path === '/tasks', 'Unexpected legacy creation endpoint');
        createDispatch = { raw: JSON.stringify(payload), key: config.headers['Idempotency-Key'] };
        throw new Error('Lost synthetic create ACK');
      },
      put: async (path, payload) => {
        requireCondition(path === `/tasks/${taskId}/metadata`, 'Unexpected legacy metadata endpoint');
        metadataDispatch = structuredClone(payload);
        throw new Error('Lost synthetic metadata ACK');
      },
    };
    for (const [name, value] of Object.entries({ localStorage: window.localStorage, indexedDB: memoryIndexedDB(databases), __taskPlanningLegacy: transport })) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    // The unique module instance also prevents old store state crossing runs.
    const producer = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
    store = producer.useTasksStore;
    producer.setWritingPreferences({ recoverDrafts: true, offlineCopies: false });
    try { await store.getState().create(structuredClone(createPayload)); } catch {}
    requireCondition(!!createDispatch, 'Legacy creation did not reach the synthetic transport');
    store.setState({ tasks: [task] });
    store.getState().editMetadata(taskId, structuredClone(metadataChanges));
    try { await store.getState().saveMetadata(taskId); } catch {}
    requireCondition(!!metadataDispatch, 'Legacy metadata did not reach the synthetic transport');
    const createReceipt = producer.readTaskReceipts()[0];
    const metadataJournal = producer.readMetadataJournal()[0];
    const metadataPayload = store.getState().metadataIntents[taskId]?.payload;
    requireCondition(createReceipt?.key === createDispatch.key && createDispatch.raw === JSON.stringify(createPayload), 'Legacy creation payload or UUID changed before capture');
    requireCondition(!!metadataPayload && JSON.stringify(metadataPayload) === JSON.stringify(metadataDispatch) && metadataJournal?.key === metadataPayload.client_request_id, 'Legacy metadata payload or UUID changed before capture');
    const storage = Object.fromEntries(Object.keys(window.localStorage).map(name => [name, window.localStorage.getItem(name)]));
    const encrypted = Object.entries(storage).filter(([name]) => name.startsWith('qunthink_writing_v1_'));
    requireCondition(encrypted.length === 2 && encrypted.every(([, value]) => {
      const envelope = JSON.parse(value);
      return envelope.v === 1 && envelope.iv.length === 12 && envelope.data.length > 16;
    }), 'Legacy producer did not emit both old-format AES-GCM samples');
    const key = databases.get(`qunthink-writing-key-${encodeURIComponent(owner)}`)?.get('key');
    requireCondition(key?.type === 'secret' && key.extractable === false && key.algorithm.name === 'AES-GCM' && key.algorithm.length === 256, 'Legacy producer did not create a non-extractable AES-256 key');
    const sample = {
      sourceCommit, sourceFiles: manifest.sourceFiles, owner, taskId, task: structuredClone(task),
      createPayload: structuredClone(createPayload), metadataPayload: structuredClone(metadataPayload),
      metadataCanonical: producer.canonicalMetadata(metadataPayload),
      createReceipt: structuredClone(createReceipt), metadataJournal: structuredClone(metadataJournal),
      // Accidental JSON export must fail without exposing any runtime values.
      toJSON() { throw new Error('Legacy samples are memory-only and must not be serialized'); },
    };
    Object.defineProperties(sample, { key: { value: key }, storage: { value: Object.freeze(storage) } });
    return Object.freeze(sample);
  } catch (error) {
    producerFailed = true;
    throw error;
  } finally {
    let cleanupFailed = false;
    try {
      // Each action must be attempted even if an earlier cleanup fails.
      for (const cleanup of [() => store?.getState().cleanup(), () => window.localStorage.clear(), () => databases.clear(), () => window.close()]) {
        try { cleanup(); } catch { cleanupFailed = true; }
      }
    } finally {
      // Restoration is outermost, independent, and preserves exact descriptors.
      for (const name of replaced) {
        try {
          const descriptor = previous.get(name);
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else delete globalThis[name];
        } catch { cleanupFailed = true; }
      }
    }
    // Preserve the primary error; cleanup diagnostics never include sample data.
    if (cleanupFailed && !producerFailed) throw new Error('Legacy producer cleanup failed');
  }
}

// The former <baseline> <output-json> export interface is intentionally retired.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error('File export is retired. Run this script without arguments for a key-free verification summary.');
  const sample = await createTaskPlanningLegacySample();
  console.log(JSON.stringify({ sourceCommit: sample.sourceCommit, sourceFiles: sample.sourceFiles, syntheticOnly: true, memoryOnly: true, journalAndCiphertextEntries: Object.keys(sample.storage).length }));
}
