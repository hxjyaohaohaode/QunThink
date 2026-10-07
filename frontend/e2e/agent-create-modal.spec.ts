import { test, expect, type Dialog } from '@playwright/test';
import { registerSyntheticAccount } from './authFixture';

// Real Chromium controls/focus, explicit question/create response doubles.
// Not backend creation/provider validation. Runtime is authorized CI only.
test.use({ trace: 'on', video: 'on' });
test('agent wizard retains drafts and blocks dismissal while creating', async ({ page, context }, info) => {
  await registerSyntheticAccount(context);
  let creates = 0;
  let releaseFailure!: () => void;
  const gate = new Promise<void>(resolve => { releaseFailure = resolve; });
  const submitted: Record<string, unknown>[] = [];
  await page.route('**/api/agents/generate-questions', async route => {
    expect(route.request().method()).toBe('POST');
    await route.fulfill({ json: [{ id: 'web', question: '需要搜索吗？' }] });
  });
  await page.route('**/api/agents', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    creates++;
    const body = route.request().postDataJSON(); submitted.push(body);
    if (creates === 1) { await gate; return route.fulfill({ status: 400, json: { error: '受控创建失败' } }); }
    await route.fulfill({ status: 201, json: { id: 'ui-agent-fixture', name: body.name, description: body.description, opening_message: body.openingMessage, created_at: '2026-10-07T00:00:00Z' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '智能体', exact: true }).click();
  const add = page.getByRole('button', { name: '添加智能体', exact: true });
  await add.click();
  const dialog = page.getByRole('dialog');
  const close = page.getByRole('button', { name: '关闭创建智能体', exact: true });
  await expect(close).toBeFocused();
  await page.getByPlaceholder('输入智能体名称').fill('草稿验收助手');
  await page.getByPlaceholder('描述智能体的功能和用途').fill('关闭前保留这一段完整说明');
  await page.getByPlaceholder('智能体首次对话的开场语').fill('你好，继续未完成的配置');
  const decline = async (action: () => Promise<unknown>) => {
    const confirmation = page.waitForEvent('dialog'); const done = action();
    const prompt = await confirmation; expect(prompt.message()).toBe('放弃已填写的内容？');
    await prompt.dismiss(); await done; await expect(dialog).toBeVisible();
  };
  await decline(() => close.click());
  await expect(page.getByPlaceholder('输入智能体名称')).toHaveValue('草稿验收助手');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByPlaceholder('是/否').fill('是，保留答案');
  await decline(() => page.keyboard.press('Escape'));
  await expect(page.getByPlaceholder('是/否')).toHaveValue('是，保留答案');
  await decline(() => dialog.click({ position: { x: 2, y: 2 } }));
  await expect(page.getByPlaceholder('是/否')).toHaveValue('是，保留答案');
  await page.screenshot({ path: info.outputPath('agent-step2-preserved.png'), fullPage: true });
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByPlaceholder('描述智能体的功能和用途')).toHaveValue('关闭前保留这一段完整说明');
  await expect(page.getByPlaceholder('智能体首次对话的开场语')).toHaveValue('你好，继续未完成的配置');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByPlaceholder('是/否')).toHaveValue('是，保留答案');
  await page.getByRole('button', { name: '创建智能体', exact: true }).click();
  await expect(page.getByRole('button', { name: '创建中...', exact: true })).toBeDisabled();
  await expect(close).toBeDisabled();
  let unexpected = 0;
  const rejectUnexpected = async (prompt: Dialog) => { unexpected++; await prompt.dismiss(); };
  page.on('dialog', rejectUnexpected);
  await dialog.click({ position: { x: 2, y: 2 } }); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible(); await expect.poll(() => creates).toBe(1); expect(unexpected).toBe(0);
  await page.screenshot({ path: info.outputPath('agent-creating-locked.png'), fullPage: true });
  page.off('dialog', rejectUnexpected); releaseFailure();
  await expect(page.getByRole('button', { name: '创建智能体', exact: true })).toBeEnabled();
  await expect(page.getByPlaceholder('是/否')).toHaveValue('是，保留答案');
  await decline(() => close.click());
  await page.screenshot({ path: info.outputPath('agent-failure-draft.png'), fullPage: true });
  await page.getByRole('button', { name: '创建智能体', exact: true }).click();
  await expect(page.getByRole('button', { name: '完成', exact: true })).toBeVisible();
  expect(creates).toBe(2); expect(submitted[1]).toEqual(submitted[0]);
  await page.screenshot({ path: info.outputPath('agent-success.png'), fullPage: true });
  page.on('dialog', rejectUnexpected);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(add).toBeFocused(); expect(unexpected).toBe(0);
  page.off('dialog', rejectUnexpected);
  await add.click(); await expect(page.getByPlaceholder('输入智能体名称')).toHaveValue('');
  await page.getByPlaceholder('输入智能体名称').fill('明确放弃的草稿');
  const prompt = page.waitForEvent('dialog'); const closing = close.click();
  await (await prompt).accept(); await closing; await expect(dialog).toHaveCount(0);
  await add.click(); await expect(page.getByPlaceholder('输入智能体名称')).toHaveValue('');
  await close.click(); await expect(dialog).toHaveCount(0);
  await info.attach('agent-modal-evidence-boundary', { body: JSON.stringify({ testedRevision: process.env.GITHUB_SHA || 'unknown', creates, boundary: 'Real browser UI with explicit mocked Agent question/create responses; no backend creation or model-quality claim' }, null, 2), contentType: 'application/json' });
});
