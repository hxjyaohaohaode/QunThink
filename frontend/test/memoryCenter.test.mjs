import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const rootDir = resolve(import.meta.dirname, '..');
const browserWindow = new Window({ url: 'http://localhost/' });
after(() => browserWindow.close());
Object.assign(globalThis, { window: browserWindow, document: browserWindow.document,
  localStorage: browserWindow.localStorage, HTMLElement: browserWindow.HTMLElement, Element: browserWindow.Element,
  IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'navigator', { value: browserWindow.navigator, configurable: true });
browserWindow.HTMLElement.prototype.scrollIntoView = () => {};
class TestMessageChannel { port1 = { onmessage: null }; port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) }; }
Object.defineProperty(globalThis, 'MessageChannel', { value: TestMessageChannel, configurable: true });
globalThis.__memoryTest = { user: 'alice', confirm: async () => true };

// Real MemoryCenter, Zustand store, memory client and Axios interceptors. Only the HTTP
// transport and unrelated UI boundaries are replaced; no model or real account is used.
const bundled = await build({
  stdin: { contents: `import { createRoot } from 'react-dom/client'; import { act } from 'react';
    import { MemoryCenter } from './src/components/Layout/MemoryCenter';
    export { useMemoryStore as store } from './src/stores/memoryStore';
    export { axiosInstance } from './src/services/api';
    export { clearDiagnostics, exportDiagnostics } from './src/observability/runtimeDiagnostics';
    export async function mount(element) { const root = createRoot(element); await act(async () => root.render(<MemoryCenter />)); return root; }
    export { act };`, resolveDir: rootDir, sourcefile: 'test-memory-center.tsx', loader: 'tsx' },
  bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false,
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' },
  plugins: [{ name: 'memory-boundaries', setup(buildTool) {
    const routes = [ [/utils\/cacheUtils$/, 'cache'], [/\.\/runtimeConfig$/, 'runtime'],
      [/stores\/groupsStore$/, 'groups'], [/^\.\.\/Common$/, 'common'], [/^framer-motion$/, 'motion'] ];
    for (const [filter, path] of routes) buildTool.onResolve({ filter }, () => ({ path, namespace: 'test' }));
    buildTool.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ resolveDir: rootDir, loader: 'jsx', contents: {
      cache: 'export const getCacheUserId = () => globalThis.__memoryTest.user;',
      runtime: "export const getApiBaseUrl = () => '/api'; export const getApiBaseUrlCandidates = () => ['/api']; export const rememberBackendOrigin = () => {};",
      groups: 'export const useGroupsStore = selector => selector({ groups: [] });',
      common: 'export const useConfirm = () => ({ confirm: options => globalThis.__memoryTest.confirm(options), ConfirmModal: null });',
      motion: `import React from 'react'; const wrap = tag => React.forwardRef(({initial,animate,transition,layout,...props},ref) => React.createElement(tag,{...props,ref})); export const motion={div:wrap('div'),section:wrap('section'),article:wrap('article')}; export const useReducedMotion=()=>true;`,
    }[path] }));
  } }],
});
const { mount, act, store, axiosInstance, clearDiagnostics, exportDiagnostics } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const record = (id, content, revision = 0) => ({ id, content, revision, category: 'note', kind: 'user_note', evidence: 'user_asserted', confirmedFact: false, source: null, recordedAt: '2026-09-27T00:00:00Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (config, data) => ({ config, data, status: 200, statusText: 'OK', headers: {} });
const reject = (config, status, code) => { throw Object.assign(new Error('private server detail must not enter UI or diagnostics'), { config, response: { status, data: { code, error: 'private server detail must not enter UI or diagnostics' } } }); };
const network = config => { throw Object.assign(new Error('lost receipt'), { config, code: 'ERR_NETWORK' }); };
let records, keys, writes, reads, override;
async function adapter(config) {
  const body = config.data ? JSON.parse(config.data) : undefined;
  if (config.method === 'get') reads.push(config); else writes.push({ config, body });
  if (override) { const value = override(config, body); if (value !== undefined) return value; }
  if (config.url === '/memory' && config.method === 'get') {
    const offset = config.params.offset;
    return response(config, { total: records.length, offset, memories: records.slice(offset, offset + 100) });
  }
  if (config.url === '/memory/store') {
    const key = config.headers['Idempotency-Key'];
    const id = keys.get(key);
    if (id) {
      const old = records.find(memory => memory.id === id);
      if (!old) return reject(config, 410, 'MEMORY_FORGOTTEN');
      if (old.content !== body.content) return reject(config, 409, 'IDEMPOTENCY_CONFLICT');
      return response(config, { memoryId: id, memory: old, replayed: true });
    }
    const memory = record(`saved-${keys.size}`, body.content); keys.set(key, memory.id); records.unshift(memory);
    return response(config, { memoryId: memory.id, memory, replayed: false });
  }
  const [, id, operation] = /^\/memory\/([^/]+)(?:\/(correct|forget))?$/.exec(config.url) || [];
  const memory = records.find(memory => memory.id === id);
  if (operation === 'forget') { records = records.filter(memory => memory.id !== id); return response(config, { memoryId: id, forgotten: true }); }
  if (!memory) return reject(config, 410, 'MEMORY_FORGOTTEN');
  if (operation === 'correct') {
    if (memory.revision !== body.expectedRevision) return reject(config, 409, 'STALE_MEMORY');
    const changed = { ...memory, content: body.content, revision: memory.revision + 1 };
    records = records.map(item => item.id === id ? changed : item);
    return response(config, { memory: changed });
  }
  return response(config, { memory });
}
beforeEach(async () => {
  store.getState().cleanup(); globalThis.__memoryTest.user = 'alice'; globalThis.__memoryTest.confirm = async () => true;
  records = [record('note-1', '旧日期')]; keys = new Map(); writes = []; reads = []; override = null;
  clearDiagnostics(); localStorage.clear(); document.cookie = 'XSRF-TOKEN=synthetic-test-csrf';
  axiosInstance.defaults.adapter = adapter; store.getState().activate();
});
async function settle() { await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); }); }
async function render(t) {
  const container = document.createElement('div'); document.body.append(container);
  const root = await mount(container); await settle();
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return container;
}
function button(container, label) { const value = [...container.querySelectorAll('button')].find(button => button.textContent === label); assert.ok(value, label); return value; }
async function click(container, label) { await act(async () => button(container, label).click()); await settle(); }
async function input(element, text) {
  await act(async () => { Object.getOwnPropertyDescriptor(browserWindow.HTMLTextAreaElement.prototype, 'value').set.call(element, text); element.dispatchEvent(new browserWindow.Event('input', { bubbles: true })); });
}
async function submit(container) { await act(async () => container.querySelector('form').dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))); await settle(); }
async function prime() { await store.getState().refresh(); }
async function flush() { await new Promise(resolveWait => setTimeout(resolveWait, 0)); }

test('inspect, correct and confirm forgetting through the actual memory client', async t => {
  const container = await render(t);
  assert.match(container.textContent, /个人笔记 · 用户自述，未核验/);
  await click(container, '更正');
  assert.equal(document.activeElement, container.querySelector('[aria-label="更正个人笔记"]'));
  await input(container.querySelector('[aria-label="更正个人笔记"]'), '新日期');
  await click(container, '保存更正');
  assert.deepEqual(writes[0].body, { content: '新日期', expectedRevision: 0 });
  assert.match(container.textContent, /更正已保存/);
  await input(container.querySelector('#memory-note'), '以后查看'); await submit(container);
  assert.ok(writes[1].config.headers['Idempotency-Key']);
  assert.equal(writes[1].config.headers['X-Expected-User-Id'], 'alice');
  const article = [...container.querySelectorAll('article')].find(article => article.textContent.includes('新日期'));
  await click(article, '遗忘');
  assert.equal(writes[2].config.url, '/memory/note-1/forget');
  assert.doesNotMatch(container.textContent, /新日期/);
  assert.match(container.textContent, /当前保存的正文已清除/);
});

test('pagination uses server offsets and retains older records', async t => {
  records = Array.from({ length: 101 }, (_, index) => record(`many-${index}`, `记录 ${index}`));
  const container = await render(t); assert.equal(container.querySelectorAll('article').length, 100);
  await click(container, '加载较早记录（还有 1 条）');
  assert.equal(container.querySelectorAll('article').length, 101); assert.equal(reads.at(-1).params.offset, 100);
});

test('pending create freezes UI and intent; newer synthetic input is not erased', async t => {
  const pending = deferred(); override = config => config.url === '/memory/store' ? pending.promise : undefined;
  const container = await render(t);
  await input(container.querySelector('#memory-note'), '原输入'); await submit(container);
  assert.equal(container.querySelector('#memory-note').disabled, true);
  await act(async () => store.getState().setNote('随后误触输入')); assert.equal(store.getState().note, '原输入');
  await submit(container); assert.equal(writes.length, 1);
  const config = writes[0].config;
  await act(async () => pending.resolve(response(config, { memoryId: 'saved', memory: record('saved', '原输入') })));
  await settle(); assert.equal(store.getState().note, ''); assert.equal(store.getState().pending, null);
});

test('lost create receipt survives unmount; retry replays same exact key and only one record', async t => {
  let lose = true;
  override = (config, body) => {
    if (config.url !== '/memory/store' || !lose) return;
    lose = false; const memory = record('saved', body.content); keys.set(config.headers['Idempotency-Key'], memory.id); records.unshift(memory); return network(config);
  };
  let container = document.createElement('div'); document.body.append(container);
  let root = await mount(container); await settle();
  await input(container.querySelector('#memory-note'), '已提交但回执丢失'); await submit(container);
  assert.match(container.textContent, /笔记保存待核对/); const key = writes[0].config.headers['Idempotency-Key'];
  await act(async () => root.unmount()); container.remove();
  container = await render(t);
  assert.equal(container.querySelector('#memory-note').value, '已提交但回执丢失');
  assert.equal(container.querySelector('#memory-note').disabled, true);
  await click(container, '同一请求核对保存');
  assert.equal(writes.length, 2); assert.equal(writes[1].config.headers['Idempotency-Key'], key);
  assert.deepEqual(writes[1].body, writes[0].body); assert.equal(records.length, 2);
  assert.equal(store.getState().pending, null); assert.equal(localStorage.length, 0);
});

test('create conflict after remote correction keeps original key and makes existing records reviewable', async t => {
  let first = true;
  override = (config, body) => {
    if (config.url !== '/memory/store' || !first) return;
    first = false; keys.set(config.headers['Idempotency-Key'], 'saved'); records.unshift(record('saved', body.content)); return network(config);
  };
  const container = await render(t); await input(container.querySelector('#memory-note'), '原笔记'); await submit(container);
  records[0] = record('saved', '另一端更正后的内容', 1);
  await click(container, '同一请求核对保存');
  assert.match(container.textContent, /原请求对应的记录已存在且内容发生变化/);
  assert.match(container.textContent, /另一端更正后的内容/);
  await click(container, '查看现有记录'); assert.equal(document.activeElement.textContent, '可查看记录（2）');
  await act(async () => store.getState().setNote('不应另建')); await submit(container);
  assert.equal(writes.length, 2); assert.equal(store.getState().note, '原笔记');
  globalThis.__memoryTest.confirm = async () => false;
  await click(container, '结束本次核对…'); assert.ok(store.getState().pending);
  globalThis.__memoryTest.confirm = async () => true;
  await click(container, '结束本次核对…'); assert.equal(store.getState().pending, null); assert.equal(store.getState().note, ''); assert.equal(writes.length, 2);
});

test('tombstoned create retry never recreates a forgotten record', async () => {
  override = config => config.url === '/memory/store' ? network(config) : undefined;
  store.getState().setNote('后来遗忘'); await store.getState().saveNote();
  keys.set(writes[0].config.headers['Idempotency-Key'], 'already-forgotten'); override = null;
  await store.getState().retry();
  assert.equal(store.getState().pending, null); assert.equal(store.getState().note, ''); assert.equal(records.length, 1);
  assert.match(store.getState().notice, /已遗忘/);
});

test('a definitive rejection after an unknown save still cannot release the original intent', async () => {
  override = config => config.url === '/memory/store' ? network(config) : undefined;
  store.getState().setNote('不确定'); await store.getState().saveNote(); const key = store.getState().pending.key;
  override = config => config.url === '/memory/store' ? reject(config, 403, 'FORBIDDEN') : undefined;
  await store.getState().retry(); assert.equal(store.getState().pending.key, key); assert.equal(store.getState().note, '不确定');
});

test('unknown correction checks current revision without repeating a committed write', async () => {
  await prime(); store.getState().beginEdit(records[0]); store.getState().setEditText('已更正');
  override = (config, body) => { if (config.url.endsWith('/correct')) { records[0] = record('note-1', body.content, 1); return network(config); } };
  await store.getState().saveCorrection(); assert.ok(store.getState().pending);
  override = null; await store.getState().retry();
  assert.equal(writes.length, 1); assert.equal(store.getState().pending, null); assert.equal(store.getState().editing, null);
  assert.match(store.getState().notice, /当前记录与本次更正一致/); assert.ok(reads.some(config => config.url === '/memory/note-1'));
});

test('uncommitted correction retries only after GET shows unchanged base revision', async () => {
  await prime(); store.getState().beginEdit(records[0]); store.getState().setEditText('我的更正');
  override = config => config.url.endsWith('/correct') ? network(config) : undefined;
  await store.getState().saveCorrection(); override = null; await store.getState().retry();
  assert.equal(writes.length, 2); assert.deepEqual(writes[1].body, { content: '我的更正', expectedRevision: 0 });
  assert.equal(records[0].revision, 1);
});

test('remote revision conflict preserves draft until explicit rebase and a second save', async t => {
  const container = await render(t); await click(container, '更正');
  await input(container.querySelector('[aria-label="更正个人笔记"]'), '我的版本');
  records[0] = record('note-1', '另一端版本', 1); await act(async () => store.getState().refresh());
  await click(container, '保存更正');
  assert.equal(writes[0].body.expectedRevision, 0); assert.match(container.textContent, /另一端版本/);
  assert.equal(container.querySelector('[aria-label="更正个人笔记"]').value, '我的版本');
  await click(container, '基于当前版本继续编辑'); assert.equal(writes.length, 1);
  await click(container, '保存更正'); assert.equal(writes[1].body.expectedRevision, 1); assert.equal(records[0].content, '我的版本');
});

test('unknown correction followed by deletion preserves only editable user draft for copying', async () => {
  await prime(); store.getState().beginEdit(records[0]); store.getState().setEditText('保留我的输入');
  override = config => config.url.endsWith('/correct') ? network(config) : undefined;
  await store.getState().saveCorrection(); records = []; override = null; await store.getState().retry();
  assert.equal(writes.length, 1); assert.equal(store.getState().editing.text, '保留我的输入');
  assert.equal(store.getState().editing.baseContent, ''); assert.equal(store.getState().editing.unavailable, true);
  assert.equal(store.getState().memories.length, 0); assert.equal(store.getState().pending, null);
});

test('failed forgetting hides body across stale reads and retries only the same ID', async t => {
  const container = await render(t);
  override = config => config.url.endsWith('/forget') ? network(config) : undefined;
  await click(container, '遗忘'); assert.doesNotMatch(container.textContent, /旧日期/);
  await act(async () => store.getState().refresh()); assert.doesNotMatch(container.textContent, /旧日期/);
  assert.match(container.textContent, /遗忘结果尚未确认/);
  override = null; await click(container, '重试核对遗忘');
  assert.equal(writes.length, 2); assert.equal(writes[0].config.url, writes[1].config.url); assert.equal(store.getState().pending, null);
});

test('a canceled forget confirmation makes no request, and an old confirmation cannot affect another epoch', async t => {
  const container = await render(t); globalThis.__memoryTest.confirm = async () => false;
  await click(container, '遗忘'); assert.equal(writes.length, 0); assert.match(container.textContent, /旧日期/);
  const prompt = deferred(); globalThis.__memoryTest.confirm = () => prompt.promise;
  await click(container, '遗忘');
  await act(async () => { store.getState().cleanup(); store.getState().activate(); await store.getState().refresh(); });
  await act(async () => prompt.resolve(true)); await settle(); assert.equal(writes.length, 0);
});

test('out-of-order reads and a GET started during a write cannot roll back its receipt', async () => {
  const oldRead = deferred(), write = deferred(); let firstReadConfig, writeConfig;
  override = config => {
    if (config.url === '/memory') { firstReadConfig = config; return oldRead.promise; }
    if (config.url === '/memory/store') { writeConfig = config; return write.promise; }
  };
  store.getState().setNote('新笔记'); const saving = store.getState().saveNote(); await flush();
  const reading = store.getState().refresh(); await flush();
  override = null; records.unshift(record('saved', '新笔记'));
  write.resolve(response(writeConfig, { memoryId: 'saved', memory: records[0] })); await saving; await flush();
  oldRead.resolve(response(firstReadConfig, { total: 1, offset: 0, memories: [record('old', '过时列表')] })); await reading;
  assert.ok(store.getState().memories.some(memory => memory.id === 'saved')); assert.ok(!store.getState().memories.some(memory => memory.id === 'old'));
});

test('late A receipt cannot pollute B or later A session or clear its new busy state', async () => {
  const old = deferred(); let oldConfig;
  override = config => { if (config.url === '/memory/store') { oldConfig = config; return old.promise; } };
  store.getState().setNote('旧账号输入'); const saving = store.getState().saveNote(); await flush();
  store.getState().cleanup(); globalThis.__memoryTest.user = 'bob'; store.getState().activate(); store.getState().setNote('Bob草稿');
  store.getState().cleanup(); globalThis.__memoryTest.user = 'alice'; store.getState().activate(); store.getState().setNote('新的Alice草稿');
  old.resolve(response(oldConfig, { memoryId: 'old', memory: record('old', '旧账号输入') })); await saving;
  assert.equal(store.getState().note, '新的Alice草稿'); assert.equal(store.getState().memories.length, 0); assert.equal(store.getState().notice, '');
});

test('all actions self-fence an observed account switch even without App cleanup', async () => {
  await prime(); store.getState().setNote('Alice私密草稿'); globalThis.__memoryTest.user = 'bob';
  await store.getState().saveNote(); assert.equal(writes.length, 0); assert.equal(store.getState().note, ''); assert.equal(store.getState().memories.length, 0);
  store.getState().setNote('Bob草稿'); await store.getState().saveNote(); assert.equal(writes[0].config.headers['X-Expected-User-Id'], 'bob');
});

test('malformed success receipt remains unknown; errors and diagnostics never expose body, IDs or error text', async t => {
  override = config => config.url === '/memory/store' ? response(config, { success: true }) : undefined;
  const container = await render(t); await input(container.querySelector('#memory-note'), 'VERY_PRIVATE_BODY'); await submit(container);
  assert.ok(store.getState().pending); assert.match(container.textContent, /保存结果尚未确认/);
  assert.doesNotMatch(container.textContent, /private server detail/);
  assert.doesNotMatch(exportDiagnostics(), /VERY_PRIVATE_BODY|alice|note-1|\/memory|private server detail/);
  assert.equal(localStorage.length, 0);
});

test('loading failure is retryable without falsely claiming an empty library or losing draft', async t => {
  override = config => config.url === '/memory' ? reject(config, 400, 'READ_REJECTED') : undefined;
  const container = await render(t); await input(container.querySelector('#memory-note'), '未提交草稿');
  assert.match(container.textContent, /记录读取失败/); assert.doesNotMatch(container.textContent, /暂无可查看记录/);
  override = null; await click(container, '重新读取'); assert.match(container.textContent, /旧日期/); assert.equal(store.getState().note, '未提交草稿');
});

test('cached corrected body is scrubbed immediately when create replay reports forgotten and refresh fails', async () => {
  let first = true;
  override = (config, body) => { if (config.url === '/memory/store' && first) {
    first = false; keys.set(config.headers['Idempotency-Key'], 'saved'); records.unshift(record('saved', body.content)); return network(config);
  } };
  store.getState().setNote('原始私密正文'); await store.getState().saveNote(); await flush();
  records[0] = record('saved', '后来更正的私密正文', 1); await store.getState().refresh();
  assert.ok(store.getState().memories.some(memory => memory.content === '后来更正的私密正文'));
  records = records.filter(memory => memory.id !== 'saved');
  override = config => config.url === '/memory' ? reject(config, 400, 'READ_FAILED') : undefined;
  await store.getState().retry(); await flush();
  assert.equal(store.getState().pending, null); assert.deepEqual(store.getState().memories, []);
  assert.doesNotMatch(JSON.stringify(store.getState()), /私密正文/); assert.match(store.getState().notice, /已遗忘/);
});

test('pagination rechecks loaded prefix after external deletion without skipping surviving last record', async () => {
  records = Array.from({ length: 101 }, (_, index) => record(`many-${index}`, `记录 ${index}`));
  await prime(); records.shift(); await store.getState().loadMore();
  assert.equal(store.getState().memories.length, 100); assert.ok(store.getState().memories.some(memory => memory.id === 'many-100'));
  assert.ok(!store.getState().memories.some(memory => memory.id === 'many-0'));
});

test('unknown forget can be deferred without restoring content or losing same-ID recovery', async t => {
  const container = await render(t);
  override = config => config.url.endsWith('/forget') ? reject(config, 404, 'MEMORY_NOT_FOUND') : undefined;
  await click(container, '遗忘'); await click(container, '稍后核对，继续使用');
  assert.equal(store.getState().pending, null); assert.deepEqual(store.getState().deferredForget, ['note-1']);
  assert.doesNotMatch(container.textContent, /旧日期/); assert.match(container.textContent, /遗忘结果未确认/);
  await input(container.querySelector('#memory-note'), '其他工作'); await submit(container);
  assert.equal(writes[1].body.content, '其他工作'); override = null;
  await click(container, '继续核对遗忘（1）'); assert.equal(writes.at(-1).config.url, '/memory/note-1/forget');
  assert.deepEqual(store.getState().deferredForget, []);
});

test('no-op correction is not submitted and unavailable reconciliation never labels untouched source as a draft', async () => {
  await prime(); store.getState().beginEdit(records[0]); await store.getState().saveCorrection(); assert.equal(writes.length, 0);
  // Defensive recovery for a legacy/no-op pending intent created before this version.
  store.setState({ pending: { type: 'correct', id: 'note-1', content: '旧日期', draft: '旧日期', baseContent: '旧日期', revision: 0, uncertain: true } });
  records = []; await store.getState().retry();
  assert.equal(store.getState().editing, null); assert.doesNotMatch(JSON.stringify(store.getState()), /旧日期/);
});

test('Axios code-only revision error preserves semantic conflict rather than transport error code', async () => {
  await prime(); store.getState().beginEdit(records[0]); store.getState().setEditText('我的更正'); records[0] = record('note-1', '另一版本', 1);
  override = config => { if (config.url.endsWith('/correct')) throw Object.assign(new Error('HTTP failure'), { config, code: 'ERR_BAD_REQUEST', response: { status: 409, data: { code: 'STALE_MEMORY' } } }); };
  await store.getState().saveCorrection(); assert.equal(store.getState().editing.current.content, '另一版本'); assert.equal(store.getState().editing.text, '我的更正');
});

test('closing correction restores keyboard focus, and stale draft confirmation cannot clear a new editor', async t => {
  records.push(record('note-2', '第二份')); const container = await render(t);
  await click(container.querySelector('article'), '更正'); button(container, '取消').focus(); await click(container, '取消');
  assert.equal(document.activeElement.textContent, '更正');
  await click(container.querySelector('article'), '更正'); await input(container.querySelector('[aria-label="更正个人笔记"]'), '第一份改动');
  const prompt = deferred(); globalThis.__memoryTest.confirm = () => prompt.promise; await click(container, '取消');
  await act(async () => { const s = store.getState(); s.cancelEdit(s, s.editing); store.getState().beginEdit(records[1]); store.getState().setEditText('第二份改动'); });
  await act(async () => prompt.resolve(true)); await settle();
  assert.equal(store.getState().editing.id, 'note-2'); assert.equal(store.getState().editing.text, '第二份改动');
});

test('draft warning remains active after navigation unmount, then account cleanup releases it', async () => {
  const container = document.createElement('div'); document.body.append(container); const root = await mount(container); await settle();
  await input(container.querySelector('#memory-note'), '尚未保存'); await act(async () => root.unmount()); container.remove();
  const leaving = new browserWindow.Event('beforeunload', { cancelable: true }); window.dispatchEvent(leaving); assert.equal(leaving.defaultPrevented, true);
  store.getState().cleanup(); const clean = new browserWindow.Event('beforeunload', { cancelable: true }); window.dispatchEvent(clean); assert.equal(clean.defaultPrevented, false);
});

test('a stale old-account input event cannot carry its text into the newly observed account', async () => {
  store.getState().setNote('原账号草稿'); const oldSetter = store.getState().setNote;
  globalThis.__memoryTest.user = 'bob'; oldSetter('迟到的Alice输入');
  assert.equal(store.getState().accountId, 'bob'); assert.equal(store.getState().note, '');
  store.getState().setNote('当前Bob输入'); assert.equal(store.getState().note, '当前Bob输入');
});
