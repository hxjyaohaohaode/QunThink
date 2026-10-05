import { test, expect, type Page, type TestInfo, type Locator, type Dialog, type BrowserContext, type APIResponse } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerSyntheticAccount } from '../authFixture';
import { observeSessionLimits, waitForAuthenticatedDestination } from '../sessionRecovery';
import { assertQ1CiRuntime } from '../../scripts/q1-fixture-protocol.mjs';
if (!process.argv.includes('--list')) assertQ1CiRuntime();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
// Candidate regression follows the tested commit, while start/end checks forbid
// modified or untracked production bytes. Historical d914 hashes belong only
// to the archived e80 baseline, not to future application versions.
const expectedSourceTrees = Object.fromEntries(['frontend/src', 'backend/src', 'shared', 'frontend/public', '有字logo.txt', '纯logo.txt'].map(path => [path, git('rev-parse', `HEAD:${path}`)]));
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
  async shot(name: string, target?: Locator) { await this.shotPage(this.page, name, target); }
  async shotPage(page: Page, name: string, target?: Locator) {
    await page.bringToFront();
    this.record('visible-surface', { name, surface: page === this.page ? 'primary' : 'secondary', contextPageIndex: page.context().pages().indexOf(page), scrollRequested: !!target, ...(await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin, visibility: document.visibilityState }))) });
    if (target) { await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded(); }
    const file = this.info.outputPath(`${String(++this.number).padStart(2, '0')}-${name}-viewport.png`);
    await page.screenshot({ path: file }); await this.info.attach(name, { path: file, contentType: 'image/png' });
  }
  async finish(error?: unknown) {
    const end = snapshot(), valid = this.start.valid && end.valid && this.start.commit === end.commit && this.start.tree === end.tree;
    await this.info.attach('memory-forget-recovery-ledger.json', { contentType: 'application/json', body: JSON.stringify({
      schema: 'qunthink-memory-forget-recovery/v1', previousApplication: 'e80c7ffdd2cf724e06198bae5dbce8228f4c9450',
      githubRunId: process.env.GITHUB_RUN_ID, project: this.info.project.name, browser: this.page.context().browser()?.version(),
      start: this.start, end, integrityValid: valid, entries: this.entries,
      outcome: error ? 'execution-error-needs-triage' : valid ? 'candidate-scenarios-completed-pending-independent-visual-review' : 'integrity-error',
      executionError: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      boundaries: ['Actual browser controls create and forget the synthetic memory; only the test account/session is provisioned by API', 'Frozen candidate source trees verified before and after each case', 'One pending ID per recovery case; the separate two-tab case covers a late list response, not all cross-account or multi-key schedules', 'LowDB memory deletion ledger only; cloud memory storage and real provider/SMS not exercised', 'Native motion is preserved; scripted action evidence still requires independent visual review']
    }, null, 2) });
    if (!error) expect(valid).toBe(true);
  }
}

const region = (page: Page) => page.getByTestId('workspace').getByRole('region', { name: '个人记忆记录', exact: true });
const recovered = (page: Page) => region(page).locator('[aria-label="尚未确认的遗忘请求"]');
async function enterMemory(page: Page, e: Evidence) {
  await page.bringToFront();
  const workspace = page.getByTestId('workspace'); await waitForAuthenticatedDestination(page, workspace, { record: (stage, data) => e.record(stage, { surface: page === e.page ? 'primary' : 'secondary', ...data }), shot: (name, target) => e.shotPage(page, name, target) });
  const loaded = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/memory');
  await workspace.getByRole('button', { name: '记忆记录', exact: true }).click();
  const response = await loaded; expect(response.status()).toBe(200); const data = await response.json();
  await expect(region(page).getByRole('heading', { name: `可查看记录（${data.total}）`, exact: true })).toBeVisible();
  e.record('entered-memory', { surface: page === e.page ? 'primary' : 'secondary', contextPageIndex: page.context().pages().indexOf(page), expectedUser: response.request().headers()['x-expected-user-id'], ownerIds: [...new Set(data.memories.map((memory: { sender_id: string }) => memory.sender_id))] });
  return data;
}
async function setup(page: Page, context: BrowserContext, e: Evidence) {
  expect(e.start.valid).toBe(true); observeSessionLimits(page);
  const user = await registerSyntheticAccount(context, { nickname: '遗忘恢复合成用户' });
  await page.goto('/'); await enterMemory(page, e); return user;
}
async function createNote(page: Page, content: string) {
  await region(page).getByLabel('写一条个人笔记', { exact: true }).fill(content);
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/memory/store');
  await region(page).getByRole('button', { name: '保存笔记', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(200); const data = await response.json(); expect(data.memory.content).toBe(content);
  await expect(region(page).locator('article').filter({ hasText: content })).toBeVisible(); return data.memoryId as string;
}
async function confirmForget(page: Page, content: string, e: Evidence) {
  await page.bringToFront();
  await region(page).locator('article').filter({ hasText: content }).getByRole('button', { name: '遗忘', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '遗忘这条记忆', exact: true }); await e.shot('explicit-forget-confirmation', dialog);
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
}
async function reloadMemory(page: Page, e: Evidence) {
  let unexpected: string | null = null;
  const handler = async (dialog: Dialog) => { e.record('reload-dialog', { type: dialog.type(), expected: dialog.type() === 'beforeunload' }); if (dialog.type() === 'beforeunload') await dialog.accept(); else { unexpected = dialog.type(); await dialog.dismiss(); } };
  page.on('dialog', handler);
  try { await page.reload(); await enterMemory(page, e); } finally { page.off('dialog', handler); }
  expect(unexpected).toBeNull();
}
async function receipt(page: Page, userId: string, id: string) {
  return page.evaluate(({ userId, id }) => JSON.parse(localStorage.getItem(`qunthink_memory_forget_v1:${encodeURIComponent(userId)}:${encodeURIComponent(id)}`) || 'null'), { userId, id });
}
async function actualForgotten(context: BrowserContext, id: string) {
  const response = await context.request.get(`/api/memory/${id}`); expect(response.status()).toBe(410); expect((await response.json()).code).toBe('MEMORY_FORGOTTEN');
}
for (const committed of [false, true]) {
  test(`memory recovery: ${committed ? 'committed ACK lost' : 'not admitted'} survives reload and exact-ID retry`, async ({ page, context }, info) => {
    const e = new Evidence(page, info); let failure: unknown;
    try {
      const user = await setup(page, context, e), content = committed ? '候选B：回执丢失也要完成遗忘' : '候选A：刷新后不让待遗忘正文回来';
      const id = await createNote(page, content); await e.shot('original-note', region(page).locator('article').filter({ hasText: content }));
      let mode: 'initial' | 'synthetic-404' | 'real' = 'initial'; const requests: Record<string, any>[] = [];
      await page.route(`**/api/memory/${id}/forget`, async route => {
        const request = route.request(); expect(request.method()).toBe('POST'); expect(request.postDataJSON()).toEqual({}); expect(request.headers()['x-expected-user-id']).toBe(user.id);
        const record: Record<string, any> = { mode, method: request.method(), path: new URL(request.url()).pathname, body: request.postData(), bodySha256: createHash('sha256').update(request.postData() || '').digest('hex'), expectedUser: request.headers()['x-expected-user-id'], forwarded: false, at: new Date().toISOString() }; requests.push(record);
        if (mode === 'synthetic-404') { record.syntheticResponse = { success: false, code: 'MEMORY_NOT_FOUND', error: '合成故障：暂时无法确认这条记录' }; await route.fulfill({ status: 404, json: record.syntheticResponse }); return; }
        if (mode === 'initial' && !committed) { await route.abort('connectionreset'); return; }
        const response = await route.fetch(); record.forwarded = true; record.responseStatus = response.status(); record.serverReceipt = await response.json();
        expect(response.status()).toBe(200); expect(record.serverReceipt).toMatchObject({ memoryId: id, forgotten: true });
        if (mode === 'initial') await route.abort('connectionreset'); else await route.fulfill({ response });
      });
      await confirmForget(page, content, e); await expect(region(page).getByRole('button', { name: '重试核对遗忘', exact: true })).toBeVisible();
      await expect(region(page).locator('article').filter({ hasText: content })).toHaveCount(0);
      const before = await receipt(page, user.id, id); expect(before).toMatchObject({ accountId: user.id, memoryId: id, state: 'pending' }); expect(JSON.stringify(before)).not.toContain(content);
      e.record('original-intent', { id, committed, requests: structuredClone(requests), deviceReceipt: before }); await e.shot('unknown-before-reload', region(page).locator('[aria-label="操作核对"]'));
      await reloadMemory(page, e); await expect(recovered(page)).toBeVisible(); await expect(region(page).locator('article').filter({ hasText: content })).toHaveCount(0); expect(requests).toHaveLength(1);
      await e.shot('natural-return-with-recovery-priority');
      await expect(recovered(page)).toContainText('再次请求遗忘对应的同一记录并核对结果');
      await expect(recovered(page).locator('summary')).toHaveText(`记录编号 · ${id.slice(-8)}`);
      const times = recovered(page).getByText(/^请求时间（本地）：/); await expect(times).toBeVisible();
      const colors = await times.evaluate(element => { const layers = []; for (let n: Element | null = element; n; n = n.parentElement) { const s = getComputedStyle(n); layers.push({ tag: n.tagName, color: s.color, background: s.backgroundColor, opacity: s.opacity }); } return { text: element.textContent, layers }; });
      const queueBox = await recovered(page).boundingBox(), formBox = await region(page).locator('form').boundingBox(); expect(queueBox).toBeTruthy(); expect(formBox).toBeTruthy(); expect(queueBox!.y).toBeLessThan(formBox!.y);
      e.record('restored-same-ID-before-action', { deviceReceipt: await receipt(page, user.id, id), colors, queueBox, formBox, automaticRequests: requests.length - 1 });
      await e.shot('same-ID-time-and-explicit-action', recovered(page));
      mode = 'synthetic-404'; await recovered(page).getByRole('button', { name: '继续核对遗忘（1）', exact: true }).click();
      await expect(region(page).getByText(/遗忘结果尚未确认/)).toBeVisible(); expect(requests).toHaveLength(2); expect((await receipt(page, user.id, id)).state).toBe('pending');
      await expect(region(page).locator('article').filter({ hasText: content })).toHaveCount(0);
      e.record('single-exact-ID-synthetic-404-not-authoritative-absence', { injected: requests[1], meaning: 'The known record is not claimed missing on the real server. This is one bounded HTTP fault fixture.' }); await e.shot('404-remains-unconfirmed', region(page).locator('[aria-label="操作核对"]'));
      mode = 'real'; await region(page).getByRole('button', { name: '重试核对遗忘', exact: true }).click();
      await expect(region(page).getByText('该记录已遗忘，当前保存的正文已清除；已导出文件和外部副本需分别处理。', { exact: true })).toBeVisible();
      expect(requests).toHaveLength(3); expect(requests.every(request => request.path === `/api/memory/${id}/forget` && request.body === '{}')).toBe(true);
      const complete = await receipt(page, user.id, id); expect(complete).toMatchObject({ accountId: user.id, memoryId: id, state: 'confirmed' }); expect(JSON.stringify(complete)).not.toContain(content);
      await actualForgotten(context, id); await e.shot('actual-confirmed-receipt-no-body', region(page));
      await reloadMemory(page, e); await expect(recovered(page)).toHaveCount(0); await expect(region(page).locator('article').filter({ hasText: content })).toHaveCount(0); expect(requests).toHaveLength(3);
      e.record('final-privacy-result', { id, requests, deviceReceipt: await receipt(page, user.id, id), explicitSameIdRetry: true, noAutomaticRetryAfterReload: true }); await e.shot('confirmed-reopen-no-pending-no-body', region(page));
    } catch (error) { failure = error; throw error; } finally { await e.finish(failure); }
  });
}

test('memory recovery: another-tab completion fences the original delayed list bytes', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let failure: unknown; let release: (() => void) | undefined; let other: Page | undefined;
  type RouteOutcome = { ok: boolean; error?: string };
  let routeSettled: Promise<RouteOutcome> | null = null;
  try {
    const user = await setup(page, context, e), content = '双标签隐私核验：旧列表绝不能把已遗忘正文送回来';
    const id = await createNote(page, content); other = await context.newPage(); const peer = other;
    observeSessionLimits(peer); await peer.bringToFront(); await peer.goto('/'); await enterMemory(peer, e);
    await expect(region(peer).locator('article').filter({ hasText: content })).toBeVisible(); await e.shotPage(peer, 'other-tab-original-record', region(peer));
    e.record('surface-identity-map', { accountId: user.id, primary: { contextPageIndex: context.pages().indexOf(page), ...(await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin }))) }, secondary: { contextPageIndex: context.pages().indexOf(peer), ...(await peer.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin }))) }, meaning: 'Creation order, observed timeOrigin and each trace evaluate/screenshot target identify the two same-account pages; no DOM/store identity is injected.' });
    let held: { response: APIResponse; body: Buffer; request: Record<string, any> } | null = null; let claimed = false, released = false;
    const signal = new Promise<void>(resolve => { release = resolve; });
    await peer.route('**/api/memory**', async route => {
      const request = route.request(); if (new URL(request.url()).pathname !== '/api/memory' || request.method() !== 'GET' || claimed) { await route.continue(); return; }
      claimed = true; let finish!: (result: RouteOutcome) => void; routeSettled = new Promise(resolve => { finish = resolve; });
      try {
        const response = await route.fetch(); expect(response.status()).toBe(200); const body = await response.body(); const data = JSON.parse(body.toString());
        expect(data.memories.some((record: { id: string; sender_id: string }) => record.id === id && record.sender_id === user.id)).toBe(true); expect(request.headers()['x-expected-user-id']).toBe(user.id);
        held = { response, body, request: { method: request.method(), url: request.url(), expectedUser: request.headers()['x-expected-user-id'] } };
        await signal; await route.fulfill({ response }); released = true; finish({ ok: true });
      } catch (error) { finish({ ok: false, error: error instanceof Error ? error.message : String(error) }); throw error; }
    });
    const lateResponse = peer.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/memory');
    await peer.bringToFront(); await region(peer).getByRole('button', { name: '刷新', exact: true }).click(); await expect.poll(() => held !== null).toBe(true);
    const original = held! as { response: APIResponse; body: Buffer; request: Record<string, any> };
    e.record('original-authoritative-list-held', { surface: 'secondary', request: original.request, status: original.response.status(), responseBytes: original.body.length, responseSha256: createHash('sha256').update(original.body).digest('hex'), body: original.body.toString(), memoryId: id });
    const forgetPosts: Record<string, any>[] = [];
    for (const target of [page, peer]) target.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith(`/${id}/forget`)) forgetPosts.push({ surface: target === page ? 'primary' : 'secondary', url: request.url(), expectedUser: request.headers()['x-expected-user-id'], body: request.postData() }); });
    const acknowledgement = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/memory/${id}/forget`);
    await confirmForget(page, content, e); const ack = await acknowledgement; expect(ack.status()).toBe(200); const ackBody = await ack.json(); expect(ackBody).toMatchObject({ memoryId: id, forgotten: true });
    await expect(region(page).getByText('该记录已遗忘，当前保存的正文已清除；已导出文件和外部副本需分别处理。', { exact: true })).toBeVisible();
    await actualForgotten(context, id); expect((await receipt(page, user.id, id)).state).toBe('confirmed'); e.record('primary-real-forget-receipt', { surface: 'primary', ackBody });
    await peer.bringToFront(); await expect(region(peer).locator('article').filter({ hasText: content })).toHaveCount(0); await e.shotPage(peer, 'other-tab-hidden-before-late-response', region(peer));
    const initial = await peer.evaluate(text => {
      const root = document.querySelector('[aria-label="个人记忆记录"]'); if (!root || !root.isConnected) throw new Error('Memory region missing or detached');
      const state = { root, text, initialContains: !!root.textContent?.includes(text), reappeared: !!root.textContent?.includes(text), mutations: 0, observer: null as MutationObserver | null };
      state.observer = new MutationObserver(records => { state.mutations += records.length; if (root.textContent?.includes(text) || records.some(record => [...record.addedNodes].some(node => node.textContent?.includes(text)) || record.oldValue?.includes(text))) state.reappeared = true; });
      state.observer.observe(root, { subtree: true, childList: true, characterData: true, characterDataOldValue: true }); (window as any).__memoryPrivacyObservation = state;
      return { initialContains: state.initialContains, connected: root.isConnected, visibility: document.visibilityState };
    }, content);
    expect(initial.initialContains).toBe(false); expect(initial.visibility).toBe('visible');
    release!(); const delivered = await lateResponse; await delivered.finished(); const deliveredBody = await delivered.body();
    expect(createHash('sha256').update(deliveredBody).digest('hex')).toBe(createHash('sha256').update(original.body).digest('hex')); await expect.poll(() => released).toBe(true);
    await peer.bringToFront(); await expect(region(peer).getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    const beforeWindow = await peer.evaluate(() => { const state = (window as any).__memoryPrivacyObservation; return { connected: state.root.isConnected, sameRoot: state.root === document.querySelector('[aria-label="个人记忆记录"]'), contains: !!state.root.textContent?.includes(state.text), visibility: document.visibilityState }; });
    expect(beforeWindow).toMatchObject({ connected: true, sameRoot: true, contains: false, visibility: 'visible' });
    await peer.evaluate(() => new Promise<void>(resolve => { const start = performance.now(); const sample = () => performance.now() - start >= 400 ? resolve() : requestAnimationFrame(sample); requestAnimationFrame(sample); }));
    const observation = await peer.evaluate(() => { const state = (window as any).__memoryPrivacyObservation; return { reappeared: state.reappeared, mutations: state.mutations, finalContains: !!state.root.textContent?.includes(state.text), connected: state.root.isConnected, sameRoot: state.root === document.querySelector('[aria-label="个人记忆记录"]'), visibility: document.visibilityState }; });
    expect(observation).toMatchObject({ reappeared: false, finalContains: false, connected: true, sameRoot: true, visibility: 'visible' });
    await expect(region(peer).locator('article').filter({ hasText: content })).toHaveCount(0); await expect(region(page).locator('article').filter({ hasText: content })).toHaveCount(0);
    expect(forgetPosts).toHaveLength(1); expect(forgetPosts[0]).toMatchObject({ surface: 'primary', expectedUser: user.id, body: '{}' });
    await actualForgotten(context, id); e.record('late-original-list-did-not-republish', { initial, beforeWindow, observation, deliveredBytes: deliveredBody.length, deliveredSha256: createHash('sha256').update(deliveredBody).digest('hex'), memoryId: id, forgetPosts, observationWindowMs: 400 });
    await e.shotPage(peer, 'other-tab-stable-after-late-original-list', region(peer));
    await expect(region(peer).getByText('其他窗口已记录这条记忆的遗忘回执，旧正文已隐藏。可刷新查看最新记录。', { exact: true })).toBeVisible();
    await region(peer).getByRole('button', { name: '刷新', exact: true }).click(); await expect(region(peer).getByText('暂无可查看记录，可以从第一条个人笔记开始。', { exact: true })).toBeVisible();
    expect(forgetPosts).toHaveLength(1); await e.shotPage(peer, 'other-tab-explicit-refresh-empty', region(peer)); await e.shot('original-tab-still-forgotten', region(page));
  } catch (error) { failure = error; throw error; } finally {
    const cleanupErrors: string[] = []; release?.();
    if (routeSettled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race<RouteOutcome>([routeSettled, new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: 'Held route cleanup did not settle within 3000 ms' }), 3000); })]);
        if (!result.ok) cleanupErrors.push(result.error || 'Held route cleanup failed');
      } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
      finally { if (timer) clearTimeout(timer); }
    }
    try { if (other && !other.isClosed()) await other.evaluate(() => { const state = (window as any).__memoryPrivacyObservation; state?.observer?.disconnect(); delete (window as any).__memoryPrivacyObservation; }); }
    catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
    e.record('observation-and-route-cleanup', { cleanupErrors, originalFailurePreserved: !!failure });
    const cleanupFailure = !failure && cleanupErrors.length ? new Error('Evidence cleanup failed; see the separate ledger entry') : undefined;
    await e.finish(failure || cleanupFailure); if (cleanupFailure) throw cleanupFailure;
  }
});
