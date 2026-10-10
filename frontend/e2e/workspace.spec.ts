import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { registerSyntheticAccount } from './authFixture';
import { submitAuthWithSingleRateLimitRetry } from '../scripts/auth-submit-retry.mjs';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';

test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });

async function register(context: BrowserContext, phone?: string) {
  return registerSyntheticAccount(context, { phone });
}
async function openWorkspace(page: Page, context: BrowserContext) {
  await register(context); await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }));
  const workspace = page.getByTestId('workspace');
  await expect(workspace).toBeVisible();
  // Only the active responsive tree may mount, avoiding duplicate polls/forms/IDs.
  await expect(workspace).toHaveCount(1);
  return workspace;
}

test('brand login entry remains visible before authentication', async ({ page }, info) => {
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }), page.getByPlaceholder('请输入手机号'));
  await expect(page.getByText('群想', { exact: true }).first()).toBeVisible();
  await expect(page.getByPlaceholder('请输入手机号')).toBeVisible();
  await page.screenshot({ path: info.outputPath('brand-login.png'), fullPage: true, animations: 'disabled' });
});

test('fresh accounts have no platform AI and model setup remains an explicit choice', async ({ page, context }, info) => {
  const workspace = await openWorkspace(page, context);
  const probes: string[] = [];
  page.on('request', request => { if (request.url().includes('/model-catalog/test')) probes.push(request.url()); });
  const catalog = await (await context.request.get('/api/user/model-catalog')).json();
  expect(catalog.providers).toEqual([]);
  expect(catalog.models).toEqual([]);
  expect(catalog.defaults).toEqual({ chat: null, vision: null, tts: null });
  const personas = await (await context.request.get('/api/personas')).json();
  expect(personas.personas).toEqual({});
  const groups = await (await context.request.get('/api/groups')).json();
  expect(groups.every((group: { ai_members: string[] }) => group.ai_members.length === 0)).toBe(true);
  await workspace.getByRole('button', { name: '模型中心', exact: true }).click();
  const models = page.getByRole('region', { name: '模型中心', exact: true });
  await expect(models.getByRole('button', { name: '＋ 服务商', exact: true })).toBeVisible();
  await expect(models.getByLabel('服务商名称', { exact: true })).toHaveCount(0);
  await expect(models.getByRole('button', { name: '保存并应用', exact: true })).toBeDisabled();
  await expect(models).toBeVisible();
  const modelTab = workspace.getByRole('button', { name: '模型中心', exact: true });
  await expect(modelTab).toHaveAttribute('aria-current', 'page');
  let previousIndicator: { left: number; width: number; aligned: boolean } | undefined;
  await expect.poll(async () => {
    const observed = await modelTab.evaluate(tab => {
      const indicator = tab.querySelector('.workspace-tab-indicator');
      if (!indicator) return { left: 0, width: 0, aligned: false };
      const outer = tab.getBoundingClientRect(), inner = indicator.getBoundingClientRect();
      const aligned = tab.getAttribute('aria-current') === 'page' && inner.width > 0 && inner.height > 0 &&
        inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom + 0.5 &&
        Math.abs((inner.left + inner.right - outer.left - outer.right) / 2) <= 0.5;
      return { left: inner.left, width: inner.width, aligned };
    });
    const settled = observed.aligned && previousIndicator?.aligned === true &&
      Math.abs(observed.left - previousIndicator.left) <= 0.25 && Math.abs(observed.width - previousIndicator.width) <= 0.25;
    previousIndicator = observed;
    return settled;
  }, { message: 'The real active Model Center underline must settle inside its own tab before the evidence screenshot' }).toBe(true);
  await page.screenshot({ path: info.outputPath('byok-empty-model-center.png'), fullPage: true, animations: 'disabled' });
  await navigateWithSessionTokenRecovery(page, timeout => page.reload({ timeout }));
  await expect(page.getByTestId('workspace')).toBeVisible();
  expect((await (await context.request.get('/api/user/model-catalog')).json()).models).toEqual([]);
  expect(probes).toEqual([]);
});

test('real API saves once, preserves draft across views, and restores saved task after reload', async ({ page, context }, info) => {
  const workspace = await openWorkspace(page, context);
  await expect(workspace.getByText('先写作，再选择 AI 助手')).toBeVisible();
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('中文跨页草稿测试');
  await workspace.getByLabel('希望得到什么').fill('保留这段内容，检查保存结果和来源。');
  await workspace.getByRole('button', { name: '模型中心', exact: true }).click();
  await workspace.getByRole('button', { name: '工作台', exact: true }).click();
  await expect(workspace.getByLabel('任务名称', { exact: true })).toHaveValue('中文跨页草稿测试');
  await expect(workspace.getByLabel('希望得到什么')).toHaveValue('保留这段内容，检查保存结果和来源。');
  await page.screenshot({ path: info.outputPath('task-composer.png'), fullPage: true, animations: 'disabled' });
  await workspace.getByRole('button', { name: '保存任务', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  const tasks = await (await context.request.get('/api/tasks')).json();
  expect(tasks.filter((task: { title: string }) => task.title === '中文跨页草稿测试')).toHaveLength(1);
  await navigateWithSessionTokenRecovery(page, timeout => page.reload({ timeout }));
  await expect(page.getByTestId('workspace').getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('workspace-saved-task.png'), fullPage: true, animations: 'disabled' });
  await page.getByLabel('搜索任务').fill('没有任何匹配的内容');
  await expect(page.getByText('没有符合条件的任务')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByRole('heading', { name: '中文跨页草稿测试', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);
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
  await page.screenshot({ path: info.outputPath('local-diagnostics.png'), fullPage: true, animations: 'disabled' });
  await workspace.getByRole('checkbox', { name: '本标签页记录诊断' }).uncheck();
  await expect(workspace.getByText('暂无记录。开启后，接下来的操作会显示在这里。')).toBeVisible();
});

test('cross-origin preflight allows explicit task intent and account guard headers', async ({ request }) => {
  const response = await request.fetch('http://127.0.0.1:3202/api/tasks', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:3210', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'idempotency-key,x-expected-user-id' } });
  expect(response.headers()['access-control-allow-headers'].toLowerCase()).toContain('idempotency-key');
  expect(response.headers()['access-control-allow-headers'].toLowerCase()).toContain('x-expected-user-id');
});

test('expired cached account can explicitly log into a different account without changing branding', async ({ page, context }, info) => {
  const deadline = Date.now() + info.timeout;
  const alice = await register(context);
  const phone = `138${String(randomInt(10000000,99999999))}`;
  const bob = await register(context, phone);
  await context.clearCookies();
  await page.addInitScript(userId => localStorage.setItem('app_current_user_id', userId), alice.id);
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout }), page.getByPlaceholder('请输入手机号'));
  await expect(page.getByPlaceholder('请输入手机号')).toBeVisible();
  await page.getByPlaceholder('请输入手机号').fill(phone);
  await page.getByPlaceholder('请输入密码', {exact:true}).fill('Synthetic-Browser-Only-2026');
  const bootstraps: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/bootstrap')) bootstraps.push(request.headers()['x-expected-user-id']); });
  const login = page.locator('form').getByRole('button', {name:'登录',exact:true});
  const response = await submitAuthWithSingleRateLimitRetry(async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).origin === new URL(page.url()).origin &&
        new URL(response.url()).pathname === '/api/auth/login-phone' && response.request().method() === 'POST'),
      login.click(),
    ]);
    return response;
  }, {
    remainingBudgetMs: () => deadline - Date.now(),
    onRateLimited: async response => {
      // A known pre-admission rejection is recoverable through another visible
      // login action. Never retry an uncertain network result or bypass limits.
      await expect(page.getByText('请求过于频繁', { exact: true }).first()).toBeVisible();
      await expect(login).toBeEnabled();
      await expect(page.getByPlaceholder('请输入手机号')).toHaveValue(phone);
      await expect(page.getByPlaceholder('请输入密码', {exact:true})).toHaveValue('Synthetic-Browser-Only-2026');
      await info.attach('login-rate-limit.json', { body: JSON.stringify({ status: response.status(), retryAfter: response.headers()['retry-after'], remainingBudgetMs: deadline - Date.now() }), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('login-rate-limited-before-retry.png'), fullPage: true });
    },
  });
  expect(response.status()).toBe(200);
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

test('model configuration preserves drafts and real revision conflicts; profile editing is reversible and saves once', async ({ page, context }, info) => {
  const workspace = await openWorkspace(page, context);
  const probes: string[] = [];
  page.on('request', request => { if (request.url().includes('/model-catalog/test')) probes.push(request.url()); });
  await workspace.getByRole('button', {name:'模型中心',exact:true}).click();
  const models = page.getByRole('region', {name:'模型中心',exact:true});
  await models.getByRole('button', {name:'＋ 服务商',exact:true}).click();
  await models.getByLabel('服务商名称', {exact:true}).fill('独立测试连接');
  await models.getByLabel('服务地址（Base URL）', {exact:true}).fill('https://api.openai.com/v1');
  await models.getByRole('button', {name:'＋ 手动添加模型',exact:true}).click();
  await models.getByLabel('显示名称', {exact:true}).fill('未接入的测试模型');
  await models.getByLabel('模型 ID', {exact:true}).fill('synthetic-browser-model');
  await workspace.getByRole('button', {name:'工作台',exact:true}).click();
  await workspace.getByRole('button', {name:'模型中心',exact:true}).click();
  await expect(models.getByLabel('服务商名称',{exact:true})).toHaveValue('独立测试连接');
  await models.getByRole('button',{name:'保存并应用',exact:true}).click();
  await expect(models.getByText('当前配置已保存',{exact:true})).toBeVisible();
  await models.locator('summary').filter({hasText:'未接入的测试模型'}).click();
  await expect(models.getByRole('button',{name:'测试对话',exact:true}).last()).toBeDisabled();
  const original = await (await context.request.get('/api/user/model-catalog')).json();
  const connection = original.providers.find((provider: {name:string}) => provider.name === '独立测试连接');
  expect(connection).toBeTruthy();
  await models.getByLabel('服务商名称',{exact:true}).fill('冲突后保留我的修改');
  const csrf = await (await context.request.get('/api/csrf-token')).json();
  const remote = {...original, providers: original.providers.map((provider: {id:string}) => provider.id === connection.id ? {...provider,name:'另一窗口修改'} : provider)};
  const update = await context.request.put('/api/user/model-catalog', {headers:{'x-csrf-token':csrf.csrfToken},data:remote});
  expect(update.status()).toBe(200);
  await models.getByRole('button',{name:'保存并应用',exact:true}).click();
  await expect(models.getByRole('button',{name:'合并最新配置，保留我的修改',exact:true})).toBeVisible();
  await expect(models.getByLabel('服务商名称',{exact:true})).toHaveValue('冲突后保留我的修改');
  await models.getByRole('button',{name:'合并最新配置，保留我的修改',exact:true}).click();
  await models.getByRole('button',{name:'保存并应用',exact:true}).click();
  await expect(models.getByText('当前配置已保存',{exact:true})).toBeVisible();
  expect(probes).toEqual([]);
  await page.screenshot({path:info.outputPath('model-setup-recovered.png'),fullPage:true,animations:'disabled'});

  if (info.project.name === 'mobile-reduced-motion') {
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:/编辑个人资料/}).click();
  } else await page.getByTitle('个人资料',{exact:true}).click();
  const profile = page.getByRole('dialog',{name:'编辑个人资料',exact:true});
  await profile.getByLabel('昵称',{exact:true}).fill('保存前先确认');
  await page.screenshot({path:info.outputPath('profile-editing.png'),fullPage:true,animations:'disabled'});
  const geometry = await profile.evaluate(element => {
    const scroll = element.querySelector('[data-profile-scroll]')!.getBoundingClientRect();
    const actions = element.querySelector('[data-profile-actions]')!.getBoundingClientRect();
    const layer = element.closest('[data-profile-layer]');
    const bottomHit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 4);
    return { scrollBottom: scroll.bottom, actionsTop: actions.top, actionsBottom: actions.bottom,
      viewportHeight: window.innerHeight, onTop: Boolean(bottomHit?.closest('[data-profile-layer]')),
      bodyPortal: layer?.parentElement === document.body, opacity: Number(getComputedStyle(element).opacity) };
  });
  expect(geometry.scrollBottom).toBeLessThanOrEqual(geometry.actionsTop + 1);
  expect(geometry.actionsBottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(geometry.bodyPortal).toBe(true); expect(geometry.onTop).toBe(true); expect(geometry.opacity).toBe(1);
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog',{name:'放弃未保存的资料修改？',exact:true});
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(profile.getByLabel('昵称',{exact:true})).toHaveValue('保存前先确认');
  await expect(profile.getByLabel('昵称',{exact:true})).toBeFocused();
  let release!: () => void;
  const held = new Promise<void>(resolve => {release = resolve;});
  let saves=0;
  await page.route('**/api/profile', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    saves++; await held; await route.continue();
  });
  await profile.getByRole('button',{name:'保存',exact:true}).click();
  await expect(profile.getByLabel('昵称',{exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(profile).toBeVisible();
  release();
  await expect(profile).not.toBeVisible();
  expect(saves).toBe(1);
  const savedProfile = await (await context.request.get('/api/profile')).json();
  expect(savedProfile.profile.nickname).toBe('保存前先确认');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
  await page.screenshot({path:info.outputPath('profile-saved.png'),fullPage:true,animations:'disabled'});
});
