import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { build } from 'esbuild';
import { resolve } from 'node:path';

// Render the real modal. Store doubles record creation intent without making
// network requests, creating production data, or calling a model provider.
const root = resolve(import.meta.dirname, '..');
const window = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, Element: window.Element,
  requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true, get() { return this.hidden ? 0 : 100; },
});
class Channel {
  port1 = { onmessage: null };
  port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
}
Object.defineProperty(globalThis, 'MessageChannel', { value: Channel, configurable: true });
const state = globalThis.__newChatModalTest = {};
const bundled = await build({
  stdin: {
    contents: `
      import { createRoot } from 'react-dom/client';
      import { act } from 'react';
      import { NewChatModal } from './src/components/Layout/NewChatModal';
      export { act };
      export async function render(container) {
        const root = createRoot(container);
        await act(async () => root.render(<NewChatModal isOpen
          onClose={() => globalThis.__newChatModalTest.closed++}
          onSelectGroup={id => globalThis.__newChatModalTest.selected.push(id)} />));
        return root;
      }
    `,
    resolveDir: root, sourcefile: 'new-chat-modal-test.tsx', loader: 'tsx',
  },
  bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', write: false,
  plugins: [{ name: 'creation-boundary', setup(build) {
    build.onResolve({ filter: /stores\/modelsStore$/ }, () => ({ path: 'models', namespace: 'mock' }));
    build.onResolve({ filter: /stores\/groupsStore$/ }, () => ({ path: 'groups', namespace: 'mock' }));
    build.onResolve({ filter: /stores\/personasStore$/ }, () => ({ path: 'personas', namespace: 'mock' }));
    build.onResolve({ filter: /^\.\.\/Common$/ }, () => ({ path: 'toast', namespace: 'mock' }));
    const sources = {
      models: 'export const useChatModelIds = () => globalThis.__newChatModalTest.models;',
      personas: 'export const usePersonasStore = select => select({ personas: {} });',
      groups: `export const useGroupsStore = select => select({
        createGroup: async (...args) => {
          globalThis.__newChatModalTest.groups.push(args); return { id: 'synthetic-group' };
        },
        createAIPrivateChat: async (...args) => {
          globalThis.__newChatModalTest.aiPrivate.push(args); return { id: 'synthetic-ai-private' };
        },
        getOrCreatePrivateChat: async (...args) => {
          globalThis.__newChatModalTest.private.push(args); return { id: 'synthetic-private' };
        },
      });`,
      toast: `export const useToast = () => ({
        showToast: toast => globalThis.__newChatModalTest.toasts.push(toast), Toast: null,
      });`,
    };
    build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: sources[path], loader: 'js' }));
  } }],
});
const { act, render } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const aiHint = '请至少选择 2 个 AI 后创建；暂不连接模型时，可切换到「创建群聊」。';
const groupHint = '可以先建立会话、放入材料和人工写作；未连接模型时不会自动回复';
let container, mounted;
const buttons = text => [...container.querySelectorAll('button')].filter(el =>
  el.textContent.trim() === text || [...el.querySelectorAll('span')].some(span => span.textContent === text));
const button = text => {
  const matches = buttons(text);
  assert.equal(matches.length, 1, `Expected one button named ${text}`);
  return matches[0];
};
const click = async element => act(async () => element.click());
async function input(placeholder, value) {
  const element = container.querySelector(`input[placeholder="${placeholder}"]`);
  assert.ok(element, `Missing input ${placeholder}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function finishCreation() {
  // Let the real modal's close animation settle before disposing the DOM.
  await act(async () => new Promise(resolve => setTimeout(resolve, 275)));
  assert.equal(state.closed, 1);
}
beforeEach(async () => {
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = document.createElement('div'); document.body.append(container); mounted = null;
  Object.assign(state, {
    models: ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f'],
    groups: [], aiPrivate: [], private: [], selected: [], toasts: [], closed: 0,
  });
});
after(async () => { if (mounted) await act(async () => mounted.unmount()); window.close(); });

for (const available of [0, 1]) {
  test(`AI-to-AI chat with ${available} available models explains its minimum and cannot create`, async () => {
    state.models = state.models.slice(0, available);
    mounted = await render(container);
    await click(button('AI 与 AI 私聊'));
    if (available) await click(button('model-a'));
    assert.ok(container.textContent.includes(aiHint));
    assert.ok(!container.textContent.includes(groupHint));
    assert.equal(button('创建 AI 私聊').disabled, true);
    await click(button('创建 AI 私聊'));
    assert.deepEqual(state.aiPrivate, []);
    assert.deepEqual(state.groups, []);
  });
}

test('two selected AI members enable creation with the exact selected members and optional fields', async () => {
  mounted = await render(container); await click(button('AI 与 AI 私聊'));
  await click(button('model-a')); await click(button('model-b'));
  assert.ok(!container.textContent.includes(aiHint));
  assert.ok(!container.textContent.includes(groupHint));
  assert.equal(button('创建 AI 私聊').disabled, false);
  await input('输入聊天名称，留空则自动生成', '合成测试私聊');
  await input('输入聊天话题', '合成测试话题');
  await click(button('创建 AI 私聊')); await finishCreation();
  assert.deepEqual(state.aiPrivate, [[['model-a', 'model-b'], '合成测试话题', '合成测试私聊']]);
  assert.deepEqual(state.groups, []);
  assert.deepEqual(state.selected, ['synthetic-ai-private']);
});

test('deselecting from two members restores the minimum hint and disabled creation', async () => {
  mounted = await render(container); await click(button('AI 与 AI 私聊'));
  await click(button('model-a')); await click(button('model-b')); await click(button('model-a'));
  assert.ok(container.textContent.includes(aiHint));
  assert.equal(button('创建 AI 私聊').disabled, true);
  await click(button('创建 AI 私聊'));
  assert.deepEqual(state.aiPrivate, []);
});

test('AI-to-AI selection remains capped at five members', async () => {
  mounted = await render(container); await click(button('AI 与 AI 私聊'));
  for (const model of state.models) await click(button(model));
  assert.ok(container.textContent.includes('5/5'));
  assert.deepEqual(state.toasts, [{ message: '最多选择 5 个 AI', type: 'warning' }]);
  await click(button('创建 AI 私聊')); await finishCreation();
  assert.deepEqual(state.aiPrivate, [[state.models.slice(0, 5), undefined, undefined]]);
});

for (const available of [0, 2]) {
  test(`ordinary group with ${available} available models still permits zero AI members`, async () => {
    state.models = state.models.slice(0, available);
    mounted = await render(container); await click(button('创建群聊'));
    assert.ok(container.textContent.includes(groupHint));
    assert.ok(!container.textContent.includes(aiHint));
    const create = () => buttons('创建群聊').at(-1);
    assert.equal(create().disabled, true);
    await input('输入群聊名称', '   '); assert.equal(create().disabled, true);
    await input('输入群聊名称', '合成无模型群聊'); assert.equal(create().disabled, false);
    await click(create()); await finishCreation();
    assert.deepEqual(state.groups, [['合成无模型群聊', '新的对话', [], undefined]]);
    assert.deepEqual(state.aiPrivate, []);
    assert.deepEqual(state.selected, ['synthetic-group']);
  });
}

test('switching tabs keeps group and AI-to-AI membership requirements independent', async () => {
  mounted = await render(container); await click(button('AI 与 AI 私聊'));
  await click(button('model-a')); await click(button('model-b'));
  await click(button('创建群聊'));
  assert.ok(container.textContent.includes(groupHint));
  await input('输入群聊名称', '合成单模型群聊');
  await click(button('model-c'));
  assert.ok(!container.textContent.includes(groupHint));
  await click(button('AI 与 AI 私聊'));
  assert.equal(button('创建 AI 私聊').disabled, false);
  assert.ok(container.textContent.includes('2/5'));
  await click(button('创建群聊')); await click(buttons('创建群聊').at(-1)); await finishCreation();
  assert.deepEqual(state.groups, [['合成单模型群聊', '新的对话', ['model-c'], undefined]]);
  assert.deepEqual(state.aiPrivate, []);
});

test('empty model catalog explains BYOK onboarding in every chat tab without preset private targets', async () => {
  state.models=[];mounted=await render(container);
  const onboarding=/暂无可用的对话模型。请到设置中的“模型中心”添加自己的服务商和模型，保存后完成对话测试。平台不提供预置 AI。/;
  assert.match(container.querySelector('[role="status"]').textContent,onboarding);
  assert.equal(container.querySelector('.grid.grid-cols-3').children.length,0);
  assert.deepEqual(state.private,[]);
  await click(button('AI 与 AI 私聊'));
  assert.match(container.querySelector('[role="status"]').textContent,onboarding);
  assert.equal(button('创建 AI 私聊').disabled,true);
  await click(button('创建群聊'));
  assert.match(container.querySelector('[role="status"]').textContent,onboarding);
  assert.ok(container.textContent.includes(groupHint));
  assert.deepEqual(state.groups,[]);assert.deepEqual(state.aiPrivate,[]);assert.deepEqual(state.private,[]);
});
