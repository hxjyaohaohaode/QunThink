import { test, expect } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';

// A separate file is required: trace/video force a worker fixture and cannot
// be overridden inside a describe group. Keep successful recovery evidence.
test.use({ trace: 'on', video: 'on' });
async function openWorkspace(page, context) {
  await registerSyntheticAccount(context); await page.goto('/');
  const workspace = page.getByTestId('workspace');
  await expect(workspace).toBeVisible(); await expect(workspace).toHaveCount(1);
  return workspace;
}

test('lost save acknowledgement replays the frozen original key and content while preserving new typing', async ({ page, context }, info) => {
  const workspace = await openWorkspace(page, context);
  await workspace.getByRole('button', { name: '＋ 新任务', exact: true }).click();
  await workspace.getByLabel('任务名称', { exact: true }).fill('断网核验任务');
  await workspace.getByLabel('希望得到什么').fill('只应创建一次');
  const keys: string[] = [], payloads: unknown[] = []; let intercepted = false; let allowRefresh = true;
  await page.route('**/api/tasks', async route => {
    if (route.request().method() !== 'POST') return allowRefresh ? route.continue() : route.abort('connectionreset');
    keys.push(route.request().headers()['idempotency-key']);
    payloads.push(route.request().postDataJSON());
    if (!intercepted) { intercepted = true; const response = await route.fetch(); expect(response.status()).toBe(201); allowRefresh = false; await route.abort('connectionreset'); }
    else { allowRefresh = true; await route.continue(); }
  });
  await workspace.getByRole('button', { name: '保存任务', exact: true }).click();
  const recovery = workspace.getByRole('region', { name: '待确认的文稿创建请求', exact: true });
  await expect(recovery.getByRole('button', { name: '按原内容重试', exact: true })).toBeEnabled();
  await expect(workspace.getByLabel('任务名称', { exact: true })).toBeEditable();
  await expect(workspace.getByLabel('希望得到什么')).toBeEditable();
  await workspace.getByLabel('任务名称', { exact: true }).fill('后来写下的新任务，尚未提交');
  await workspace.getByLabel('希望得到什么').fill('这段新输入不能被放入旧请求，也不能被旧回执清掉');
  await page.screenshot({ path: info.outputPath('new-input-before-original-replay.png') });
  await recovery.getByRole('button', { name: '按原内容重试', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('explicit-original-replay-control.png') });
  await recovery.getByRole('button', { name: '按原内容重试', exact: true }).click();
  await expect(recovery).not.toBeVisible();
  await expect(workspace.getByRole('heading', { level: 3, name: '断网核验任务', exact: true })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  expect(payloads[1]).toEqual(payloads[0]);
  const tasks = await (await context.request.get('/api/tasks')).json();
  expect(tasks.filter((task: { title: string }) => task.title === '断网核验任务')).toHaveLength(1);
  expect(tasks).toHaveLength(1); expect(tasks[0].prompt).toBe('只应创建一次');
  await expect(workspace.getByLabel('任务名称', { exact: true })).toHaveValue('后来写下的新任务，尚未提交');
  await expect(workspace.getByLabel('希望得到什么')).toHaveValue('这段新输入不能被放入旧请求，也不能被旧回执清掉');
  await workspace.getByLabel('希望得到什么').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('current-input-preserved-after-original-replay.png') });
  await info.attach('original-replay-outcome.json', { contentType: 'application/json', body: JSON.stringify({ keys, payloads, tasks, liveTitle: await workspace.getByLabel('任务名称', { exact: true }).inputValue(), livePurpose: await workspace.getByLabel('希望得到什么').inputValue() }, null, 2) });
});
