import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID, randomInt } from 'node:crypto';

async function register(context: BrowserContext, phone?: string) {
  const csrf = await (await context.request.get('/api/csrf-token')).json();
  const response = await context.request.post('/api/auth/register', {
    headers: { 'x-csrf-token': csrf.csrfToken },
    data: { username: `qa_${randomUUID().replaceAll('-', '')}`, password: 'Synthetic-Browser-Only-2026', nickname: '体验测试', ...(phone ? { phone } : {}) },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}
async function openWorkspace(page: Page, context: BrowserContext) {
  await register(context); await page.goto('/');
  const workspace = page.getByTestId('workspace');
  await expect(workspace).toBeVisible();
  // Only the active responsive tree may mount, avoiding duplicate polls/forms/IDs.
  await expect(workspace).toHaveCount(1);
  return workspace;
}

test('brand login entry remains visible before authentication', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByText('群想', { exact: true }).first()).toBeVisible();
  await expect(page.getByPlaceholder('请输入手机号')).toBeVisible();
  await page.screenshot({ path: info.outputPath('brand-login.png'), fullPage: true });
});

test('real API saves once, preserves draft across views, and restores saved task after reload', async ({ page, context }, info) => {
  const workspace = await openWorkspace(page, context);
  await expect(workspace.getByText('连接你的第一个 AI')).toBeVisible();
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('中文跨页草稿测试');
  await workspace.getByLabel('希望得到什么').fill('保留这段内容，检查保存结果和来源。');
  await workspace.getByRole('button', { name: '模型中心', exact: true }).click();
  await workspace.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(workspace.getByLabel('任务名称', { exact: true })).toHaveValue('中文跨页草稿测试');
  await expect(workspace.getByLabel('希望得到什么')).toHaveValue('保留这段内容，检查保存结果和来源。');
  await page.screenshot({ path: info.outputPath('task-composer.png'), fullPage: true });
  await workspace.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  const tasks = await (await context.request.get('/api/tasks')).json();
  expect(tasks.filter((task: { title: string }) => task.title === '中文跨页草稿测试')).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('workspace').getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('workspace-saved-task.png'), fullPage: true });
  await page.getByLabel('搜索任务').fill('没有任何匹配的内容');
  await expect(page.getByText('没有符合条件的任务')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
});

test('lost save acknowledgment is same-key replay with one persisted task', async ({ page, context }) => {
  const workspace = await openWorkspace(page, context);
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('断网核验任务');
  await workspace.getByLabel('希望得到什么').fill('只应创建一次');
  const keys: string[] = []; let intercepted = false;
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (!intercepted) { intercepted = true; await route.fetch(); await route.abort('connectionreset'); }
    else await route.continue();
  });
  await workspace.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(workspace.getByRole('button', { name: '核验并重试保存', exact: true })).toBeVisible();
  await expect(workspace.locator('fieldset')).toBeDisabled();
  await workspace.getByRole('button', { name: '核验并重试保存', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: '断网核验任务', exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  const tasks = await (await context.request.get('/api/tasks')).json();
  expect(tasks.filter((task: { title: string }) => task.title === '断网核验任务')).toHaveLength(1);
});

test('local diagnostics never include input or upload runtime reports', async ({ page, context }, info) => {
  const uploads: string[] = []; page.on('request', request => { if (request.url().includes('/monitoring/errors')) uploads.push(request.url()); });
  const workspace = await openWorkspace(page, context);
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('Private-QA-Canary-39208');
  await workspace.getByRole('button', { name: '运行记录', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: '运行记录', exact: true })).toBeVisible();
  await expect(workspace.getByRole('list', { name: '本地运行记录' })).not.toContainText('Private-QA-Canary-39208');
  expect(uploads).toEqual([]);
  await page.screenshot({ path: info.outputPath('local-diagnostics.png'), fullPage: true });
  await workspace.getByRole('checkbox', { name: '本标签页记录诊断' }).uncheck();
  await expect(workspace.getByText('暂无记录。开启后，接下来的操作会显示在这里。')).toBeVisible();
});

test('cross-origin preflight allows explicit task intent and account guard headers', async ({ request }) => {
  const response = await request.fetch('http://127.0.0.1:3202/api/tasks', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3210', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'idempotency-key,x-expected-user-id' } });
  expect(response.headers()['access-control-allow-headers'].toLowerCase()).toContain('idempotency-key');
  expect(response.headers()['access-control-allow-headers'].toLowerCase()).toContain('x-expected-user-id');
});

test('expired cached account can explicitly log into a different account without changing branding', async ({ page, context }) => {
  const alice = await register(context);
  const phone = `138${String(randomInt(10000000,99999999))}`;
  const bob = await register(context, phone);
  await context.clearCookies();
  await page.addInitScript(userId => localStorage.setItem('app_current_user_id', userId), alice.id);
  await page.goto('/');
  await expect(page.getByPlaceholder('请输入手机号')).toBeVisible();
  await page.getByPlaceholder('请输入手机号').fill(phone);
  await page.getByPlaceholder('请输入密码', {exact:true}).fill('Synthetic-Browser-Only-2026');
  const bootstraps: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) bootstraps.push(request.headers()['x-expected-user-id']); });
  await page.locator('form').getByRole('button', {name:'登录',exact:true}).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
  expect(bootstraps).toContain(bob.id);
});

test('another-tab login fences polling and does not log out the new account', async ({ page, context }) => {
  const workspace = await openWorkspace(page, context);
  const bob = await register(context);
  await workspace.getByRole('button', {name:'刷新',exact:true}).click();
  await expect(page.getByTestId('workspace')).toHaveCount(0);
  await expect(page.getByPlaceholder('请输入手机号')).toBeVisible();
  const session = await (await context.request.get('/api/auth/token')).json();
  expect(session.valid).toBe(true);
  const me = await (await context.request.get('/api/auth/me')).json();
  expect(me.user.id).toBe(bob.id);
});
