import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionBootstrapRecovery as beginSessionTokenRecovery, navigateWithSessionBootstrapRecovery as navigateWithSessionTokenRecovery } from './sessionBootstrapRecovery';
import { assertLinuxBrowserSandbox, readSandboxDiagnostics, readVersionDiagnostics } from './sandboxDiagnostics';
import type { WorkspaceTask, UpdateTaskMetadataInput } from '../../shared/tasks';
import { createCommandReadGate, disposeCreateReadGate } from '../scripts/create-command-read-gate.mjs';
import { settleKnownMetadataQueue } from '../scripts/metadata-command-queue-recovery.mjs';
import { uiPhoneLogin, assertExpectedLoginUser } from './phoneLoginRecovery';

// Native-only suite. Do not relax host policy to execute it. The parent CI uses
// its installed stable Chrome; happyDOM tests are a separate, labelled suite.
test.use({ channel: 'chrome', launchOptions: { chromiumSandbox: true } });
test.setTimeout(120000);
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto('chrome://version'); const version = await page.evaluate(readVersionDiagnostics);
    await page.goto('chrome://sandbox'); const sandbox = await page.evaluate(readSandboxDiagnostics);
    console.log('[metadata-browser-observed]', JSON.stringify({ version: browser.version(), executable: version.executable, sandbox }));
    const verified = assertLinuxBrowserSandbox(version, sandbox);
    console.log('[metadata-browser-verified]', JSON.stringify({ version: browser.version(), chromiumSandbox: true, noSandboxFlag: false, ...verified }));
  } finally { await context.close(); }
});
test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); page.on('dialog', async dialog => { if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss(); }); });
async function headers(context: BrowserContext) { const csrf = await (await context.request.get('/api/csrf-token')).json(); return { 'x-csrf-token': csrf.csrfToken }; }
async function createTask(context: BrowserContext, title: string) {
  const response = await context.request.post('/api/tasks', { headers: { ...await headers(context), 'Idempotency-Key': randomUUID() }, data: { title, prompt: '仅合成本地验证，不调用模型。', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false } });
  expect(response.status()).toBe(201); return await response.json() as WorkspaceTask;
}
async function workspace(page: Page) { await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout })); await expect(page.getByTestId('workspace')).toBeVisible(); }
async function open(page: Page, title: string, id: string) {
  const card = page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await card.getByRole('button', { name: /打开详情|检查草稿/, exact: true }).click();
  const panel = page.locator(`[id="task-detail-${id}"]`).getByTestId('task-metadata'); await expect(panel).toBeVisible(); return panel;
}
async function readTask(context: BrowserContext, id: string) { const list = await (await context.request.get('/api/tasks')).json() as WorkspaceTask[]; return list.find(task => task.id === id); }
async function reload(page: Page) { await navigateWithSessionTokenRecovery(page, timeout => page.reload({ timeout })); }
async function storage(page: Page) { return page.evaluate(() => JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))); }

test('metadata committed lost ACK survives reload as IDs only and query recovers without replay', async ({ page, context }, info) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '设置丢ACK原任务'); await workspace(page); let panel = await open(page, task.title, task.id);
  let writes = 0, sent!: UpdateTaskMetadataInput;
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); writes++; sent = route.request().postDataJSON(); const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('connectionreset'); });
  await panel.getByLabel('设置任务名称', { exact: true }).fill('私密标题-丢失回执-414'); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled(); expect(writes).toBe(1); expect(await storage(page)).not.toContain('私密标题-丢失回执-414');
  await reload(page); panel = await open(page, '私密标题-丢失回执-414', task.id); await expect(panel.getByRole('button', { name: '按原设置同号重试', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '核验任务设置请求', exact: true }).click(); await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  const result = await (await context.request.get(`/api/tasks/${task.id}/metadata/commands/${sent.client_request_id}`)).json(); expect(result.receipt.committed_revision).toBe(1); expect(writes).toBe(1);
  await page.screenshot({ path: info.outputPath('metadata-lost-ack-recovered.png'), fullPage: true, animations: 'disabled' });
});

test('native opted-in IndexedDB AES recovery preserves exact three-field request across reload', async ({ page, context }) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '设置加密原任务'); await workspace(page); let panel = await open(page, task.title, task.id);
  const detail = page.locator(`[id="task-detail-${task.id}"]`); await detail.getByText('此设备的保存选择', { exact: true }).click(); await detail.getByRole('checkbox', { name: '加密恢复未提交草稿', exact: true }).check();
  const sent: UpdateTaskMetadataInput[] = [];
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); sent.push(route.request().postDataJSON()); if (sent.length === 1) return route.abort('connectionreset'); await route.continue(); });
  await panel.getByLabel('设置任务名称', { exact: true }).fill('私密原设置-三字段-565'); await panel.getByLabel('设置下次生成时间', { exact: true }).fill('2030-02-03T04:05'); await panel.getByRole('checkbox', { name: '启用定时生成', exact: true }).check(); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled(); expect(await storage(page)).not.toContain('私密原设置-三字段-565'); expect(await storage(page)).not.toContain('2030-02-03');
  await reload(page); panel = await open(page, task.title, task.id); await expect(panel.getByRole('button', { name: '按原设置同号重试', exact: true })).toBeEnabled(); await panel.getByRole('button', { name: '按原设置同号重试', exact: true }).click(); await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(await readTask(context, task.id)).toMatchObject({ metadata_revision: 1, title: '私密原设置-三字段-565', auto_run: true });
});

// Pause only the first real SHA-256 completion, after both UI handlers already
// read the empty journal. This deterministically exercises the two-tab race;
// it neither fakes the command response nor bypasses the backend revision gate.
async function gateNextHash(page: Page) {
  await page.evaluate(() => {
    const original = crypto.subtle.digest.bind(crypto.subtle); let first = true;
    Object.defineProperty(crypto.subtle, 'digest', { configurable: true, value: async (...args: Parameters<SubtleCrypto['digest']>) => { const result = await original(...args); if (first) { first = false; await new Promise<void>(resolve => { (window as unknown as { releaseMetadataHash: () => void }).releaseMetadataHash = resolve; }); } return result; } });
  });
}
async function releaseHash(page: Page) { await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseMetadataHash?: unknown }).releaseMetadataHash)).toBe('function'); await page.evaluate(() => (window as unknown as { releaseMetadataHash: () => void }).releaseMetadataHash()); }

test('two real tabs preserve both requests, reject delayed stale PUT and require close then deliberate reedit', async ({ page, context }, info) => {
  const owner = await registerSyntheticAccount(context); const task = await createTask(context, '设置双标签原任务'); await workspace(page); const first = await open(page, task.title, task.id);
  const secondPage = await context.newPage(); beginSessionTokenRecovery(secondPage, info); await workspace(secondPage); const second = await open(secondPage, task.title, task.id);
  await first.getByLabel('设置任务名称', { exact: true }).fill('较早的标签草稿'); await second.getByLabel('设置任务名称', { exact: true }).fill('较新的标签设置');
  await gateNextHash(page); await gateNextHash(secondPage);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let firstSent!: UpdateTaskMetadataInput, secondSent!: UpdateTaskMetadataInput;
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); firstSent ??= route.request().postDataJSON(); await gate; await route.continue(); });
  await secondPage.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); secondSent = route.request().postDataJSON(); await route.continue(); });
  await Promise.all([first.getByRole('button', { name: '保存任务设置', exact: true }).click(), second.getByRole('button', { name: '保存任务设置', exact: true }).click()]);
  await Promise.all([releaseHash(page), releaseHash(secondPage)]); await expect.poll(() => !!firstSent && !!secondSent).toBe(true);
  await expect.poll(async () => (await readTask(context, task.id))?.title).toBe('较新的标签设置'); expect(firstSent.client_request_id).not.toBe(secondSent.client_request_id);
  expect(firstSent.expected_revision).toBe(0); expect(secondSent.expected_revision).toBe(0);
  const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${task.id}/metadata` && response.request().method() === 'PUT' && response.request().postDataJSON().client_request_id === firstSent.client_request_id);
  release(); const rejected = await staleResponse; expect(rejected.status()).toBe(409); expect(await rejected.json()).toMatchObject({ success: false, code: 'TASK_METADATA_REVISION_CONFLICT' });
  const winner = await context.request.get(`/api/tasks/${task.id}/metadata/commands/${secondSent.client_request_id}`); expect(winner.status()).toBe(200); expect((await winner.json()).receipt).toMatchObject({ id: secondSent.client_request_id, task_id: task.id, operation: 'metadata', status: 'succeeded', committed_revision: 1 });
  expect((await readTask(context, task.id))?.metadata_revision).toBe(1);
  await expect(first.getByText(/任务设置已被修改/)).toBeVisible(); await expect(first.getByRole('button', { name: '核对并结束原设置请求', exact: true })).toBeEnabled();
  const verify = first.getByRole('button', { name: '核验任务设置请求', exact: true });
  const reedit = first.getByRole('button', { name: '读取最新设置并重新编辑', exact: true });
  const details = first.locator('details').filter({ has: page.getByText('原设置请求编号', { exact: true }) });
  const requestId = details.locator('p');
  async function readState() {
    if (await verify.isVisible()) return { kind: 'pending', id: (await requestId.textContent())?.trim() };
    return { kind: await reedit.isVisible() ? 'ready' : 'waiting' };
  }
  await settleKnownMetadataQueue({ winner: secondSent, loser: firstSent, ownerId: owner.id, taskId: task.id,
    observe: async () => {
      let state: { kind: string; id?: string } = { kind: 'waiting' };
      await expect.poll(async () => { state = await readState(); return state.kind; }).not.toBe('waiting');
      if (state.kind === 'pending') {
        if (await details.getAttribute('open') === null) await details.locator('summary').click();
        await expect(requestId).toBeVisible(); await expect(requestId).toHaveText(state.id!);
      }
      return state;
    },
    act: async ({ id, operation, path }: { id: string; operation: 'close' | 'verify'; path: string }) => {
      const method = operation === 'close' ? 'POST' : 'GET';
      const response = page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method);
      const exactPanel = first.filter({ has: page.getByText(id, { exact: true }) });
      await exactPanel.getByRole('button', { name: operation === 'close' ? '核对并结束原设置请求' : '核验任务设置请求', exact: true }).click();
      const result = await response, request = result.request();
      return { status: result.status(), method: request.method(), path: new URL(request.url()).pathname, ownerId: request.headers()['x-expected-user-id'], requestBody: operation === 'close' ? request.postDataJSON() : undefined, body: await result.json() };
    },
    waitForAdvance: async (id: string) => { await expect.poll(async () => { const state = await readState(); return state.kind === 'ready' || state.kind === 'pending' && state.id !== id; }).toBe(true); },
  });
  await expect(verify).toHaveCount(0); await expect(reedit).toBeEnabled();
  await reedit.click(); await expect(first.getByLabel('设置任务名称', { exact: true })).toHaveValue('较新的标签设置');
  expect((await readTask(context, task.id))?.metadata_revision).toBe(1);
  const newResponse = page.waitForResponse(value => new URL(value.url()).pathname === `/api/tasks/${task.id}/metadata` && value.request().method() === 'PUT');
  await first.getByLabel('设置任务名称', { exact: true }).fill('明确重编后的新设置');
  await first.getByRole('button', { name: '保存任务设置', exact: true }).click();
  const saved = await newResponse, newCommand = saved.request().postDataJSON() as UpdateTaskMetadataInput;
  expect(newCommand.client_request_id).not.toBe(firstSent.client_request_id); expect(newCommand.client_request_id).not.toBe(secondSent.client_request_id); expect(newCommand.expected_revision).toBe(1);
  expect(saved.status()).toBe(200); expect((await saved.json()).receipt).toMatchObject({ id: newCommand.client_request_id, task_id: task.id, status: 'succeeded', committed_revision: 2 });
  await expect(verify).toHaveCount(0); expect(await readTask(context, task.id)).toMatchObject({ title: '明确重编后的新设置', metadata_revision: 2 });
  await page.screenshot({ path: info.outputPath('metadata-two-tabs-conflict-closed.png'), fullPage: true, animations: 'disabled' }); await secondPage.close();
});

async function apiLogin(context: BrowserContext, phone: string, expectedUserId: string) { const response = await context.request.post('/api/auth/login-phone', { headers: await headers(context), data: { phone, password: 'Synthetic-Browser-Only-2026' } }); await assertExpectedLoginUser(response, expectedUserId); }

test('same live page A-B-A account transition fences delayed ACK and never exposes prior private title to B', async ({ page, context, browser }, info) => {
  const phoneA = '138' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), phoneB = '139' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const ownerA = await registerSyntheticAccount(context, { phone: phoneA }); const task = await createTask(context, '账号A设置原任务');
  const foreign = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' }); const ownerB = await registerSyntheticAccount(foreign, { phone: phoneB }); await createTask(foreign, '账号B自己的任务');
  await workspace(page); const panel = await open(page, task.title, task.id); const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let sent!: UpdateTaskMetadataInput, committed = false, fulfilled = false;
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); sent = route.request().postDataJSON(); const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await held; await route.fulfill({ response }); fulfilled = true; });
  await panel.getByLabel('设置任务名称', { exact: true }).fill('账号A私密冻结标题-991'); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click(); await expect.poll(() => committed).toBe(true);
  await apiLogin(context, phoneB, ownerB.id); await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByPlaceholder('请输入手机号', { exact: true })).toBeVisible(); await uiPhoneLogin(page, info, phoneB, ownerB.id);
  await expect(page.getByTestId('workspace')).toContainText('账号B自己的任务'); await expect(page.getByTestId('workspace')).not.toContainText('账号A私密冻结标题-991'); await expect(page.getByTestId('task-metadata')).toHaveCount(0);
  await apiLogin(context, phoneA, ownerA.id); await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByPlaceholder('请输入手机号', { exact: true })).toBeVisible(); await uiPhoneLogin(page, info, phoneA, ownerA.id);
  const newer = await context.request.put(`/api/tasks/${task.id}/metadata`, { headers: { ...await headers(context), 'X-Expected-User-Id': ownerA.id }, data: { client_request_id: randomUUID(), expected_revision: 1, changes: { title: '账号A当前新标题-992' } } }); expect(newer.status()).toBe(200);
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(page.getByRole('heading', { name: '账号A当前新标题-992', exact: true })).toBeVisible(); release(); await expect.poll(() => fulfilled).toBe(true);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin); await expect(page.getByRole('heading', { name: '账号A当前新标题-992', exact: true })).toBeVisible(); const current = await open(page, '账号A当前新标题-992', task.id);
  await current.getByRole('button', { name: '核验任务设置请求', exact: true }).click(); await expect(current.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0); expect((await readTask(context, task.id))?.metadata_revision).toBe(2); expect(sent.expected_revision).toBe(0);
  await page.screenshot({ path: info.outputPath('metadata-account-epoch-current-projection.png'), fullPage: true, animations: 'disabled' }); await foreign.close();
});

test('deleted task retains query and close recovery after reload without recreation', async ({ page, context }) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '设置删除恢复任务'); await workspace(page); let panel = await open(page, task.title, task.id);
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); await route.abort('connectionreset'); });
  await panel.getByLabel('设置任务名称', { exact: true }).fill('未送达私密标题'); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click(); await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled();
  const deleted = await context.request.delete(`/api/tasks/${task.id}`, { headers: await headers(context) }); expect(deleted.ok()).toBe(true); await reload(page); panel = page.getByTestId('task-metadata'); await expect(panel).toContainText('不会重新创建任务'); await panel.getByRole('button', { name: '核验任务设置请求', exact: true }).click(); await expect(panel.getByRole('button', { name: '核对并结束原设置请求', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '核对并结束原设置请求', exact: true }).click(); await expect(panel).toHaveCount(0); expect(await readTask(context, task.id)).toBeUndefined();
});

test('another tab successful metadata receipt preserves this tabs unsent draft and original revision', async ({ page, context }, info) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '设置未提交草稿保留'); await workspace(page); const first = await open(page, task.title, task.id);
  await first.getByLabel('设置任务名称', { exact: true }).fill('标签A尚未提交的私密草稿');
  const secondPage = await context.newPage(); beginSessionTokenRecovery(secondPage, info); await workspace(secondPage); const second = await open(secondPage, task.title, task.id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  await secondPage.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await gate; await route.fulfill({ response }); });
  await second.getByLabel('设置任务名称', { exact: true }).fill('标签B已保存设置'); await second.getByRole('button', { name: '保存任务设置', exact: true }).click(); await expect.poll(() => committed).toBe(true);
  await page.bringToFront(); await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(first.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled(); await first.getByRole('button', { name: '核验任务设置请求', exact: true }).click();
  await expect(first.getByLabel('设置任务名称', { exact: true })).toHaveValue('标签A尚未提交的私密草稿'); await expect(first.getByRole('button', { name: '保存任务设置', exact: true })).toBeDisabled(); await expect(first.getByRole('button', { name: '读取最新设置并重新编辑', exact: true })).toBeEnabled();
  expect((await readTask(context, task.id))?.title).toBe('标签B已保存设置'); release(); await expect(second.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('metadata-unsubmitted-cross-tab-draft-preserved.png'), fullPage: true, animations: 'disabled' }); await secondPage.close();
});

test('planning attributes create, clear and distinguish zero without model dispatch or schedule changes', async ({ page, context }, info) => {
  await registerSyntheticAccount(context); await workspace(page);
  let modelCalls = 0; page.on('request', request => { if (/\/tasks\/[^/]+\/run$/.test(new URL(request.url()).pathname)) modelCalls++; });
  await page.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('规划属性零分钟任务'); await page.getByLabel('希望得到什么').fill('只保存本人规划属性，绝不调用模型。');
  await page.getByLabel('新任务优先级', { exact: true }).selectOption('high'); await page.getByLabel('新任务预计分钟', { exact: true }).fill('0');
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tasks' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存任务', exact: true }).click(); const created = await (await createdResponse).json() as WorkspaceTask;
  expect(created).toMatchObject({ priority: 'high', estimated_minutes: 0, auto_run: false, run_at: null });
  const card = page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { name: created.title, exact: true }) });
  await expect(card).toContainText('预计 0 分钟'); const panel = card.getByTestId('task-metadata'); await expect(panel).toBeVisible();
  await panel.getByLabel('设置优先级', { exact: true }).selectOption(''); await panel.getByLabel('设置预计分钟', { exact: true }).fill('');
  await panel.getByRole('button', { name: '保存任务设置', exact: true }).click(); await expect(panel).toContainText('任务设置已确认保存。');
  await expect(card).toContainText('优先级未设置'); await expect(card).toContainText('未估算');
  expect(await readTask(context, created.id)).toMatchObject({ priority: null, estimated_minutes: null, auto_run: false, run_at: null, metadata_revision: 1 }); expect(modelCalls).toBe(0);
  await page.screenshot({ path: info.outputPath('planning-null-zero-cleared.png'), fullPage: true, animations: 'disabled' });
});

test('planning native encrypted unknown command reloads and retries exact priority and zero', async ({ page, context }) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '规划加密恢复'); await workspace(page); let panel = await open(page, task.title, task.id);
  const detail = page.locator(`[id="task-detail-${task.id}"]`); await detail.getByText('此设备的保存选择', { exact: true }).click(); await detail.getByRole('checkbox', { name: '加密恢复未提交草稿', exact: true }).check();
  const sent: UpdateTaskMetadataInput[] = [];
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); sent.push(route.request().postDataJSON()); if (sent.length === 1) return route.abort('connectionreset'); await route.continue(); });
  await panel.getByLabel('设置优先级', { exact: true }).selectOption('high'); await panel.getByLabel('设置预计分钟', { exact: true }).fill('0'); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled();
  await reload(page); panel = await open(page, task.title, task.id); await expect(panel.getByRole('button', { name: '按原设置同号重试', exact: true })).toBeEnabled();
  await expect(panel.getByLabel('设置优先级', { exact: true })).toHaveValue('high'); await expect(panel.getByLabel('设置预计分钟', { exact: true })).toHaveValue('0');
  await panel.getByRole('button', { name: '按原设置同号重试', exact: true }).click(); await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(sent[0].changes).toEqual({ priority: 'high', estimated_minutes: 0 });
  expect(await readTask(context, task.id)).toMatchObject({ priority: 'high', estimated_minutes: 0, auto_run: false, run_at: null, metadata_revision: 1 });
});

test('planning real missing-field ACK stays unresolved until authoritative query returns exact null', async ({ page, context }) => {
  const owner = await registerSyntheticAccount(context); const task = await createTask(context, '规划缺字段回执');
  const seed = await context.request.put(`/api/tasks/${task.id}/metadata`, { headers: { ...await headers(context), 'X-Expected-User-Id': owner.id }, data: { client_request_id: randomUUID(), expected_revision: 0, changes: { priority: 'high', estimated_minutes: 30 } } }); expect(seed.status()).toBe(200);
  await workspace(page); const panel = await open(page, task.title, task.id); let sent!: UpdateTaskMetadataInput;
  await page.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); sent = route.request().postDataJSON(); const response = await route.fetch(); const body = await response.json(); delete body.task.estimated_minutes; await route.fulfill({ response, json: body }); });
  await panel.getByLabel('设置预计分钟', { exact: true }).fill(''); await panel.getByRole('button', { name: '保存任务设置', exact: true }).click();
  await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled(); expect(sent.changes).toEqual({ estimated_minutes: null });
  await panel.getByRole('button', { name: '核验任务设置请求', exact: true }).click(); await expect(panel.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  expect(await readTask(context, task.id)).toMatchObject({ priority: 'high', estimated_minutes: null, metadata_revision: 2 });
});

test('planning two native tabs preserve unsent priority and zero after another request commits', async ({ page, context }, info) => {
  await registerSyntheticAccount(context); const task = await createTask(context, '规划双标签保留草稿'); await workspace(page); const first = await open(page, task.title, task.id);
  await first.getByLabel('设置优先级', { exact: true }).selectOption('high'); await first.getByLabel('设置预计分钟', { exact: true }).fill('0');
  const secondPage = await context.newPage(); beginSessionTokenRecovery(secondPage, info); await workspace(secondPage); const second = await open(secondPage, task.title, task.id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let committed = false;
  await secondPage.route(`**/api/tasks/${task.id}/metadata`, async route => { if (route.request().method() !== 'PUT') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await gate; await route.fulfill({ response }); });
  await second.getByLabel('设置任务名称', { exact: true }).fill('另一个标签已保存'); await second.getByRole('button', { name: '保存任务设置', exact: true }).click(); await expect.poll(() => committed).toBe(true);
  await page.bringToFront(); await page.getByRole('button', { name: '刷新', exact: true }).click(); await expect(first.getByRole('button', { name: '核验任务设置请求', exact: true })).toBeEnabled(); await first.getByRole('button', { name: '核验任务设置请求', exact: true }).click();
  await expect(first.getByLabel('设置优先级', { exact: true })).toHaveValue('high'); await expect(first.getByLabel('设置预计分钟', { exact: true })).toHaveValue('0');
  await expect(first).toContainText('原请求已确认保存，当前草稿尚未保存。'); await expect(first.getByRole('button', { name: '保存任务设置', exact: true })).toBeDisabled();
  expect(await readTask(context, task.id)).toMatchObject({ title: '另一个标签已保存', priority: null, estimated_minutes: null, metadata_revision: 1 });
  release(); await expect(second.getByRole('button', { name: '核验任务设置请求', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('planning-cross-tab-unsent-preserved.png'), fullPage: true, animations: 'disabled' }); await secondPage.close();
});

test('planning native creation malformed attribute ACK keeps original request until query', async ({ page, context }, info) => {
  const owner = await registerSyntheticAccount(context);
  const origins = ['http://127.0.0.1:3210', 'http://127.0.0.1:3202'];
  const gate = createCommandReadGate({ ownerId: owner.id, origins });
  let sentKey = '', taskId = '', creates = 0, completed = false;
  const mutations: string[] = [];
  page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/tasks') && !['GET', 'OPTIONS'].includes(request.method())) mutations.push(`${request.method()} ${path}`); });
  const journal = () => page.evaluate(({ ownerId, key }) => localStorage.getItem(`qunthink_command_v1_${encodeURIComponent(ownerId)}:${key}`), { ownerId: owner.id, key: sentKey });
  async function holdRealRead(route: import('@playwright/test').Route) {
    const request = route.request();
    const ticket = gate.begin({ method: request.method(), url: request.url(), ownerId: request.headers()['x-expected-user-id'] });
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
    gate.verify(ticket, { status: response.status(), body: await response.json() });
    try { await gate.wait(ticket); } catch (error) { if (gate.isCleanupError(error)) return; throw error; }
    await route.fulfill({ response }); // The real bytes/status/headers are unchanged.
    gate.delivered(ticket);
  }
  // Install before navigation. Initial StrictMode reads, create-finally and
  // verify-finally give at most four real lists; none can retire the journal
  // before the real button click. No abort, fake empty list, or retry is used.
  await page.route('**/api/tasks', async route => {
    if (route.request().method() === 'GET') return holdRealRead(route);
    const url = new URL(route.request().url()); expect(origins).toContain(url.origin); expect(url.search).toBe(''); expect(url.hash).toBe(''); expect(route.request().headers()['x-expected-user-id']).toBe(owner.id);
    expect(route.request().method()).toBe('POST'); expect(++creates).toBe(1);
    sentKey = route.request().headers()['idempotency-key']; expect(sentKey).not.toBe('');
    const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 }); expect(response.status()).toBe(201); const task = await response.json();
    taskId = task.id; expect(task).toMatchObject({ client_request_id: sentKey, priority: 'high', estimated_minutes: 0, metadata_revision: 0 });
    gate.bind({ key: sentKey, taskId, priority: 'high', estimatedMinutes: 0 });
    const malformed = { ...task }; delete malformed.estimated_minutes;
    await route.fulfill({ response, json: malformed }); // Sole deliberate error injection.
  });
  await page.route('**/api/tasks/commands/*', holdRealRead);
  try {
    await workspace(page);
    await page.getByRole('button', { name: '＋ 新任务', exact: true }).click(); await page.getByLabel('任务名称', { exact: true }).fill('创建回执核验规划'); await page.getByLabel('希望得到什么').fill('合成本地输入');
    await page.getByLabel('新任务优先级', { exact: true }).selectOption('high'); await page.getByLabel('新任务预计分钟', { exact: true }).fill('0');
    await page.getByRole('button', { name: '保存任务', exact: true }).click();
    const recover = page.getByRole('button', { name: '核验这次创建', exact: true }); await expect(recover).toBeEnabled();
    await expect(page.getByRole('alert').filter({ hasText: '创建回执缺少有效规划属性' })).toBeVisible();
    const originalJournal = await journal(); expect(originalJournal).not.toBeNull(); expect(JSON.parse(originalJournal!)).toMatchObject({ key: sentKey, action: 'create', taskId: null });
    expect(creates).toBe(1); expect(gate.snapshot().delivered).toBe(0);
    await recover.click(); // Keep all authoritative reads held through actionability.
    await expect.poll(() => gate.snapshot().verifiedQueries).toBe(1);
    expect(await journal()).toBe(originalJournal); await expect(recover).toBeDisabled();
    gate.releaseAfterClick();
    await expect(recover).toHaveCount(0); await expect.poll(journal).toBeNull();
    await expect.poll(() => gate.snapshot().postReleaseListsDelivered).toBe(1);
    await expect.poll(() => gate.snapshot().delivered === gate.snapshot().total).toBe(true);
    gate.assertComplete(); expect(creates).toBe(1); expect(mutations).toEqual(['POST /api/tasks']);
    const tasks = await (await context.request.get('/api/tasks')).json() as WorkspaceTask[];
    const sameIntent = tasks.filter(task => task.client_request_id === sentKey); expect(sameIntent).toHaveLength(1);
    expect(sameIntent[0]).toMatchObject({ id: taskId, priority: 'high', estimated_minutes: 0, metadata_revision: 0 });
    await info.attach('create-read-gate-proof.json', { body: JSON.stringify({ ownerId: owner.id, key: sentKey, taskId, creates, mutations, reads: gate.evidence(), finalJournal: await journal() }), contentType: 'application/json' });
    completed = true;
  } finally {
    await disposeCreateReadGate(gate, (options: { behavior: 'wait' | 'ignoreErrors' }) => page.unrouteAll(options), completed);
  }
});
