import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

test.beforeEach(async ({ page }, info) => {
  // The real 55-message fixture respects the server's write limiter. Establish
  // this budget before recovery captures it; never reset recovery after a wait.
  test.setTimeout(info.title.startsWith('real search') ? 180000 : 90000);
  beginSessionTokenRecovery(page, info);
});

async function capture(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: name + ': no horizontal page overflow' }).toBe(true);
  await page.screenshot({ path: info.outputPath(name + '.png'), fullPage: true, animations: 'disabled' });
}
async function search(page: Page) {
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog', { name: '命令面板' }).getByRole('option', { name: /全局搜索/ }).click();
  await expect(page.getByRole('dialog', { name: '全局搜索' })).toBeVisible();
}

for (const width of [320, 390, 768, 1440]) {
  test(`all primary surfaces align at ${width}px`, async ({ page, context }, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'The matrix sets its own viewport; the separate search flow covers mobile touch.');
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: width < 768 ? 844 : 1000 });
    await registerSyntheticAccount(context);
    await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
    const workspace = page.getByTestId('workspace'); await expect(workspace).toBeVisible();
    for (const name of ['工作台', '个人目标', '记忆记录', '模型中心', '运行记录']) {
      await workspace.getByRole('button', { name, exact: true }).click();
      await capture(page, info, `${width}-${name}`);
    }
    await workspace.getByRole('button', { name: '工作台', exact: true }).click();
    await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
    await workspace.getByLabel('任务名称', { exact: true }).fill('很长的任务名称用于检查中文与 English 123 的排版边界');
    await workspace.getByLabel('希望得到什么').fill('完整目标与背景。\n第二段保持换行和可读性。');
    await capture(page, info, `${width}-任务编辑`);
    await page.getByRole('button', { name: '智能体', exact: true }).click();
    await expect(page.getByTestId('agent-directory')).toBeVisible();
    await capture(page, info, `${width}-智能体`);
    await page.getByRole('button', { name: '添加智能体', exact: true }).click();
    const create = page.getByRole('dialog'); await expect(create).toBeVisible();
    await capture(page, info, `${width}-智能体弹窗`);
    await page.getByRole('button', { name: '关闭创建智能体', exact: true }).click();
    if (width < 768) {
      await page.getByTestId('mobile-navigation').getByRole('button', { name: '设置', exact: true }).click();
      await expect(page.locator('.settings-page-enter')).toHaveCSS('opacity', '1');
      await capture(page, info, `${width}-设置`);
      await page.getByRole('button', { name: /编辑个人资料/ }).click();
    } else {
      await page.getByTitle('设置', { exact: true }).click();
      await capture(page, info, `${width}-设置`);
      const settings = page.getByRole('dialog', { name: '设置', exact: true });
      await settings.getByRole('button', { name: '外观', exact: true }).click();
      await capture(page, info, `${width}-外观`);
      await page.keyboard.press('Escape');
      await page.getByTitle('个人资料', { exact: true }).click();
    }
    await expect(page.getByRole('dialog', { name: '编辑个人资料', exact: true })).toBeVisible();
    await capture(page, info, `${width}-个人资料`);
    await page.keyboard.press('Escape');
    await search(page);
    await page.getByLabel('搜索关键词', { exact: true }).fill('没有匹配的完整关键词');
    await expect(page.getByRole('dialog', { name: '全局搜索' }).getByText(/没有找到/).first()).toBeVisible();
    await capture(page, info, `${width}-搜索`);
    const box = await page.getByRole('dialog', { name: '全局搜索' }).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.getByRole('dialog', { name: '全局搜索' }).getByRole('button', { name: '日期', exact: true }).click();
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-13');
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-12');
    await expect(page.getByText('开始日期不能晚于结束日期')).toBeVisible();
    for (const label of ['开始日期', '结束日期']) {
      const input = await page.getByLabel(label, { exact: true }).boundingBox();
      expect(input!.x).toBeGreaterThanOrEqual(box!.x);
      expect(input!.x + input!.width).toBeLessThanOrEqual(box!.x + box!.width);
    }
    await capture(page, info, `${width}-日期边界`);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await capture(page, info, `${width}-深色搜索`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await capture(page, info, `${width}-命令面板`);
    await page.getByLabel('命令搜索').fill('zzzz'); await page.keyboard.press('ArrowDown');
    await expect(page.getByText('没有匹配的命令')).toBeVisible();
  });
}

test('real search paginates, retries and opens a message older than the initial history window', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  const csrf = (await (await context.request.get('/api/csrf-token')).json()).csrfToken;
  const headers = { 'x-csrf-token': csrf };
  const response = await context.request.post('/api/groups', { headers, data: { name: '分页定位验收', ai_members: [] } });
  expect(response.status()).toBe(201); const group = await response.json();
  const ids: string[] = [];
  for (let index = 0; index < 55; index++) {
    const data = { content: '定位标记 ' + String(index).padStart(2, '0'), clientMessageId: crypto.randomUUID() };
    let sent = await context.request.post(`/api/groups/${group.id}/messages`, { headers, data });
    if (sent.status() === 429) {
      const seconds = Number(sent.headers()['retry-after']);
      expect(Number.isInteger(seconds) && seconds > 0 && seconds <= 60).toBe(true);
      test.setTimeout(info.timeout + seconds * 1000 + 2000);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000 + 150));
      sent = await context.request.post(`/api/groups/${group.id}/messages`, { headers, data });
    }
    expect(sent.status()).toBe(201); ids.push((await sent.json()).id);
  }
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  await expect(page.getByTestId('workspace')).toBeVisible(); await search(page);
  const dialog = page.getByRole('dialog', { name: '全局搜索' });
  await page.getByLabel('搜索关键词', { exact: true }).fill('定位标记');
  await expect(dialog.getByRole('button', { name: '消息 (55)', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '消息 (55)', exact: true }).click();
  await expect(dialog.getByText('定位标记 54', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(dialog.getByText('定位标记 34', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(dialog.getByText('定位标记 00', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await capture(page, info, 'search-last-page');
  await dialog.getByText('定位标记 00', { exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(`[data-message-id="${ids[0]}"]`).first()).toBeInViewport({ timeout: 15000 });
  await capture(page, info, 'search-old-message-target');
  await search(page);
  let failedReads = 0;
  await page.route('**/api/search?**', route => {
    failedReads++;
    return route.fulfill({ status: 503, json: { error: 'Synthetic search outage' } });
  });
  await page.getByLabel('搜索关键词', { exact: true }).fill('失败后重试');
  // The shared read client first performs its bounded 1s + 2s + 4s retries.
  await expect(dialog.getByRole('button', { name: '重试搜索', exact: true })).toBeVisible({ timeout: 15000 });
  expect(failedReads).toBe(4);
  await page.unroute('**/api/search?**');
  await dialog.getByRole('button', { name: '重试搜索', exact: true }).click();
  await expect(dialog.getByText(/没有找到/).first()).toBeVisible();
});
