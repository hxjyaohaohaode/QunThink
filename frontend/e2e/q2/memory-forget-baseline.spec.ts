import { test, expect, type Page, type TestInfo, type Locator, type Dialog } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerSyntheticAccount } from '../authFixture';
import { observeSessionLimits, waitForAuthenticatedDestination } from '../sessionRecovery';
import { assertQ1CiRuntime } from '../../scripts/q1-fixture-protocol.mjs';
if (!process.argv.includes('--list')) assertQ1CiRuntime();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const expectedSourceTrees = {"frontend/src": "e228b9935ec4af590cf1978c12f13706e0710992", "backend/src": "77efc68d14eb7570cfd0153308174a3d14e52586", "shared": "4d13f0b780a5c41e01f038c8ddb256b8ec04e4dc", "frontend/public": "ed1479156ead8a97946e8ac90addb9e02a1c8ec6", "有字logo.txt": "2bf638c4c1f670a86b42a381cafb133fd0bd227d", "纯logo.txt": "9e995a3440b28592b50039274a0bfe5fa3f3e513"};
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
function snapshot() {
  const value: Record<string, any> = { errors: [] };
  try {
    value.commit = git('rev-parse', 'HEAD'); value.tree = git('rev-parse', 'HEAD^{tree}');
    value.sourceTrees = Object.fromEntries(Object.keys(expectedSourceTrees).map(path => [path, git('rev-parse', `HEAD:${path}`)]));
    value.changed = git('diff', '--name-only', 'HEAD', '--', ...Object.keys(expectedSourceTrees));
    value.untracked = git('ls-files', '--others', '--', ...Object.keys(expectedSourceTrees));
    value.brand = execFileSync('node', ['scripts/verify-brand.mjs'], { cwd: root, encoding: 'utf8' }).trim();
  } catch (error) { value.errors.push(error instanceof Error ? error.message : String(error)); }
  value.valid = !value.errors.length && value.changed === '' && value.untracked === '' && JSON.stringify(value.sourceTrees) === JSON.stringify(expectedSourceTrees);
  return value;
}
class Evidence {
  readonly start = snapshot(); entries: Record<string, any>[] = []; number = 0;
  constructor(readonly page: Page, readonly info: TestInfo) {}
  record(stage: string, data: Record<string, any> = {}) { this.entries.push({ stage, at: new Date().toISOString(), ...data }); }
  async shot(name: string, target?: Locator) {
    if (target) { await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded(); }
    const file = this.info.outputPath(`${String(++this.number).padStart(2, '0')}-${name}-viewport.png`);
    await this.page.screenshot({ path: file }); await this.info.attach(name, { path: file, contentType: 'image/png' });
  }
  async finish(error?: unknown) {
    const end = snapshot(), valid = this.start.valid && end.valid && this.start.commit === end.commit && this.start.tree === end.tree;
    await this.info.attach('memory-forget-baseline-ledger.json', { contentType: 'application/json', body: JSON.stringify({
      schema: 'qunthink-memory-forget-baseline/v1', baselineApplication: 'd91438adc52191c77153eee970bc6c6d24b9caa8',
      githubRunId: process.env.GITHUB_RUN_ID, project: this.info.project.name, browser: this.page.context().browser()?.version(),
      start: this.start, end, integrityValid: valid, entries: this.entries,
      outcome: error ? 'execution-error-needs-triage' : valid ? 'baseline-captured-user-recovery-gap-pending-independent-visual-review' : 'integrity-error',
      executionError: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      boundaries: ['Actual browser controls create and forget the synthetic memory; only the test account/session is provisioned by API', 'Frozen d914 application bytes, not the unpublished recovery candidate', 'Only one pending memory request per scenario; baseline does not grant candidate, multiple-tab, or all private-cache acceptance', 'LowDB memory deletion ledger only; cloud memory storage and real provider/SMS not exercised', 'Native motion is preserved; scripted action evidence still requires independent visual review']
    }, null, 2) });
    if (!error) expect(valid).toBe(true);
  }
}
for (const committed of [false, true]) {
  test(`memory forget baseline: ${committed ? 'committed ACK lost' : 'not admitted'} then reload`, async ({ page, context }, info) => {
    const e = new Evidence(page, info); let failure: unknown;
    try {
      const user = await registerSyntheticAccount(context, { nickname: '独立遗忘基线用户' });
      observeSessionLimits(page); await page.goto('/');
      const workspace = page.getByTestId('workspace'); await waitForAuthenticatedDestination(page, workspace, e);
      await workspace.getByRole('button', { name: '记忆记录', exact: true }).click();
      const memory = workspace.getByRole('region', { name: '个人记忆记录', exact: true });
      await expect(memory).toBeVisible();
      const content = committed ? '独立基线B：已经遗忘但回执丢失的合成笔记' : '独立基线A：遗忘请求尚未到达的合成笔记';
      await memory.getByLabel('写一条个人笔记', { exact: true }).fill(content);
      const savedResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/memory/store');
      await memory.getByRole('button', { name: '保存笔记', exact: true }).click();
      const saved = await savedResponse; expect(saved.status()).toBe(200); const savedBody = await saved.json();
      const id = savedBody.memoryId; expect(id).toBeTruthy(); expect(savedBody.memory.content).toBe(content);
      const article = memory.locator('article').filter({ hasText: content }); await expect(article).toBeVisible(); await e.shot('original-note-visible', article);
      const requests: Record<string, any>[] = [];
      await page.route(`**/api/memory/${id}/forget`, async route => {
        const request = route.request(); expect(request.method()).toBe('POST'); expect(request.postDataJSON()).toEqual({});
        expect(request.headers()['x-expected-user-id']).toBe(user.id);
        const observed: Record<string, any> = { method: request.method(), pathname: new URL(request.url()).pathname, body: request.postData(), bodySha256: createHash('sha256').update(request.postData() || '').digest('hex'), expectedUser: request.headers()['x-expected-user-id'], forwarded: false };
        requests.push(observed);
        if (committed) { const result = await route.fetch(); observed.forwarded = true; observed.serverStatus = result.status(); observed.serverReceipt = await result.json(); expect(result.status()).toBe(200); expect(observed.serverReceipt).toMatchObject({ memoryId: id, forgotten: true }); }
        await route.abort('connectionreset');
      });
      await article.getByRole('button', { name: '遗忘', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: '遗忘这条记忆', exact: true }); await expect(confirm).toBeVisible(); await e.shot('explicit-forget-confirmation', confirm);
      await confirm.getByRole('button', { name: '确认', exact: true }).click();
      await expect(memory.getByRole('button', { name: '重试核对遗忘', exact: true })).toBeVisible();
      await expect(memory.locator('article').filter({ hasText: content })).toHaveCount(0);
      await e.shot('unknown-before-reload', memory); expect(requests).toHaveLength(1);
      e.record('original-privacy-intent-unknown-in-ui', { memoryId: id, committed, requests: structuredClone(requests) });
      let unexpected: string | null = null;
      const handler = async (dialog: Dialog) => { e.record('reload-dialog', { type: dialog.type(), expected: dialog.type() === 'beforeunload' }); if (dialog.type() === 'beforeunload') await dialog.accept(); else { unexpected = dialog.type(); await dialog.dismiss(); } };
      page.on('dialog', handler);
      try { await page.reload(); await waitForAuthenticatedDestination(page, workspace, e); }
      finally { page.off('dialog', handler); }
      expect(unexpected, 'Unexpected dialogs must not be silently dismissed into a passing run').toBeNull();
      const refreshed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/memory');
      await workspace.getByRole('button', { name: '记忆记录', exact: true }).click();
      const response = await refreshed; expect(response.status()).toBe(200); const after = await response.json();
      await expect(memory.getByRole('heading', { name: `可查看记录（${after.total}）`, exact: true })).toBeVisible();
      await expect(memory.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
      const controls = await memory.getByRole('button').allTextContents();
      const recovery = memory.getByRole('button', { name: /^(重试核对遗忘|继续核对遗忘)/ });
      const recoveryCount = await recovery.count();
      expect(recoveryCount).toBe(0); // Baseline gap assertion, not a candidate acceptance criterion.
      expect(requests).toHaveLength(1);
      if (committed) { expect(after.memories).toHaveLength(0); await expect(memory.locator('article')).toHaveCount(0); await expect(memory.getByText('暂无可查看记录，可以从第一条个人笔记开始。', { exact: true })).toBeVisible(); }
      else { expect(after.memories.some((record: { id: string }) => record.id === id)).toBe(true); await expect(memory.locator('article').filter({ hasText: content })).toBeVisible(); }
      await e.shot('after-reload-current-memory-view', committed ? memory : memory.locator('article').filter({ hasText: content }));
      e.record('baseline-observed-recovery-gap', { memoryId: id, committed, recoveryCount, visibleControls: controls, serverMemories: after.memories, requestCount: requests.length,
        meaning: committed ? 'The server completed forgetting but the user lost the specific unknown-request entry after reload; an empty list is not shown as an exact operation receipt' : 'The unadmitted forget intent lost its recovery entry and the still-active note returned after reload' });
    } catch (error) { failure = error; throw error; } finally { await e.finish(failure); }
  });
}
