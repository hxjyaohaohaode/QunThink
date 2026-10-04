import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserWindow = new Window({ url: 'http://localhost/' });
after(() => browserWindow.close());
globalThis.window = browserWindow;
globalThis.document = browserWindow.document;
Object.defineProperty(globalThis, 'navigator', { value: browserWindow.navigator, configurable: true });
globalThis.HTMLElement = browserWindow.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestMessageChannel {
  port1 = { onmessage: null };
  port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
}
Object.defineProperty(globalThis, 'MessageChannel', { value: TestMessageChannel, configurable: true });

const calls = [];
const listOffsets = [];
let records = [{ id: 'note-1', content: '旧日期', kind: 'user_note', evidence: 'user_asserted',
  confirmedFact: false, source: null, revision: 0, recordedAt: '2026-09-27T00:00:00Z' }];
globalThis.__memoryApi = {
  list: async (offset = 0) => {
    listOffsets.push(offset);
    return { total: records.length, memories: records.slice(offset, offset + 100) };
  },
  store: async (content, key) => {
    calls.push({ operation: 'store', content, key });
    records = [...records, { id: 'note-2', content, kind: 'user_note', evidence: 'user_asserted',
      confirmedFact: false, source: null, revision: 0, recordedAt: '2026-09-27T00:00:00Z' }];
  },
  correct: async (id, content, expectedRevision) => {
    calls.push({ operation: 'correct', id, content, expectedRevision });
    records = records.map(record => record.id === id ? { ...record, content, revision: record.revision + 1 } : record);
  },
  forget: async id => { calls.push({ operation: 'forget', id }); records = records.filter(record => record.id !== id); },
};

const bundled = await build({
  stdin: { contents: `import { createRoot } from 'react-dom/client';
    import { act } from 'react';
    import { MemoryCenter } from './src/components/Layout/MemoryCenter';
    export async function mount(element) { const root = createRoot(element); await act(async () => root.render(<MemoryCenter />)); return root; }
    export { act };`, resolveDir: rootDir, sourcefile: 'test-memory-center.tsx', loader: 'tsx' },
  bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false,
  plugins: [{ name: 'mock-memory-boundaries', setup(buildTool) {
    buildTool.onResolve({ filter: /^\.\.\/\.\.\/services\/memory$/ }, () => ({ path: 'memory', namespace: 'test' }));
    buildTool.onLoad({ filter: /^memory$/, namespace: 'test' }, () => ({
      contents: 'export const memoryApi = globalThis.__memoryApi;', loader: 'js' }));
    buildTool.onResolve({ filter: /^\.\.\/\.\.\/stores\/groupsStore$/ }, () => ({ path: 'groups', namespace: 'test' }));
    buildTool.onLoad({ filter: /^groups$/, namespace: 'test' }, () => ({
      contents: 'export const useGroupsStore = selector => selector({ groups: [] });', loader: 'js' }));
    buildTool.onResolve({ filter: /^\.\.\/Common$/ }, () => ({ path: 'common', namespace: 'test' }));
    buildTool.onLoad({ filter: /^common$/, namespace: 'test' }, () => ({
      contents: 'export const useConfirm = () => ({ confirm: async () => true, ConfirmModal: null });', loader: 'js' }));
  } }],
});
const { mount, act } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

async function settle() { await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); }); }
function setText(element, value) {
  Object.getOwnPropertyDescriptor(browserWindow.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new browserWindow.Event('input', { bubbles: true }));
}

test('user can inspect, correct and forget a note through the workspace panel', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const rendered = await mount(container); await settle();
  assert.match(container.textContent, /个人笔记 · 用户自述，未核验/);
  const correct = [...container.querySelectorAll('button')].find(button => button.textContent === '更正');
  await act(async () => correct.click());
  await act(async () => setText(container.querySelector('[aria-label="更正个人笔记"]'), '新日期'));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '保存更正').click());
  await settle();
  assert.deepEqual(calls[0], { operation: 'correct', id: 'note-1', content: '新日期', expectedRevision: 0 });
  assert.match(container.textContent, /新日期/);
  const noteInput = container.querySelector('#memory-note');
  await act(async () => setText(noteInput, '以后查看'));
  await act(async () => container.querySelector('form').dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(calls[1].operation, 'store');
  assert.equal(calls[1].content, '以后查看');
  assert.ok(calls[1].key);
  const forget = [...container.querySelectorAll('article')].find(article => article.textContent.includes('新日期'))
    .querySelectorAll('button');
  await act(async () => [...forget].find(button => button.textContent === '遗忘').click());
  await settle();
  assert.deepEqual(calls[2], { operation: 'forget', id: 'note-1' });
  assert.doesNotMatch(container.textContent, /新日期/);
  await act(async () => rendered.unmount()); container.remove();
});

test('older memories can be loaded and remain available for management', async () => {
  records = Array.from({ length: 101 }, (_, index) => ({ id: `many-${index}`,
    content: `记录 ${index}`, kind: 'user_note', evidence: 'user_asserted',
    confirmedFact: false, source: null, revision: 0, recordedAt: '2026-09-27T00:00:00Z' }));
  const container = document.createElement('div'); document.body.append(container);
  const rendered = await mount(container); await settle();
  assert.equal(container.querySelectorAll('article').length, 100);
  const more = [...container.querySelectorAll('button')].find(button => button.textContent.includes('加载较早记录'));
  await act(async () => more.click()); await settle();
  assert.equal(container.querySelectorAll('article').length, 101);
  assert.equal(listOffsets.at(-1), 100);
  await act(async () => rendered.unmount()); container.remove();
});
