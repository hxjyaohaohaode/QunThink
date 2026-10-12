import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { registerSyntheticAccount } from './authFixture';
import { beginSessionTokenRecovery, navigateWithSessionTokenRecovery } from './sessionTokenRecovery';
import type { TaskResultDocument, WorkspaceTask } from '../../shared/tasks';

// Keep Chromium sandboxing enabled in local and CI runs. Never bypass a restricted host.
test.use({ launchOptions: { chromiumSandbox: true } });

test.beforeEach(async ({ page }, info) => { beginSessionTokenRecovery(page, info); });
async function headers(context: BrowserContext) {
  const csrf = await (await context.request.get('/api/csrf-token')).json();
  return { 'x-csrf-token': csrf.csrfToken };
}
async function createTask(context: BrowserContext, title: string, dependencyIds?: string[]) {
  const response = await context.request.post('/api/tasks', { headers: { ...await headers(context), 'Idempotency-Key': randomUUID() }, data: { title, prompt: '仅使用本任务自己的输入，不读取任何前置正文。', category: 'work', model_id: null, group_id: null, run_at: null, repeat_minutes: null, auto_run: false, ...(dependencyIds ? { dependency_ids: dependencyIds } : {}) } });
  expect(response.status()).toBe(201); return await response.json() as WorkspaceTask;
}
async function readDocument(context: BrowserContext, taskId: string) {
  const response = await context.request.get(`/api/tasks/${taskId}/result`); expect(response.status()).toBe(200); return await response.json() as TaskResultDocument;
}
async function saveDocument(context: BrowserContext, taskId: string, content: string, accept = false) {
  let doc = await readDocument(context, taskId);
  const response = await context.request.post(`/api/tasks/${taskId}/result/versions`, { headers: await headers(context), data: { client_request_id: randomUUID(), expected_revision: doc.revision, base_version_id: doc.head_version_id, content, ...(doc.dependency_state ? { reviewed_dependency_signature: doc.dependency_state.signature } : {}) } });
  expect(response.status()).toBe(200); doc = (await response.json()).document;
  if (accept) {
    const head = doc.versions.find(item => item.id === doc.head_version_id)!;
    const accepted = await context.request.post(`/api/tasks/${taskId}/result/accept`, { headers: await headers(context), data: { client_request_id: randomUUID(), expected_revision: doc.revision, version_id: head.id, content_hash: head.content_hash, source_hash: doc.source.hash } });
    expect(accepted.status()).toBe(200); doc = (await accepted.json()).document;
  }
  return doc;
}
async function openTask(page: Page, task: WorkspaceTask) {
  const card = page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { name: task.title, exact: true }) });
  await card.getByRole('button', { name: /打开详情|检查草稿/, exact: true }).click();
  await expect(card.getByTestId('task-result-editor')).toBeVisible(); return card;
}
async function workspace(page: Page) {
  await navigateWithSessionTokenRecovery(page, timeout => page.goto('/', { timeout })); await expect(page.getByTestId('workspace')).toBeVisible();
}

test('real dependencies block generation and acceptance, preserve writing, and require reviewed new versions after prerequisite changes', async ({ page, context }, info) => {
  await registerSyntheticAccount(context); const prior = await createTask(context, '依赖浏览器前置准备'); await workspace(page);
  await page.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('依赖浏览器下游文稿'); await page.getByLabel('希望得到什么').fill('只整理自己的当前输入');
  await page.getByRole('group', { name: '选择前置任务', exact: true }).getByRole('checkbox', { name: prior.title, exact: true }).check();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  const editor = page.getByTestId('task-result-editor'); await expect(editor).toBeVisible(); await expect(editor.getByText('前置任务尚未就绪，暂时不能生成或验收。仍可编辑和保存正文。')).toBeVisible();
  await editor.getByLabel('文稿正文', { exact: true }).fill('前置仍未完成，也能保存我的人工正文。');
  const initialReview = editor.getByRole('checkbox', { name: '我已核对当前前置任务状态，保存时记录此次复核' }); if (await initialReview.count()) await initialReview.check();
  await editor.getByRole('button', { name: '保存为新版本', exact: true }).click();
  await expect(editor.getByRole('button', { name: '验收版本 1', exact: true })).toBeDisabled(); await expect(editor.getByRole('button', { name: '让 AI 提供候选稿', exact: true })).toBeDisabled();
  const tasks: WorkspaceTask[] = await (await context.request.get('/api/tasks')).json(); const downstream = tasks.find(task => task.title === '依赖浏览器下游文稿')!;
  expect(downstream.dependency_ids).toEqual([prior.id]); expect(downstream.dependency_state?.blocked).toBe(true);
  const rejected = await context.request.post(`/api/tasks/${downstream.id}/run`, { headers: { ...await headers(context), 'Idempotency-Key': randomUUID() }, data: {} }); expect(rejected.status()).toBe(409);
  await saveDocument(context, prior.id, '前置已人工完成，正文只留在前置任务内。', true);
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await editor.getByRole('button', { name: '核对服务器最新状态', exact: true }).click();
  await expect(editor.getByRole('button', { name: '验收版本 1', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: '保存依赖复核后的新版本', exact: true })).toBeDisabled();
  await editor.getByRole('checkbox', { name: '我已核对当前前置任务状态，保存时记录此次复核' }).check();
  await editor.getByRole('button', { name: '保存依赖复核后的新版本', exact: true }).click();
  await editor.getByRole('button', { name: '验收版本 2', exact: true }).click(); await expect(editor.getByRole('button', { name: '已验收版本 2', exact: true })).toBeDisabled();
  await saveDocument(context, prior.id, '前置材料已经改动，还没有重新验收。');
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await editor.getByRole('button', { name: '核对服务器最新状态', exact: true }).click();
  await expect(editor.getByRole('button', { name: '已验收版本 2', exact: true })).toHaveCount(0); await expect(editor.getByRole('button', { name: '验收版本 2', exact: true })).toBeDisabled();
  await expect(editor.getByLabel('文稿正文', { exact: true })).toHaveValue('前置仍未完成，也能保存我的人工正文。');
  await page.screenshot({ path: info.outputPath('dependency-invalidated-writing-preserved.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
});

test('real committed lost ACK is recovered after close and reload without replacing the original command', async ({ page, context }) => {
  await registerSyntheticAccount(context); const prior = await createTask(context, '失联前置'); const task = await createTask(context, '失联下游'); await workspace(page);
  let card = await openTask(page, task); let dependencies = card.getByRole('region', { name: '编辑前置任务', exact: true });
  let writes = 0, original: Record<string, unknown> | undefined;
  await page.route(`**/api/tasks/${task.id}/dependencies`, async route => {
    if (route.request().method() !== 'PUT') return route.continue(); writes++; original = route.request().postDataJSON();
    const actual = await route.fetch(); expect(actual.status()).toBe(200); await route.abort('connectionreset');
  });
  await dependencies.getByRole('checkbox', { name: prior.title, exact: true }).check(); await dependencies.getByRole('button', { name: '保存前置任务', exact: true }).click();
  await expect(dependencies.getByRole('button', { name: '核验前置任务请求', exact: true })).toBeEnabled(); expect(writes).toBe(1);
  await card.getByRole('button', { name: '收起详情', exact: true }).click(); card = await openTask(page, task); dependencies = card.getByRole('region', { name: '编辑前置任务', exact: true });
  await expect(dependencies.getByRole('checkbox', { name: prior.title, exact: true })).toBeDisabled();
  await navigateWithSessionTokenRecovery(page, timeout => page.reload({ timeout })); card = await openTask(page, task); dependencies = card.getByRole('region', { name: '编辑前置任务', exact: true });
  await dependencies.getByRole('button', { name: '核验前置任务请求', exact: true }).click(); await expect(dependencies.getByRole('button', { name: '核验前置任务请求', exact: true })).toHaveCount(0); expect(writes).toBe(1);
  const result = await (await context.request.get(`/api/tasks/${task.id}/dependencies/commands/${original!.client_request_id}`)).json(); expect(result.receipt.committed_revision).toBe(1); expect(result.task.dependency_ids).toEqual([prior.id]);
});

test('concurrent dependency edit requires a deliberate reselection and another account cannot see or reference it', async ({ page, context, browser }) => {
  await registerSyntheticAccount(context); const first = await createTask(context, '冲突前置甲'); const second = await createTask(context, '冲突前置乙'); const task = await createTask(context, '冲突下游'); await workspace(page);
  const card = await openTask(page, task), dependencies = card.getByRole('region', { name: '编辑前置任务', exact: true });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); let submitted = false;
  await page.route(`**/api/tasks/${task.id}/dependencies`, async route => { if (route.request().method() !== 'PUT') return route.continue(); submitted = true; await hold; await route.continue(); });
  await dependencies.getByRole('checkbox', { name: first.title, exact: true }).check(); await dependencies.getByRole('button', { name: '保存前置任务', exact: true }).click(); await expect.poll(() => submitted).toBe(true);
  const concurrent = await context.request.put(`/api/tasks/${task.id}/dependencies`, { headers: await headers(context), data: { client_request_id: randomUUID(), expected_revision: 0, dependency_ids: [second.id] } }); expect(concurrent.status()).toBe(200); release();
  await expect(dependencies.getByText('前置任务关系已被修改。请读取最新关系，再重新选择；不会自动覆盖其他页面的修改。')).toBeVisible(); await expect(dependencies.getByRole('button', { name: '保存前置任务', exact: true })).toHaveCount(0);
  await dependencies.getByRole('button', { name: '核对并结束原前置请求', exact: true }).click();
  await dependencies.getByRole('button', { name: '读取最新关系并重新选择', exact: true }).click(); await expect(dependencies.getByRole('checkbox', { name: second.title, exact: true })).toBeChecked();
  const foreign = await browser.newContext({ baseURL: 'http://127.0.0.1:3210' });
  try {
    await registerSyntheticAccount(foreign); const foreignTask = await createTask(foreign, '其他账号自己的任务');
    const listing = await (await foreign.request.get('/api/tasks')).json(); expect(JSON.stringify(listing)).not.toContain(task.id); expect(JSON.stringify(listing)).not.toContain(first.title);
    const forbidden = await foreign.request.put(`/api/tasks/${foreignTask.id}/dependencies`, { headers: await headers(foreign), data: { client_request_id: randomUUID(), expected_revision: 0, dependency_ids: [first.id] } }); expect(forbidden.status()).toBe(404); expect(await forbidden.text()).not.toContain(first.title);
    const foreignPage = await foreign.newPage(); await foreignPage.goto('/'); await expect(foreignPage.getByTestId('workspace')).toBeVisible(); await foreignPage.getByRole('button', { name: '＋ 新任务', exact: true }).click(); await expect(foreignPage.getByRole('group', { name: '选择前置任务', exact: true })).not.toContainText(first.title);
  } finally { await foreign.close(); }
});
