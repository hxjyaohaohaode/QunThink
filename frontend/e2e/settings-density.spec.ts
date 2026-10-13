import { test, expect } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });

test('settings reveal model configuration on demand and retain advanced drafts across navigation', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  await expect(page.getByTestId('workspace')).toBeVisible();
  await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  const mobile = page.viewportSize()!.width < 768;
  const settings = mobile ? page.locator('.settings-page-enter') : page.getByRole('dialog', { name: '设置', exact: true });
  await expect(settings.getByRole('region', { name: '模型中心', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: /^模型中心/ }).click();
  const center = settings.getByRole('region', { name: '模型中心', exact: true });
  await center.getByRole('button', { name: '＋ 服务商', exact: true }).click();
  await center.getByLabel('服务商名称', { exact: true }).fill('设置页草稿');
  await center.getByRole('button', { name: '＋ 手动添加模型', exact: true }).click();
  await center.getByLabel('模型 ID', { exact: true }).fill('draft-only-model');
  await expect(center.getByLabel('输出上限（tokens）', { exact: true })).not.toBeVisible();
  await center.locator('summary').filter({ hasText: '高级模型参数' }).click();
  await center.getByLabel('输出上限（tokens）', { exact: true }).fill('2048');
  await center.locator('summary').filter({ hasText: '高级模型参数' }).click();
  if (mobile) await settings.getByRole('button', { name: '返回设置', exact: true }).click();
  else await settings.getByRole('button', { name: '外观', exact: true }).click();
  await expect(settings.getByRole('region', { name: '模型中心', exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: /^模型中心/ }).click();
  await expect(center.getByLabel('服务商名称', { exact: true })).toHaveValue('设置页草稿');
  await center.locator('fieldset > div > details > summary').click();
  await center.locator('summary').filter({ hasText: '高级模型参数' }).click();
  await expect(center.getByLabel('输出上限（tokens）', { exact: true })).toHaveValue('2048');
  await expect(center.getByText('草稿尚未保存；刷新或退出账号会清除。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('settings-model-draft.png'), fullPage: true, animations: 'disabled' });
  await center.getByRole('button', { name: '放弃修改', exact: true }).click();
  await expect(center.getByLabel('服务商名称', { exact: true })).toHaveCount(0);
});
