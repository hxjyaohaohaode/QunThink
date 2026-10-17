import { test, expect } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });

test('goal draft and uncertain save survive chat navigation without a duplicate operation', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  const writes: { body: unknown; key: string | undefined }[] = [];
  const outcome = '浏览器验收：整理本周资料';
  const goal = { id: 'fixture-goal', outcome, constraints: [], state: 'active', revision: 0,
    budget_limit_micros: '0', budget_reserved_micros: '0', budget_spent_micros: '0', created_at: '2026-10-18T00:00:00Z' };
  // The core suite intentionally has no goal database. These explicit response
  // fixtures exercise navigation and retry UX; PostgreSQL routes have separate tests.
  await page.route('**/api/goals', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { goals: writes.length ? [goal] : [], executionAvailable: false } }); return;
    }
    writes.push({ body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    await route.fulfill(writes.length === 1
      ? { status: 503, json: { error: 'Synthetic uncertain response' } }
      : { json: { goalId: goal.id, replayed: true, executionAvailable: false } });
  });
  await page.route('**/api/goals/fixture-goal', route => route.fulfill({ json: {
    goal, checks: [{ check_key: 'check-1', description: '资料完整可查', required: true }], runs: [], executionAvailable: false,
  } }));
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  const nav = page.getByRole('navigation', { name: '主导航', exact: true });
  const section = page.getByRole('region', { name: '个人目标', exact: true });
  await page.getByTestId('workspace').getByRole('button', { name: '个人目标', exact: true }).click();
  await section.getByRole('button', { name: '＋ 创建目标', exact: true }).click();
  await section.getByLabel('希望得到的可检查结果').fill(outcome);
  await section.getByLabel('验收条件').fill('资料完整可查');
  await nav.getByRole('button', { name: '聊天', exact: true }).click();
  await expect(section).toHaveCount(0);
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByTestId('workspace').getByRole('button', { name: '个人目标', exact: true }).click();
  await expect(section.getByLabel('希望得到的可检查结果')).toHaveValue(outcome);
  await section.getByRole('button', { name: '保存目标', exact: true }).click();
  await expect(section.getByText(/上次保存结果未确认/)).toBeVisible();
  await nav.getByRole('button', { name: '聊天', exact: true }).click();
  await nav.getByRole('button', { name: '工作台', exact: true }).click();
  await page.getByTestId('workspace').getByRole('button', { name: '个人目标', exact: true }).click();
  await expect(section.getByLabel('验收条件')).toHaveValue('资料完整可查');
  await section.getByRole('button', { name: '保存目标', exact: true }).click();
  await expect(section.getByText('已找到此前提交的同一目标；未重复创建。')).toBeVisible();
  await expect(section.getByRole('heading', { name: outcome, exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[0].key).toBeTruthy(); expect(writes[1]).toEqual(writes[0]);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(outcome);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('personal-goal-after-retry.png'), fullPage: true, animations: 'disabled' });
});
