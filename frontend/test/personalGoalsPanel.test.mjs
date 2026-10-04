import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserWindow = new Window({ url: 'http://localhost/' });
after(() => browserWindow.close());
globalThis.window = browserWindow;
globalThis.document = browserWindow.document;
Object.defineProperty(globalThis, 'navigator', { value: browserWindow.navigator, configurable: true });
globalThis.HTMLElement = browserWindow.HTMLElement;
globalThis.Node = browserWindow.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestMessageChannel {
  port1 = { onmessage: null };
  port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
}
Object.defineProperty(globalThis, 'MessageChannel', { value: TestMessageChannel, configurable: true });
globalThis.__goalPanelHttp = { get: async () => ({ data: { goals: [], executionAvailable: false } }), post: async () => ({ data: {} }) };

const bundled = await build({
  stdin: {
    contents: `import { createRoot } from 'react-dom/client';
      import { act } from 'react';
      import { PersonalGoalsPanel } from './src/components/Layout/PersonalGoalsPanel';
      export async function mount(element) { const root = createRoot(element); await act(async () => { root.render(<PersonalGoalsPanel />); }); return root; }
      export { act };`,
    resolveDir: frontendRoot,
    sourcefile: 'test-goal-panel.tsx',
    loader: 'tsx',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  write: false,
  define: { 'import.meta.env.DEV': 'false' },
  plugins: [{
    name: 'mock-panel-boundaries',
    setup(build) {
      build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'mock-panel-boundaries' }));
      build.onLoad({ filter: /^api$/, namespace: 'mock-panel-boundaries' }, () => ({
        contents: 'export const axiosInstance = globalThis.__goalPanelHttp;', loader: 'js',
      }));
      build.onResolve({ filter: /^\.\.\/Common$/ }, () => ({ path: 'common', namespace: 'mock-panel-boundaries' }));
      build.onLoad({ filter: /^common$/, namespace: 'mock-panel-boundaries' }, () => ({
        contents: 'export const useConfirm = () => ({ confirm: async () => true, ConfirmModal: null });', loader: 'js',
      }));
    },
  }],
});
const { mount, act } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('503 foundation error is visible and does not invite a submission', async () => {
  globalThis.__goalPanelHttp.get = async () => { throw Object.assign(new Error('目标服务未配置'), { status: 503 }); };
  const container = document.createElement('div');
  document.body.append(container);
  const root = await mount(container);
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.match(container.textContent, /目标服务未配置、未迁移或暂不可用/);
  assert.match(container.textContent, /通用 Agent 执行仍不可用/);
  const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('创建目标'));
  assert.equal(createButton?.disabled, true);
  await act(async () => root.unmount());
  container.remove();
});

test('double submission creates one goal and keeps acceptance requirements', async () => {
  let resolveCreate;
  const writes = [];
  globalThis.__goalPanelHttp.get = async (path) => ({ data: path === '/goals'
    ? { goals: [], executionAvailable: false }
    : { goal: { id: 'goal-1', outcome: '完成交付', constraints: [], budget_limit_micros: '0', budget_spent_micros: '0', state: 'active', revision: 0, created_at: new Date().toISOString() }, checks: [{ check_key: 'check-1', description: '文件可打开', required: true }], runs: [], executionAvailable: false } });
  globalThis.__goalPanelHttp.post = (path, body, config) => {
    writes.push({ path, body, config });
    return new Promise(resolveWrite => { resolveCreate = resolveWrite; });
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = await mount(container);
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  const createButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('创建目标'));
  await act(async () => createButton.click());
  const fields = container.querySelectorAll('textarea');
  const setText = (element, value) => {
    Object.getOwnPropertyDescriptor(browserWindow.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new browserWindow.Event('input', { bubbles: true }));
  };
  await act(async () => { setText(fields[0], '完成交付'); setText(fields[2], '文件可打开'); });
  const form = container.querySelector('form');
  await act(async () => {
    form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].body.checks[0].description, '文件可打开');
  assert.ok(writes[0].config.headers['Idempotency-Key']);
  await act(async () => {
    resolveCreate({ data: { goalId: 'goal-1', executionAvailable: false } });
    await new Promise(resolveWait => setTimeout(resolveWait, 0));
  });
  assert.match(container.textContent, /目标已保存/);
  await act(async () => root.unmount());
  container.remove();
});

test('queued run is shown as unexecuted and pause uses the durable transition endpoint', async () => {
  let runState = 'queued';
  const writes = [];
  const goal = { id: 'goal-1', outcome: '完成交付', constraints: [], budget_limit_micros: '0', budget_spent_micros: '0', state: 'active', revision: '0', created_at: new Date().toISOString() };
  const run = () => ({ id: 'run-1', state: runState, goal_revision: '0', revision: '0', wait_reason: null, created_at: new Date().toISOString() });
  globalThis.__goalPanelHttp.get = async (path) => ({ data: path === '/goals'
    ? { goals: [goal], executionAvailable: false }
    : { goal, checks: [{ check_key: 'check-1', description: '文件可打开', required: true }], runs: [run()], executionAvailable: false } });
  globalThis.__goalPanelHttp.post = async (path, body, config) => {
    writes.push({ path, body, config });
    if (path.endsWith('/pause')) runState = 'paused';
    return { data: { state: runState } };
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = await mount(container);
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  const goalButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('完成交付'));
  await act(async () => goalButton.click());
  assert.match(container.textContent, /待继续或验收/);
  assert.match(container.textContent, /其他步骤没有自动执行者/);
  assert.doesNotMatch(container.textContent, /以此运行验收目标/);
  const pauseButton = [...container.querySelectorAll('button')].find(button => button.textContent === '暂停');
  await act(async () => { pauseButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/goals/goal-1/runs/run-1/pause');
  assert.ok(writes[0].config.headers['Idempotency-Key']);
  assert.match(container.textContent, /已暂停/);
  await act(async () => root.unmount());
  container.remove();
});

test('explicit zero-cost brief retries with one key and opens persisted content without claiming acceptance', async () => {
  const goal = {
    id: 'goal-brief', outcome: '整理资料', constraints: ['不外发'],
    budget_limit_micros: '0', budget_spent_micros: '0',
    state: 'active', revision: '0', created_at: new Date().toISOString(),
  };
  const writes = [];
  let calls = 0;
  globalThis.__goalPanelHttp.get = async path => ({ data: path === '/goals'
    ? { goals: [goal], executionAvailable: false }
    : path.endsWith('/brief')
      ? { artifactId: 'artifact-1', revision: 0, content: '群想目标执行简报 v1\n预期成果：整理资料',
          contentHash: 'a'.repeat(64), source: { goalId: goal.id, goalRevision: 1, runId: 'run-brief', stepKey: 'brief' } }
      : { goal, checks: [{ check_key: 'check-1', description: '文件可打开', required: true }],
          runs: [{ id: 'run-brief', state: 'queued', goal_revision: '1', revision: '2', wait_reason: null,
            created_at: new Date().toISOString() }], executionAvailable: false } });
  globalThis.__goalPanelHttp.post = async (path, body, config) => {
    writes.push({ path, body, config });
    calls++;
    if (calls === 1) throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
    return { data: { runId: 'run-brief', artifactId: calls === 2 ? null : 'artifact-1', runState: 'queued', replayed: true,
      advancement: { state: 'awaiting_acceptance', advanced: false }, executionAvailable: false,
      briefExecutionAvailable: true } };
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = await mount(container);
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  const goalButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('整理资料'));
  await act(async () => goalButton.click());
  const briefButton = [...container.querySelectorAll('button')].find(button => button.textContent === '生成目标执行简报');
  await act(async () => { briefButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 1);
  assert.match(container.textContent, /上次请求结果未确认/);
  await act(async () => { briefButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, '/goals/goal-brief/briefs');
  assert.deepEqual(writes[0].body, {});
  assert.equal(writes[0].config.headers['Idempotency-Key'], writes[1].config.headers['Idempotency-Key']);
  assert.match(container.textContent, /上次请求结果未确认/);
  const retryButton = [...container.querySelectorAll('button')].find(button => button.textContent === '生成目标执行简报');
  await act(async () => { retryButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 3);
  assert.equal(writes[1].config.headers['Idempotency-Key'], writes[2].config.headers['Idempotency-Key']);
  assert.match(container.textContent, /群想目标执行简报 v1/);
  assert.match(container.textContent, /不可用作目标验收证据/);
  assert.doesNotMatch(container.textContent, /以此运行验收目标/);
  await act(async () => root.unmount());
  container.remove();
});
