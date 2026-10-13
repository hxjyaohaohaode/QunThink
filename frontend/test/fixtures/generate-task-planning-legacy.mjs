// Run explicitly with a baseline checkout. This is not part of ordinary tests.
// Only synthetic local data is generated; no service/model calls are made.
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const baseline = process.argv[2], output = process.argv[3];
if (!baseline || !output) throw new Error('Usage: node generate-task-planning-legacy.mjs <baseline-repository> <output-json>');
const sourceCommit = '533d7be3cdd47691602574ccac7c6524e7ed7ab3', sourceFiles = {};
for (const file of ['frontend/src/stores/tasksStore.ts', 'frontend/src/stores/taskMetadataSlice.ts', 'frontend/src/utils/taskMetadataRecovery.ts', 'frontend/src/utils/taskRecovery.ts']) {
 const expected = execFileSync('git', ['show', `${sourceCommit}:${file}`], { cwd: baseline });
 const actual = await readFile(resolve(baseline, file)); if (!actual.equals(expected)) throw new Error(`Baseline source differs from public commit: ${file}`);
 sourceFiles[file] = createHash('sha256').update(actual).digest('hex');
}
const window = new Window({ url: 'https://qunthink.test/' }); globalThis.localStorage = window.localStorage;
const databases = new Map();
globalThis.indexedDB = { open(name) { const request = {}; queueMicrotask(() => { let values = databases.get(name), fresh = !values; if (!values) { values = new Map(); databases.set(name, values); } const db = { close() {}, createObjectStore() {}, transaction() { const tx = {}; tx.objectStore = () => ({ get(key) { const r = {}; queueMicrotask(() => { r.result = values.get(key); r.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); }); return r; }, put(value, key) { values.set(key, value); } }); return tx; } }; request.result = db; if (fresh) request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } };
const keyMaterial = Array.from({ length: 32 }, (_, index) => index + 1);
Object.defineProperty(crypto.subtle, 'generateKey', { configurable: true, value: () => crypto.subtle.importKey('raw', new Uint8Array(keyMaterial), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) });
const root = resolve(baseline, 'frontend');
let tasks = [];
globalThis.__legacy = { user: 'alice', auth: 1, get: async path => { if (path === '/tasks') return { data: tasks }; throw new Error('unknown synthetic receipt'); }, post: async () => { throw new Error('lost synthetic create ACK'); }, put: async () => { throw new Error('lost synthetic metadata ACK'); } };
const built = await build({ stdin: { resolveDir: root, loader: 'ts', contents: `export {useTasksStore} from './src/stores/tasksStore';export * from './src/utils/taskRecovery';` }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'baseline-transport', setup(build) {
 build.onResolve({ filter: /services\/api$/ }, () => ({ path: 'api', namespace: 'synthetic' }));
 build.onResolve({ filter: /(?:utils\/|\.\/)cacheUtils$/ }, () => ({ path: 'cache', namespace: 'synthetic' }));
 build.onResolve({ filter: /^\.\/modelsStore$/ }, () => ({ path: 'models', namespace: 'synthetic' }));
 build.onLoad({ filter: /.*/, namespace: 'synthetic' }, ({ path }) => ({ loader: 'js', contents: path === 'api' ? `export const getAuthGeneration=()=>globalThis.__legacy.auth;export const axiosInstance=Object.fromEntries(['get','post','put','patch','delete'].map(method=>[method,(...args)=>globalThis.__legacy[method](...args)]));` : path === 'cache' ? `export const getCacheUserId=()=>globalThis.__legacy.user;` : `export const requestError=error=>error.message;` }));
} }] });
const { useTasksStore: store, setWritingPreferences } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
setWritingPreferences({ recoverDrafts: true, offlineCopies: false });
const createPayload = { title: '旧版合成创建', prompt: '旧版合成内容', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false };
try { await store.getState().create(createPayload); } catch {}
await new Promise(resolve => setTimeout(resolve, 0));
const id = '10000000-0000-4000-8000-000000000001';
tasks = [{ id, title: '原任务', prompt: 'PRIVATE-PROMPT', status: 'pending', category: 'work', auto_run: false, run_at: null, metadata_revision: 0, dependency_ids: [], dependency_revision: 0, history: [], result: 'PRIVATE-RESULT' }]; store.setState({ tasks });
store.getState().editMetadata(id, { title: '私密标题-NEW', auto_run: true, run_at: '2030-02-03T04:05:00.000Z' }); try { await store.getState().saveMetadata(id); } catch {}
const metadataPayload = store.getState().metadataIntents[id]?.payload; if (!metadataPayload) throw new Error('Baseline metadata intent was not captured');
await writeFile(resolve(output), JSON.stringify({ sourceCommit, sourceFiles, fixtureNote: 'Synthetic public AES key for compatibility testing only; emitted by byte-verified baseline production code.', owner: 'alice', keyMaterial, storage: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])), createPayload, metadataPayload }, null, 2) + '\n');
console.log(JSON.stringify({ sourceCommit, sourceFiles, output: resolve(output), journalAndCiphertextEntries: localStorage.length, syntheticOnly: true }, null, 2));
window.close();
