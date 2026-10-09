import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';

async function openMemory(page: Page, context: BrowserContext) {
  await registerSyntheticAccount(context, { nickname: '记忆体验测试' });
  await page.goto('/');
  const workspace = page.getByTestId('workspace');
  await expect(workspace).toHaveCount(1);
  await workspace.getByRole('button', { name: '记忆记录', exact: true }).click();
  await expect(workspace.getByRole('heading', { name: '个人记忆记录', exact: true })).toBeVisible();
  return workspace;
}
async function persisted(context: BrowserContext) {
  const result = await context.request.get('/api/memory?limit=100&offset=0');
  expect(result.ok()).toBe(true); return (await result.json()).memories;
}

test('memory lost-create acknowledgment survives workspace navigation and replays one real record', async ({ page, context }, info) => {
  const workspace = await openMemory(page, context);
  const content = 'Private-Memory-Canary-Current-Tab-92817';
  await workspace.getByLabel('写一条个人笔记', { exact: true }).fill(content);
  const keys: string[] = []; let lost = false;
  await page.route('**/api/memory/store', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (!lost) { lost = true; const saved = await route.fetch(); expect(saved.ok()).toBe(true); await route.abort('connectionreset'); }
    else await route.continue();
  });
  await workspace.getByRole('button', { name: '保存笔记', exact: true }).click();
  await expect(workspace.getByRole('button', { name: '同一请求核对保存', exact: true })).toBeVisible();
  await expect(workspace.getByLabel('写一条个人笔记', { exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('memory-unknown-create.png'), fullPage: true, animations: 'disabled' });
  await workspace.getByRole('button', { name: '运行记录', exact: true }).click();
  await expect(workspace.getByRole('list', { name: '本地运行记录' })).not.toContainText(content);
  await workspace.getByRole('button', { name: '记忆记录', exact: true }).click();
  await expect(workspace.getByLabel('写一条个人笔记', { exact: true })).toHaveValue(content);
  await expect(workspace.getByLabel('写一条个人笔记', { exact: true })).toBeDisabled();
  await workspace.getByRole('button', { name: '同一请求核对保存', exact: true }).click();
  await expect(workspace.getByLabel('写一条个人笔记', { exact: true })).toHaveValue('');
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  expect((await persisted(context)).filter((memory: { content: string }) => memory.content === content)).toHaveLength(1);
  const disk = await page.evaluate(() => ({ local: Object.values(localStorage), session: Object.values(sessionStorage) }));
  expect(JSON.stringify(disk)).not.toContain(content);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)).toBe(false);
});

test('memory revision conflict preserves draft until reviewed rebase and explicit save', async ({ page, context }, info) => {
  const workspace = await openMemory(page, context);
  await workspace.getByLabel('写一条个人笔记', { exact: true }).fill('原始版本');
  await workspace.getByRole('button', { name: '保存笔记', exact: true }).click();
  const article = workspace.locator('article').filter({ hasText: '原始版本' });
  await expect(article).toBeVisible(); await article.getByRole('button', { name: '更正', exact: true }).click();
  await workspace.getByLabel('更正个人笔记', { exact: true }).fill('我的未提交更正');
  const [memory] = await persisted(context);
  const csrf = await (await context.request.get('/api/csrf-token')).json();
  const changed = await context.request.post(`/api/memory/${memory.id}/correct`, {
    headers: { 'x-csrf-token': csrf.csrfToken }, data: { content: '另一端已保存版本', expectedRevision: 0 },
  });
  expect(changed.ok()).toBe(true);
  await workspace.getByRole('button', { name: '保存更正', exact: true }).click();
  await expect(workspace.getByLabel('更正个人笔记', { exact: true })).toHaveValue('我的未提交更正');
  await expect(workspace.getByRole('button', { name: '基于当前版本继续编辑', exact: true })).toBeVisible();
  await expect(workspace.getByRole('region', { name: '更正草稿' })).toContainText('另一端已保存版本');
  await page.screenshot({ path: info.outputPath('memory-revision-conflict.png'), fullPage: true, animations: 'disabled' });
  await workspace.getByRole('button', { name: '基于当前版本继续编辑', exact: true }).click();
  expect((await persisted(context))[0].content).toBe('另一端已保存版本');
  await workspace.getByRole('button', { name: '保存更正', exact: true }).click();
  await expect(workspace.getByText('更正已保存；请检查依赖旧内容的草稿和已发布内容。', { exact: true })).toBeVisible();
  expect((await persisted(context))[0]).toMatchObject({ content: '我的未提交更正', revision: 2 });
});

test('lost correction receipt reconciles without a second write, and forgetting needs confirmation', async ({ page, context }, info) => {
  const workspace = await openMemory(page, context);
  await workspace.getByLabel('写一条个人笔记', { exact: true }).fill('删除前的原始笔记');
  await workspace.getByRole('button', { name: '保存笔记', exact: true }).click();
  await workspace.locator('article').getByRole('button', { name: '更正', exact: true }).click();
  await workspace.getByLabel('更正个人笔记', { exact: true }).fill('已提交但未收到回执');
  let correctionWrites = 0;
  await page.route('**/api/memory/*/correct', async route => {
    correctionWrites++; const saved = await route.fetch(); expect(saved.ok()).toBe(true); await route.abort('connectionreset');
  });
  await workspace.getByRole('button', { name: '保存更正', exact: true }).click();
  await expect(workspace.getByRole('button', { name: '核对并重试更正', exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '核对并重试更正', exact: true }).click();
  await expect(workspace.getByText('已核对：当前记录与本次更正一致，没有重复提交。请检查依赖旧内容的草稿和已发布内容。', { exact: true })).toBeVisible();
  expect(correctionWrites).toBe(1); expect((await persisted(context))[0].revision).toBe(1);
  await workspace.locator('article').getByRole('button', { name: '遗忘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '遗忘这条记忆', exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: info.outputPath('memory-forget-confirmation.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toBeHidden();
  expect(await persisted(context)).toHaveLength(1);
  await workspace.locator('article').getByRole('button', { name: '遗忘', exact: true }).click();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await expect(workspace.getByText('该记录已遗忘，当前保存的正文已清除；已导出文件和外部副本需分别处理。', { exact: true })).toBeVisible();
  expect(await persisted(context)).toHaveLength(0);
});
