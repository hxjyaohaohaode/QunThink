import test, { after, beforeEach } from 'node:test';
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
globalThis.__goalPanelScope = { accountId: 'account-a', generation: 1 };

const bundled = await build({
  stdin: {
    contents: `import { createRoot } from 'react-dom/client';
      import { act } from 'react';
      import { PersonalGoalsPanel } from './src/components/Layout/PersonalGoalsPanel';
      export { usePersonalGoalsStore } from './src/stores/personalGoalsStore';
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
      build.onResolve({ filter: /^(\.\/api|\.\.\/services\/api)$/ }, () => ({ path: 'api', namespace: 'mock-panel-boundaries' }));
      build.onLoad({ filter: /^api$/, namespace: 'mock-panel-boundaries' }, () => ({
        contents: 'export const axiosInstance = globalThis.__goalPanelHttp; export const getAuthGeneration = () => globalThis.__goalPanelScope.generation;', loader: 'js',
      }));
      build.onResolve({ filter: /cacheUtils$/ }, () => ({ path: 'cache', namespace: 'mock-panel-boundaries' }));
      build.onLoad({ filter: /^cache$/, namespace: 'mock-panel-boundaries' }, () => ({
        contents: 'export const getCacheUserId = () => globalThis.__goalPanelScope.accountId;', loader: 'js',
      }));
      build.onResolve({ filter: /^\.\.\/Common$/ }, () => ({ path: 'common', namespace: 'mock-panel-boundaries' }));
      build.onLoad({ filter: /^common$/, namespace: 'mock-panel-boundaries' }, () => ({
        contents: 'export const useConfirm = () => ({ confirm: async () => true, ConfirmModal: null });', loader: 'js',
      }));
    },
  }],
});
const { mount, act, usePersonalGoalsStore } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
beforeEach(() => {
  globalThis.__goalPanelScope = { accountId: 'account-a', generation: 1 };
  usePersonalGoalsStore.getState().cleanup();
  globalThis.__goalPanelHttp.get = async () => ({ data: { goals: [], executionAvailable: false } });
  globalThis.__goalPanelHttp.post = async () => ({ data: {} });
});

const goalFixture = (id, outcome) => ({ id, outcome, constraints: [], budget_limit_micros: '0',
  budget_reserved_micros: '0', budget_spent_micros: '0', state: 'active', revision: '0', created_at: '2026-10-18T00:00:00Z' });
function serveGoals(goals) {
  globalThis.__goalPanelHttp.get = async path => ({ data: path === '/goals'
    ? { goals, executionAvailable: false }
    : { goal: goals.find(goal => path === `/goals/${goal.id}`), checks: [], runs: [], executionAvailable: false } });
}
async function view(t) {
  const container = document.createElement('div'); document.body.append(container);
  let root = await mount(container);
  const unmount = async () => { if (root) { await act(async () => root.unmount()); root = null; } };
  t.after(async () => { await unmount(); container.remove(); });
  return {
    container, unmount, remount: async () => { await unmount(); root = await mount(container); },
    click: async text => {
      const button = [...container.querySelectorAll('button')].find(item => item.textContent === text);
      assert.ok(button, `button ${text} exists`); await act(async () => button.click());
    },
    fill: async (index, value) => {
      const element = container.querySelectorAll('textarea')[index]; assert.ok(element);
      await act(async () => {
        Object.getOwnPropertyDescriptor(browserWindow.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new browserWindow.Event('input', { bubbles: true }));
      });
    },
    submit: async () => { await act(async () => container.querySelector('form').dispatchEvent(
      new browserWindow.Event('submit', { bubbles: true, cancelable: true }))); },
    open: async id => {
      const goal = [...container.querySelectorAll('button[aria-pressed]')].find(item => item.textContent.includes(id));
      assert.ok(goal); await act(async () => goal.click());
    },
  };
}

test('uncertain goal save and draft survive page navigation with the original retry key', async t => {
  const writes = [];
  globalThis.__goalPanelHttp.post = async (path, body, config) => {
    writes.push({ path, body, config }); throw Object.assign(new Error('connection lost'), { status: 503 });
  };
  const page = await view(t);
  await page.click('＋ 创建目标'); await page.fill(0, '保留原始目标'); await page.fill(2, '逐条验收');
  await page.submit(); await page.unmount();
  const unload = new browserWindow.Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true, 'warn about draft loss even while another page is open');
  await page.remount();
  assert.equal(page.container.querySelector('textarea').value, '保留原始目标');
  assert.match(page.container.textContent, /上次保存结果未确认/);
  await page.submit();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1], 'retry is the same operation, including the idempotency key');
  await page.unmount(); usePersonalGoalsStore.getState().cleanup();
  const cleanUnload = new browserWindow.Event('beforeunload', { cancelable: true }); window.dispatchEvent(cleanUnload);
  assert.equal(cleanUnload.defaultPrevented, false);
});

test('navigation retains an in-flight lock and a late save cannot erase newer input', async t => {
  let finish; let writes = 0;
  serveGoals([goalFixture('saved', '原目标')]);
  globalThis.__goalPanelHttp.post = () => { writes++; return new Promise(resolveWrite => { finish = resolveWrite; }); };
  const page = await view(t);
  await page.click('＋ 创建目标'); await page.fill(0, '原目标'); await page.fill(2, '验收原目标'); await page.submit();
  await page.remount();
  assert.equal([...page.container.querySelectorAll('button')].find(button => button.textContent === '保存中…').disabled, true);
  await page.submit(); assert.equal(writes, 1);
  await page.fill(0, '正在起草的下一个目标');
  await act(async () => { finish({ data: { goalId: 'saved' } }); });
  assert.equal(page.container.querySelector('textarea').value, '正在起草的下一个目标');
  assert.equal(usePersonalGoalsStore.getState().values.selectedId, null, 'late completion does not steal selection');
  assert.match(page.container.textContent, /目标已保存/);
});

test('account A to B to A fences old responses, private drafts and submission locks', async t => {
  let finish;
  globalThis.__goalPanelHttp.post = () => new Promise(resolveWrite => { finish = resolveWrite; });
  const page = await view(t);
  await page.click('＋ 创建目标'); await page.fill(0, 'A 私有草稿'); await page.fill(2, 'A 验收'); await page.submit();
  await page.unmount(); globalThis.__goalPanelScope = { accountId: 'account-b', generation: 2 }; await page.remount();
  assert.equal(page.container.querySelectorAll('textarea').length, 0);
  assert.doesNotMatch(page.container.textContent, /A 私有草稿|保存中/);
  await page.click('＋ 创建目标'); await page.fill(0, 'B 私有草稿');
  await page.unmount(); globalThis.__goalPanelScope = { accountId: 'account-a', generation: 3 }; await page.remount();
  await page.click('＋ 创建目标'); await page.fill(0, 'A 新会话草稿');
  await act(async () => { finish({ data: { goalId: 'old-account-operation' } }); });
  assert.equal(page.container.querySelector('textarea').value, 'A 新会话草稿');
  assert.doesNotMatch(page.container.textContent, /B 私有草稿|目标已保存|保存中/);
  assert.equal(usePersonalGoalsStore.getState().values.selectedId, null);
  assert.equal(usePersonalGoalsStore.getState().references.createAttempt.current, null);
});

test('run drafts belong to their goals and a background save preserves the current selection', async t => {
  const goals = [goalFixture('one', '第一个目标'), goalFixture('two', '第二个目标')]; serveGoals(goals);
  let finish; const writes = [];
  globalThis.__goalPanelHttp.post = (path, body) => { writes.push({ path, body }); return new Promise(resolveWrite => { finish = resolveWrite; }); };
  const page = await view(t);
  await page.open('第一个目标'); await page.click('记录执行步骤'); await page.fill(0, '第一项步骤'); await page.submit();
  await page.open('第二个目标'); await page.click('记录执行步骤'); await page.fill(0, '第二项步骤');
  await page.remount();
  await act(async () => { finish({ data: { runId: 'run-one' } }); });
  assert.equal(page.container.querySelector('textarea').value, '第二项步骤');
  assert.equal(usePersonalGoalsStore.getState().values.selectedId, 'two');
  assert.equal(writes[0].path, '/goals/one/runs');
  await page.open('第一个目标'); assert.equal(page.container.querySelectorAll('textarea').length, 0);
  await page.open('第二个目标'); assert.equal(page.container.querySelector('textarea').value, '第二项步骤');
});

test('a list response started before leaving the page cannot overwrite the newer list', async t => {
  let finishOld; let calls = 0;
  globalThis.__goalPanelHttp.get = () => ++calls === 1
    ? new Promise(resolveRead => { finishOld = resolveRead; })
    : Promise.resolve({ data: { goals: [goalFixture('new', '最新目标')], executionAvailable: false } });
  const page = await view(t); await page.remount();
  assert.match(page.container.textContent, /最新目标/);
  await act(async () => { finishOld({ data: { goals: [goalFixture('old', '旧目标')], executionAvailable: false } }); });
  assert.match(page.container.textContent, /最新目标/); assert.doesNotMatch(page.container.textContent, /旧目标/);
});

test('503 foundation error is visible and does not invite a submission', async () => {
  globalThis.__goalPanelHttp.get = async () => { throw Object.assign(new Error('目标服务未配置'), { status: 503 }); };
  const container = document.createElement('div');
  document.body.append(container);
  const root = await mount(container);
  await act(async () => { await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.match(container.textContent, /目标服务未配置、未迁移或暂不可用/);
  assert.match(container.textContent, /自动执行暂未开放/);
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
  assert.match(container.textContent, /自动执行暂未开放/);
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
  const briefButton = [...container.querySelectorAll('button')].find(button => button.textContent === '生成目标要求简报');
  await act(async () => { briefButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 1);
  assert.match(container.textContent, /上次请求结果未确认/);
  await act(async () => { briefButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].path, '/goals/goal-brief/briefs');
  assert.deepEqual(writes[0].body, {});
  assert.equal(writes[0].config.headers['Idempotency-Key'], writes[1].config.headers['Idempotency-Key']);
  assert.match(container.textContent, /上次请求结果未确认/);
  const retryButton = [...container.querySelectorAll('button')].find(button => button.textContent === '生成目标要求简报');
  await act(async () => { retryButton.click(); await new Promise(resolveWait => setTimeout(resolveWait, 0)); });
  assert.equal(writes.length, 3);
  assert.equal(writes[1].config.headers['Idempotency-Key'], writes[2].config.headers['Idempotency-Key']);
  assert.match(container.textContent, /群想目标执行简报 v1/);
  assert.match(container.textContent, /不可用作目标验收证据/);
  assert.doesNotMatch(container.textContent, /以此运行验收目标/);
  await act(async () => root.unmount());
  container.remove();
});
