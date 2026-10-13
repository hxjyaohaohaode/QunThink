import { test, expect } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });

test('primary destinations stay separate and preserve drafts across chat, agents and responsive layouts', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  const headers = { 'x-csrf-token': (await (await context.request.get('/api/csrf-token')).json()).csrfToken };
  const response = await context.request.post('/api/groups', { headers, data: { name: '独立聊天导航验收', ai_members: [] } });
  expect(response.status()).toBe(201);
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  const workspace = page.getByTestId('workspace');
  await expect(workspace).toBeVisible();
  await expect(page.getByText('独立聊天导航验收', { exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('跨区保留的任务');
  await workspace.getByLabel('希望得到什么').fill('任务、聊天和智能体保持独立。');
  await expect(workspace.getByLabel('新任务优先级', { exact: true })).not.toBeVisible();
  await workspace.locator('summary').filter({ hasText: '更多设置' }).click();
  await workspace.getByLabel('新任务优先级', { exact: true }).selectOption('high');
  await workspace.locator('summary').filter({ hasText: '更多设置' }).click();

  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '聊天', exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await page.getByText('独立聊天导航验收', { exact: true }).first().click();
  await expect(page.getByPlaceholder('输入消息，@提及 AI 成员...', { exact: true })).toBeVisible();
  await expect(page.getByTestId('agent-directory')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '收起文稿，返回对话', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '打开会话文稿', exact: true }).click();
  await expect(page.getByRole('button', { name: '收起文稿，返回对话', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: /前往群聊页/ }).click();
  await expect(page.getByRole('button', { name: '收起文稿，返回对话', exact: true })).toHaveCount(0);

  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  await expect(navigation).toBeVisible();
  await navigation.getByRole('button', { name: '智能体', exact: true }).click();
  await expect(page.getByTestId('agent-directory')).toBeVisible();
  await expect(page.getByText('独立聊天导航验收', { exact: true })).toHaveCount(0);
  await navigation.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(workspace.getByLabel('任务名称', { exact: true })).toHaveValue('跨区保留的任务');
  await workspace.locator('summary').filter({ hasText: '更多设置' }).click();
  await expect(workspace.getByLabel('新任务优先级', { exact: true })).toHaveValue('high');

  const startingWidth = page.viewportSize()!.width;
  await navigation.getByRole('button', { name: '智能体', exact: true }).click();
  await page.setViewportSize({ width: startingWidth < 768 ? 1440 : 390, height: 1000 });
  await expect(page.getByTestId('agent-directory')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '智能体', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(workspace).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('primary-navigation-responsive.png'), fullPage: true, animations: 'disabled' });
});
