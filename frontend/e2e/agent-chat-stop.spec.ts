import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerSyntheticAccount } from './authFixture';
import { AGENT_FIXTURE_ORIGIN, AGENT_PARTIAL, AGENT_COMPLETE } from '../scripts/agent-chat-fixture.mjs';

// Real Chromium click -> real authenticated API -> keyless local HTTP provider.
// No route mocks, store mutation, forced clicks, fixed sleeps, or live API keys.
test.use({ trace: 'on', video: 'on' });
test('Agent stop preserves partial output and permits a new explicit message', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  const { csrfToken } = await (await context.request.get('/api/csrf-token')).json();
  const headers = { 'x-csrf-token': csrfToken };
  const catalogResponse = await context.request.get('/api/user/model-catalog');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = await catalogResponse.json();
  const model = `agent-fixture-${randomUUID()}`;
  const saved = await context.request.put('/api/user/model-catalog', { headers, data: {
    revision: catalog.revision,
    providers: [...catalog.providers, { id: model, name: 'Keyless loopback fixture', protocol: 'openai', baseUrl: `${AGENT_FIXTURE_ORIGIN}/v1`, enabled: true, keyRequired: false }],
    models: [...catalog.models, { id: model, providerId: model, name: 'Agent browser fixture', model, enabled: true, capabilities: ['chat'], contextWindow: 32000, maxTokens: 4096 }],
    defaults: { ...catalog.defaults, chat: model }
  } });
  expect(saved.status(), await saved.text()).toBe(200);
  const probe = await context.request.post('/api/user/model-catalog/test', { headers, data: { modelId: model, capability: 'chat', clientRequestId: randomUUID() } });
  expect(probe.status(), await probe.text()).toBe(200);
  const created = await context.request.post('/api/agents', { headers, data: { name: '停止生成验收助手', description: '只使用无费用本地协议fixture', openingMessage: '合成验收开场白', enableSuggestions: false, capabilities: {}, modelId: model } });
  expect(created.status(), await created.text()).toBe(200);
  const agent = await created.json();
  const observedCalls = async () => {
    const response = await context.request.get(`${AGENT_FIXTURE_ORIGIN}/__agent/observations`);
    expect(response.ok()).toBe(true);
    return (await response.json()).calls.filter((call: { model: string; stream: boolean }) => call.model === model && call.stream);
  };
  const history = async () => {
    const response = await context.request.get(`/api/agents/${agent.id}/messages`);
    expect(response.ok()).toBe(true); return response.json();
  };

  await page.goto('/');
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  await page.getByRole('heading', { name: agent.name, exact: true }).click();
  const input = page.getByPlaceholder('输入消息或上传附件...');
  await expect(input).toBeVisible();
  await input.fill('AGENT-E2E-STOP 请开始这一条受控回复');
  await input.press('Enter');
  await expect(page.getByText(AGENT_PARTIAL, { exact: true })).toBeVisible();
  const stop = page.getByRole('button', { name: '停止生成', exact: true });
  await expect(stop).toBeEnabled();
  await page.screenshot({ path: info.outputPath('agent-stop-ready.png'), fullPage: true });
  await stop.click();
  await expect(page.getByRole('status')).toContainText('回复未完成');
  await expect(page.getByRole('status')).toContainText('已停止接收回复');
  await expect(page.getByText(AGENT_PARTIAL, { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('');
  await expect(stop).toHaveCount(0);
  await expect.poll(async () => (await observedCalls()).map((call: { disconnected: boolean }) => call.disconnected), { message: 'Real provider socket is cancelled, not merely hidden by the UI' }).toEqual([true]);
  await expect.poll(async () => (await history()).map((message: { sender_type: string; response_state?: string }) => [message.sender_type, message.response_state || null])).toEqual([['user', null], ['agent', 'incomplete']]);
  await page.screenshot({ path: info.outputPath('agent-stopped-partial.png'), fullPage: true });

  await input.fill('AGENT-E2E-CONTINUE 这是新的明确请求');
  await input.press('Enter');
  await expect(page.getByText(AGENT_COMPLETE, { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(stop).toHaveCount(0);
  const messages = await history();
  expect(messages.map((message: { sender_type: string }) => message.sender_type)).toEqual(['user', 'agent', 'user', 'agent']);
  expect(messages[1].content).toBe(`${AGENT_PARTIAL}\n\n[生成已停止]`);
  expect(messages[1].response_state).toBe('incomplete');
  expect(messages[3].content).toBe(AGENT_COMPLETE);
  expect(messages[3].response_state).toBeUndefined();
  const calls = await observedCalls();
  expect(calls).toHaveLength(2); expect(calls[0].disconnected).toBe(true); expect(calls[1].completed).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.screenshot({ path: info.outputPath('agent-new-message-complete.png'), fullPage: true });
  await info.attach('agent-stop-boundary.json', { body: JSON.stringify({ testedRevision: process.env.GITHUB_SHA || 'local-candidate', project: info.project.name, browser: context.browser()?.version(), calls, persistedMessages: messages, boundary: 'Real browser controls, auth, Agent API, persistence, and HTTP cancellation against a deterministic keyless loopback provider; no live model quality or billing claim' }, null, 2), contentType: 'application/json' });
});
