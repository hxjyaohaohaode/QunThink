import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

// UI-only API fixtures. They never contact or claim to verify a real provider.
// Backend tests separately verify safe transport and the domestic allowlist.
const status = { available: true, providerOrigin: 'https://api.deepseek.com', model: 'deepseek-fixture', consentToken: 'synthetic-consent' };
test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });
async function openModels(page: Page, context: BrowserContext, available = true) {
  await page.route('**/api/site-ai/status', route => route.fulfill({ json: available ? status : { available: false } }));
  await registerSyntheticAccount(context);
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  const workspace = page.getByTestId('workspace'); await expect(workspace).toHaveCount(1);
  await workspace.getByRole('button', { name: '模型中心', exact: true }).click();
  const panel = page.locator('details').filter({ has: page.getByText('站点基础 AI（单轮聊天）', { exact: true }) });
  await expect(panel).toBeVisible();
  return panel;
}
test('site basic AI is an explicit single-turn choice and never populates BYOK', async ({ page, context }, info) => {
  const calls: Record<string, unknown>[] = []; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/site-ai/chat', async route => { calls.push(route.request().postDataJSON()); await gate; await route.fulfill({ json: { content: '测试夹具回复，并非真实模型输出', generatedByAI: true, providerOrigin: status.providerOrigin, model: status.model } }); });
  const panel = await openModels(page, context);
  await expect(panel).not.toHaveAttribute('open');
  await panel.locator('summary').click();
  await expect(panel).toContainText(status.providerOrigin);
  const send = panel.getByRole('button', { name: '发送给站点基础 AI', exact: true });
  await panel.getByLabel('站点基础 AI 输入').fill('本次测试文本'); await expect(send).toBeDisabled();
  await panel.getByRole('checkbox').check(); await send.click();
  await expect(panel.getByRole('button', { name: '正在生成…', exact: true })).toBeDisabled();
  await expect.poll(() => calls.length).toBe(1); expect(calls[0]).toEqual({ prompt: '本次测试文本', consent: true, consentToken: status.consentToken });
  release(); await expect(panel).toContainText('AI 生成'); await expect(panel).toContainText('测试夹具回复');
  await expect(panel.getByRole('checkbox')).not.toBeChecked(); await expect(send).toBeDisabled();
  const catalog = await (await context.request.get('/api/user/model-catalog')).json();
  expect(catalog.providers).toEqual([]); expect(catalog.models).toEqual([]);
  const screenshot = info.outputPath('site-basic-ai-explicit-choice.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach('site-basic-ai-ui-fixture', { path: screenshot, contentType: 'image/png' });
  await info.attach('site-basic-ai-fixture-provenance', { body: JSON.stringify({
    scope: 'Native UI test with intercepted site API; no real provider request',
    project: info.project.name, url: page.url(), viewport: page.viewportSize(),
    providerOrigin: status.providerOrigin, model: status.model, calls: calls.length,
    userData: 'synthetic account and synthetic single-turn text only'
  }, null, 2), contentType: 'application/json' });
});
test('site AI failure retains input without automatic retry', async ({ page, context }) => {
  let calls = 0;
  await page.route('**/api/site-ai/chat', route => { calls++; return route.fulfill({ status: 502, json: { error: 'synthetic provider failure' } }); });
  const panel = await openModels(page, context); await panel.locator('summary').click();
  await panel.getByLabel('站点基础 AI 输入').fill('保留这次输入'); await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '发送给站点基础 AI', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('不会自动重试');
  await expect(panel.getByLabel('站点基础 AI 输入')).toHaveValue('保留这次输入');
  await expect(panel.getByRole('checkbox')).not.toBeChecked(); expect(calls).toBe(1);
});
test('unconfigured site AI does not block ordinary model setup', async ({ page, context }) => {
  const panel = await openModels(page, context, false); await panel.locator('summary').click();
  await expect(panel).toContainText('站点基础 AI 未启用或暂不可用');
  await expect(panel.getByLabel('站点基础 AI 输入')).toHaveCount(0);
  await page.getByRole('button', { name: '＋ 服务商', exact: true }).click();
  await expect(page.getByLabel('服务商名称', { exact: true })).toBeVisible();
});
