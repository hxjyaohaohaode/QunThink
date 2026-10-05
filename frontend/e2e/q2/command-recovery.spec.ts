import { test, expect, type Page, type BrowserContext, type TestInfo, type Locator, type Route } from '@playwright/test';
import { createHash, randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerSyntheticAccount } from '../authFixture';
import { observeSessionLimits, waitForAuthenticatedDestination } from '../sessionRecovery';
import { assertQ1CiRuntime, Q1_ORIGIN } from '../../scripts/q1-fixture-protocol.mjs';

if (!process.argv.includes('--list')) assertQ1CiRuntime();
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePaths = ['frontend/src', 'backend/src', 'shared', 'frontend/public', '有字logo.txt', '纯logo.txt'];
type Json = Record<string, any>;
function integritySnapshot() {
  const snapshot: Json = { commit: null, tree: null, sourceTrees: {}, changed: null, untracked: null, brand: null, errors: [] };
  try { snapshot.commit = git('rev-parse', 'HEAD'); snapshot.tree = git('rev-parse', 'HEAD^{tree}'); for (const path of sourcePaths) snapshot.sourceTrees[path] = git('rev-parse', `HEAD:${path}`); snapshot.changed = git('diff', '--name-only', 'HEAD', '--', ...sourcePaths); snapshot.untracked = git('ls-files', '--others', '--', ...sourcePaths); }
  catch (error) { snapshot.errors.push(error instanceof Error ? error.message : String(error)); }
  try { snapshot.brand = execFileSync('node', ['scripts/verify-brand.mjs'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch (error) { snapshot.errors.push(error instanceof Error ? error.message : String(error)); }
  snapshot.valid = !snapshot.errors.length && snapshot.changed === '' && snapshot.untracked === '';
  return snapshot;
}
class Evidence {
  entries: Json[] = []; number = 0; outcome = 'running';
  readonly start = integritySnapshot();
  constructor(readonly page: Page, readonly info: TestInfo) {}
  record(stage: string, data: Json = {}) { this.entries.push({ stage, at: new Date().toISOString(), ...data }); }
  async shot(name: string, target?: Locator) {
    if (target) { await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded(); }
    const label = `${String(++this.number).padStart(2, '0')}-${name}`;
    for (const fullPage of [false, true]) {
      const file = this.info.outputPath(`${label}-${fullPage ? 'full' : 'viewport'}.png`);
      await this.page.screenshot({ path: file, fullPage });
      await this.info.attach(`${label}-${fullPage ? 'full' : 'viewport'}`, { path: file, contentType: 'image/png' });
    }
    if (target) this.record('natural-frame-state', { label, observation: await target.evaluate(el => {
      const rect = el.getBoundingClientRect(); let opacity = 1;
      for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { opacity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, centerHit: !!hit && (hit === el || el.contains(hit)) };
    }), meaning: 'Natural motion is preserved. These numbers do not replace independent pixel/video review.' });
  }
  async finish(error?: unknown) {
    const final = integritySnapshot();
    const unchanged = this.start.valid && final.valid && this.start.commit === final.commit && this.start.tree === final.tree && JSON.stringify(this.start.sourceTrees) === JSON.stringify(final.sourceTrees);
    const ledger = { schema: 'qunthink-q2-outcome/v1', commit: this.start.commit, tree: this.start.tree, finalCommit: final.commit, finalTree: final.tree, githubRunId: process.env.GITHUB_RUN_ID,
      project: this.info.project.name, viewport: this.page.viewportSize(), browser: this.page.context().browser()?.version(), timezone: 'UTC',
      protectedStart: this.start, protectedFinal: final, protectedUnchanged: unchanged, integrityError: unchanged ? null : 'Source/brand/commit integrity could not be verified', outcome: error ? 'execution-error-requires-triage' : unchanged ? this.outcome : 'harness-integrity-error', entries: this.entries,
      boundaries: ['Scripted native Chromium; independent pixel review remains required', 'Synthetic dev-only account and isolated JSON backend; production SMS/PG UI untested', 'No model configured or provider requests; live provider quality/cost untested', 'No private draft opt-in; unsaved text lost on reload is retyped explicitly', 'Only original captured UI requests are delivered late, without reconstructing approximate commands'],
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error };
    await this.info.attach('q2-outcome-ledger.json', { body: JSON.stringify(ledger, null, 2), contentType: 'application/json' });
    if (!error) expect(unchanged).toBe(true);
  }
}
async function json(context: BrowserContext, path: string) {
  const response = await context.request.get(path); expect(response.ok(), `${path}: ${response.status()}`).toBe(true); return response.json();
}
async function login(page: Page, context: BrowserContext, e: Evidence) {
  expect(e.start.valid).toBe(true); observeSessionLimits(page);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['http://127.0.0.1:3210', 'http://127.0.0.1:3202'].includes(url.origin)) return route.abort('blockedbyclient');
    return route.continue();
  });
  const phone = `138${randomInt(10000000, 99999999)}`;
  const account = await registerSyntheticAccount(context, { phone, nickname: 'Q2 合成恢复用户' });
  await context.clearCookies(); await page.goto('/');
  const input = page.getByPlaceholder('请输入手机号'); await e.shot('initial-session-screen');
  await waitForAuthenticatedDestination(page, input, e); await e.shot('original-login-entry', input);
  const element = await input.elementHandle(); if (!element) throw new Error('Original login input unavailable');
  const started = Date.now();
  await expect.poll(() => element.evaluate(el => { let opacity = 1; for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity); return opacity; }), { timeout: 20000, intervals: [100, 250, 500] }).toBeGreaterThanOrEqual(0.999);
  e.record('original-login-motion-observed', { milliseconds: Date.now() - started, interpretation: 'Observation ceiling is not a user-performance pass' });
  await e.shot('login-ready', input); await input.fill(phone);
  await page.getByPlaceholder('请输入密码', { exact: true }).fill('Synthetic-Browser-Only-2026');
  await page.locator('form').getByRole('button', { name: '登录', exact: true }).click();
  await waitForAuthenticatedDestination(page, page.getByTestId('workspace'), e);
  e.record('real-login-zero-model', { accountId: account.id }); await e.shot('first-workspace'); return account.id as string;
}
async function reload(page: Page, e: Evidence) {
  let unexpected: string | null = null;
  const handler = async (dialog: import('@playwright/test').Dialog) => { e.record('reload-dialog', { type: dialog.type(), expected: dialog.type() === 'beforeunload' }); if (dialog.type() === 'beforeunload') await dialog.accept(); else { unexpected = dialog.type(); await dialog.dismiss(); } };
  page.on('dialog', handler);
  try { await page.reload(); await waitForAuthenticatedDestination(page, page.getByTestId('workspace'), e); }
  finally { page.off('dialog', handler); }
  expect(unexpected, 'An unexpected dialog was dismissed only to preserve evidence; it must not silently pass').toBeNull();
}
const composer = (page: Page) => page.locator('[data-observe="task-composer"]');
const createRecovery = (page: Page) => page.getByRole('region', { name: '待确认的文稿创建请求', exact: true });
const bodyRecovery = (page: Page) => page.getByRole('region', { name: '待确认的文稿请求', exact: true });
const taskCard = (page: Page, title: string) => page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });
async function openComposer(page: Page) {
  const opener = page.getByTestId('workspace').getByRole('button', { name: /^(＋ 新任务|继续任务草稿)$/ });
  // A saved form may still be visible during its exit animation. Start the
  // next user intent through the real, idempotent opener, not that old DOM.
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(composer(page)).toBeVisible();
}
async function fillComposer(page: Page, title: string, purpose: string) { await openComposer(page); await composer(page).getByLabel('任务名称', { exact: true }).fill(title); await composer(page).getByLabel('希望得到什么').fill(purpose); }
async function confirmClose(page: Page, recovery: Locator, e: Evidence, label: string) {
  await recovery.getByRole('button', { name: '核对并结束这次请求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^核对并结束这次待确认的/ }); await expect(dialog).toBeVisible(); await e.shot(label, dialog);
  await dialog.getByRole('button', { name: '核对并结束这次请求', exact: true }).click();
}
type Captured = { route: Route; method: string; url: string; bodyHash: string; key: string; expectedUser: string; forwarded: number };
function capture(route: Route): Captured {
  const request = route.request(); return { route, method: request.method(), url: request.url(), bodyHash: digest(request.postDataBuffer() || Buffer.alloc(0)), key: request.headers()['idempotency-key'], expectedUser: request.headers()['x-expected-user-id'], forwarded: 0 };
}
function identity(value: Captured) { const { route, ...rest } = value; return rest; }
async function deliverOriginal(value: Captured, user: string, expectedCode: string, e: Evidence) {
  expect(value.forwarded).toBe(0); expect(value.expectedUser).toBe(user);
  const current = capture(value.route); expect(identity(current)).toEqual(identity(value));
  // Playwright Route.fetch uses its original Request. Do not rebuild its URL,
  // payload, headers or identity if the retained route cannot be fetched.
  const response = await value.route.fetch({ maxRetries: 0, maxRedirects: 0 }); value.forwarded++;
  const body = await response.json(); expect(response.status()).toBe(410); expect(body.code).toBe(expectedCode);
  e.record('original-late-request-rejected', { request: identity(value), status: response.status(), code: body.code });
}

test('Q2 creation: missing original content, authoritative close, lost close ACK, outage and committed original', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let failure: unknown;
  try {
    const user = await login(page, context, e), writes: Captured[] = [];
    let mode: 'hold' | 'normal' | 'commit-drop' = 'hold'; let readBlocked = false; let closeMode: 'unreachable' | 'commit-drop' | 'normal' = 'unreachable';
    const closeReplies: Json[] = [];
    await page.route('**/api/tasks', async route => {
      if (route.request().method() === 'GET') return readBlocked ? route.abort('connectionreset') : route.continue();
      if (route.request().method() !== 'POST') return route.continue();
      const original = capture(route); writes.push(original);
      if (mode === 'hold') return route.abort('connectionreset');
      if (mode === 'commit-drop') { const response = await route.fetch(); original.forwarded++; expect(response.status()).toBe(201); e.record('original-create-committed-ack-lost', { request: identity(original), saved: await response.json() }); readBlocked = true; return route.abort('connectionreset'); }
      original.forwarded++;
      return route.continue();
    });
    await page.route('**/api/tasks/commands/**', async route => {
      if (route.request().method() === 'GET') return readBlocked ? route.abort('connectionreset') : route.continue();
      if (!route.request().url().endsWith('/close')) return route.continue();
      if (closeMode === 'unreachable') return route.abort('connectionreset');
      const response = await route.fetch(); expect(response.status()).toBe(200); closeReplies.push(await response.json());
      if (closeMode === 'commit-drop') { readBlocked = true; return route.abort('connectionreset'); }
      return route.fulfill({ response });
    });
    // A starts at the actual zero-model primary action, not a hidden API seed.
    await page.getByTestId('workspace').getByRole('button', { name: '现在开始写作', exact: true }).click();
    await fillComposer(page, 'Q2 原创建不会迟到复活', '原用途仅在本页面，不开启私人草稿副本');
    await composer(page).getByRole('button', { name: '保存任务', exact: true }).click(); await expect(createRecovery(page)).toBeVisible();
    await expect.poll(() => writes.length).toBe(1); const original = writes[0]; expect(original.forwarded).toBe(0);
    const absent = await context.request.get(`/api/tasks/commands/${original.key}`); expect(absent.status()).toBe(404);
    e.record('A-not-admitted-before-reload', { request: identity(original), lookupStatus: absent.status(), taskCount: (await json(context, '/api/tasks')).length }); await e.shot('A-original-create-not-admitted', createRecovery(page));
    await reload(page, e); await expect(createRecovery(page)).toBeVisible(); await openComposer(page);
    await expect(composer(page).getByLabel('希望得到什么')).toHaveValue(''); await expect(createRecovery(page).getByText('原文字未保存在此设备，请重新填写或从已存版本继续。')).toBeVisible();
    await fillComposer(page, 'Q2 当前人工重填', '刷新后实际重新填写，不能借原UUID恢复这段文字');
    await confirmClose(page, createRecovery(page), e, 'D-close-outage-confirmation');
    await expect(createRecovery(page)).toBeVisible(); await expect(composer(page).getByLabel('希望得到什么')).toHaveValue('刷新后实际重新填写，不能借原UUID恢复这段文字');
    expect(writes).toHaveLength(1); e.record('D-outage-keeps-original-and-live-text', { originalKey: original.key, writes: writes.length }); await e.shot('D-unknown-close-current-text-retained', composer(page));
    closeMode = 'commit-drop'; await confirmClose(page, createRecovery(page), e, 'C-close-before-ack-loss');
    await expect.poll(() => closeReplies.length).toBe(1); expect(closeReplies[0].client_request_id).toBe(original.key); expect(closeReplies[0].status).toBe('cancelled');
    await expect(createRecovery(page)).toBeVisible(); expect(writes).toHaveLength(1); e.record('C-close-committed-ack-and-reads-unavailable', { reply: closeReplies[0], combinationFault: 'Close committed, its ACK lost, subsequent authoritative browser reads unavailable until explicit verification' });
    await reload(page, e); await expect(createRecovery(page)).toBeVisible();
    await fillComposer(page, 'Q2 最终新意图', '这段文字在刷新后再次填写，只会用新请求保存');
    readBlocked = false; closeMode = 'normal'; await createRecovery(page).getByRole('button', { name: '核验这次创建', exact: true }).click(); await expect(createRecovery(page)).not.toBeVisible();
    await expect(composer(page).getByLabel('希望得到什么')).toHaveValue('这段文字在刷新后再次填写，只会用新请求保存');
    e.record('C-original-cancelled-receipt-recovered', { receipt: await json(context, `/api/tasks/commands/${original.key}`) }); await e.shot('A-C-new-intent-now-permitted', composer(page));
    mode = 'normal'; await composer(page).getByRole('button', { name: '保存任务', exact: true }).click(); await expect(taskCard(page, 'Q2 最终新意图')).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1].key).not.toBe(original.key);
    await deliverOriginal(original, user, 'TASK_CREATE_COMMAND_CLOSED', e);
    const afterLate = await json(context, '/api/tasks'); expect(afterLate).toHaveLength(1); expect(afterLate[0].client_request_id).toBe(writes[1].key); expect(afterLate[0].prompt).toBe('这段文字在刷新后再次填写，只会用新请求保存');
    e.record('A-final-authority-after-late-delivery', { tasks: afterLate }); await e.shot('A-final-single-new-task');
    // B is a different original intent which did commit before its ACK was lost.
    mode = 'commit-drop'; await fillComposer(page, 'Q2 已提交原稿', '已提交的原用途必须仍可找到'); await composer(page).getByRole('button', { name: '保存任务', exact: true }).click(); await expect(createRecovery(page)).toBeVisible();
    await expect.poll(() => writes.length).toBe(3); const committed = writes[2]; await fillComposer(page, 'Q2 后续独立新稿', '核验旧成功期间的新输入不得被抹掉');
    await confirmClose(page, createRecovery(page), e, 'B-find-original-without-discarding-new-input'); await expect(createRecovery(page)).not.toBeVisible();
    expect(closeReplies.at(-1)?.status).toBe('succeeded'); expect(closeReplies.at(-1)?.client_request_id).toBe(committed.key);
    await expect(composer(page).getByLabel('希望得到什么')).toHaveValue('核验旧成功期间的新输入不得被抹掉');
    await e.shot('B-new-input-preserved-after-original-success', composer(page));
    readBlocked = false; mode = 'normal'; await composer(page).getByRole('button', { name: '保存任务', exact: true }).click(); await expect(taskCard(page, 'Q2 后续独立新稿')).toBeVisible();
    const final = await json(context, '/api/tasks'); expect(final).toHaveLength(3); expect(final.filter((task: Json) => task.client_request_id === committed.key)).toHaveLength(1); expect(final.find((task: Json) => task.title === 'Q2 后续独立新稿').prompt).toBe('核验旧成功期间的新输入不得被抹掉');
    expect((await json(context, `${Q1_ORIGIN}/__q1/observations`)).calls).toHaveLength(0);
    e.record('B-final-original-and-new-intents-distinct', { tasks: final, writes: writes.map(identity), providerCalls: 0 }); await e.shot('final-zero-model-created-results'); e.outcome = 'protocol-pass-pending-independent-visual-review';
  } catch (error) { failure = error; throw error; } finally { await e.finish(failure); }
});

test('Q2 same document: close pending body writes without losing new typing, accepted history or original success', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let failure: unknown;
  try {
    const user = await login(page, context, e), title = 'Q2 同稿人工修订与待确认请求';
    await page.getByTestId('workspace').getByRole('button', { name: '现在开始写作', exact: true }).click();
    await fillComposer(page, title, '用同一份文稿检查可靠保存，不启用私人草稿恢复');
    const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
    await composer(page).getByRole('button', { name: '保存任务', exact: true }).click();
    const created = await createdResponse; expect(created.status()).toBe(201); const task = await created.json();
    const editor = page.getByTestId('task-result-editor'); await expect(editor).toHaveAttribute('data-task-id', task.id);
    const body = editor.getByRole('textbox', { name: '文稿正文', exact: true });
    const originalBody = '这是已经保存并确认过的人工作品。旧版本必须一直保留。';
    await body.fill(originalBody); await editor.getByRole('button', { name: '保存为新版本', exact: true }).click();
    await expect(editor.getByRole('button', { name: '验收版本 1', exact: true })).toBeEnabled();
    await editor.getByRole('button', { name: '验收版本 1', exact: true }).click(); await expect(editor.getByRole('button', { name: '已验收版本 1', exact: true })).toBeVisible();
    const baseline = await json(context, `/api/tasks/${task.id}/result`); expect(baseline.versions).toHaveLength(1); expect(baseline.accepted_version_id).toBe(baseline.head_version_id);
    await e.shot('baseline-accepted-human-version', body); e.record('baseline-accepted-document', { document: baseline });
    const writes: Captured[] = [], closeReplies: Json[] = [];
    let mode: 'hold' | 'normal' | 'commit-drop' = 'hold', queryBlocked = false, closeMode: 'unreachable' | 'commit-drop' | 'normal' = 'unreachable';
    await page.route(`**/api/tasks/${task.id}/result/versions`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const original = capture(route); writes.push(original);
      if (mode === 'hold') return route.abort('connectionreset');
      if (mode === 'commit-drop') {
        const response = await route.fetch(); original.forwarded++; expect(response.status()).toBe(200);
        e.record('B-body-original-committed-ack-lost', { original: identity(original), saved: await response.json() }); queryBlocked = true; return route.abort('connectionreset');
      }
      original.forwarded++;
      return route.continue();
    });
    await page.route(`**/api/tasks/${task.id}/result/commands/**`, async route => {
      if (route.request().method() === 'GET') return queryBlocked ? route.abort('connectionreset') : route.continue();
      if (!route.request().url().endsWith('/close')) return route.continue();
      if (closeMode === 'unreachable') return route.abort('connectionreset');
      const response = await route.fetch(); expect(response.status()).toBe(200); closeReplies.push(await response.json());
      if (closeMode === 'commit-drop') { queryBlocked = true; return route.abort('connectionreset'); }
      return route.fulfill({ response });
    });
    async function reopen() {
      await reload(page, e);
      await page.getByTestId('workspace').getByRole('button', { name: '打开文稿核验', exact: true }).click();
      await expect(editor).toHaveAttribute('data-task-id', task.id); await expect(bodyRecovery(page)).toBeVisible();
      await expect(body).toHaveValue(originalBody);
      e.record('reopened-without-private-draft', { taskId: task.id, body: await body.inputValue(), originalBodyRestoredFrom: 'saved authoritative version, not the unsaved lost text' });
    }
    await body.fill('A这段旧文字尚未准入，刷新后不能声称恢复');
    await editor.getByRole('button', { name: '保存为新版本', exact: true }).click(); await expect(bodyRecovery(page)).toBeVisible(); await expect.poll(() => writes.length).toBe(1);
    const original = writes[0]; expect(original.forwarded).toBe(0);
    const absent = await context.request.get(`/api/tasks/${task.id}/result/commands/${original.key}`); expect(absent.status()).toBe(404);
    e.record('A-body-not-admitted', { original: identity(original), status: absent.status() }); await e.shot('A-body-request-not-yet-admitted', bodyRecovery(page));
    await reopen(); await expect(bodyRecovery(page).getByText('原文字未保存在此设备，请重新填写或从已存版本继续。')).toBeVisible();
    await body.fill('D服务暂不可达时，这段当前输入必须留在编辑区');
    await confirmClose(page, bodyRecovery(page), e, 'D-body-close-service-unreachable'); await expect(bodyRecovery(page)).toBeVisible(); await expect(body).toHaveValue('D服务暂不可达时，这段当前输入必须留在编辑区');
    expect(writes).toHaveLength(1); await e.shot('D-body-current-input-still-editable', body);
    closeMode = 'commit-drop'; await confirmClose(page, bodyRecovery(page), e, 'C-body-close-ack-about-to-be-lost');
    await expect.poll(() => closeReplies.length).toBe(1); expect(closeReplies[0].receipt.id).toBe(original.key); expect(closeReplies[0].receipt.status).toBe('cancelled');
    await expect(bodyRecovery(page)).toBeVisible(); expect(writes).toHaveLength(1);
    e.record('C-body-close-committed-ack-and-reads-lost', { response: closeReplies[0], combinationFault: 'Close committed, ACK lost, subsequent browser receipt reads unavailable until explicit verification' });
    await reopen(); const afterReload = 'A-C刷新后重新写的人工第二版，只用新请求保存。'; await body.fill(afterReload);
    queryBlocked = false; closeMode = 'normal'; await bodyRecovery(page).getByRole('button', { name: '核验原请求', exact: true }).click(); await expect(bodyRecovery(page)).not.toBeVisible(); await expect(body).toHaveValue(afterReload);
    e.record('C-body-original-closure-recovered', { receipt: await json(context, `/api/tasks/${task.id}/result/commands/${original.key}`), liveBody: await body.inputValue() }); await e.shot('A-C-body-can-now-save-new-intent', body);
    mode = 'normal'; await editor.getByRole('button', { name: '保存为新版本', exact: true }).click(); await expect(editor.getByRole('button', { name: '验收版本 2', exact: true })).toBeVisible();
    expect(writes).toHaveLength(2); expect(writes[1].key).not.toBe(original.key);
    await deliverOriginal(original, user, 'RESULT_COMMAND_CLOSED', e);
    const afterLate = await json(context, `/api/tasks/${task.id}/result`); expect(afterLate.versions).toHaveLength(2); expect(afterLate.versions.find((version: Json) => version.id === afterLate.head_version_id).content).toBe(afterReload);
    expect(afterLate.accepted_version_id).toBe(baseline.accepted_version_id); expect(afterLate.versions.find((version: Json) => version.id === baseline.head_version_id).content).toBe(originalBody);
    e.record('A-body-authority-after-late-delivery', { document: afterLate });
    mode = 'commit-drop'; await body.fill('B这段第三版确实已经到服务器，但确认回包丢失');
    await editor.getByRole('button', { name: '保存为新版本', exact: true }).click(); await expect(bodyRecovery(page)).toBeVisible(); await expect.poll(() => writes.length).toBe(3);
    const committed = writes[2], finalBody = 'B核验原第三版时继续写的第四版。人工新输入不能被旧回执替换。'; await body.fill(finalBody);
    await confirmClose(page, bodyRecovery(page), e, 'B-body-original-committed-new-typing-retained'); await expect(bodyRecovery(page)).not.toBeVisible(); await expect(body).toHaveValue(finalBody);
    expect(closeReplies.at(-1)?.receipt.id).toBe(committed.key); expect(closeReplies.at(-1)?.receipt.status).toBe('succeeded');
    await e.shot('B-body-after-old-success-current-human-text', body);
    queryBlocked = false; mode = 'normal'; await editor.getByRole('button', { name: '保存为新版本', exact: true }).click(); await expect(editor.getByRole('button', { name: '验收版本 4', exact: true })).toBeVisible();
    const final = await json(context, `/api/tasks/${task.id}/result`); expect(final.task_id).toBe(task.id); expect(final.versions).toHaveLength(4); expect(final.accepted_version_id).toBe(baseline.accepted_version_id);
    expect(final.versions.find((version: Json) => version.id === final.head_version_id).content).toBe(finalBody);
    expect(final.versions.find((version: Json) => version.id === baseline.head_version_id).content).toBe(originalBody);
    expect(final.versions.find((version: Json) => version.id === closeReplies.at(-1)?.receipt.version_id).content).toBe('B这段第三版确实已经到服务器，但确认回包丢失');
    const history = editor.locator('details.writing-history'); await history.locator(':scope > summary').click();
    const old = history.locator('li').filter({ has: page.getByText('版本 1', { exact: true }) }); await old.getByText('展开完整版本', { exact: true }).click(); await e.shot('original-accepted-version-remains-readable', old);
    await e.shot('final-same-document-current-human-body', body);
    const downloading = page.waitForEvent('download'); await editor.getByRole('button', { name: '下载文本', exact: true }).click(); const download = await downloading;
    const filename = info.outputPath('q2-final-human-body.txt'); await download.saveAs(filename); const actual = await readFile(filename); expect(actual.toString('utf8')).toBe(finalBody);
    await info.attach('q2-final-human-body.txt', { path: filename, contentType: 'text/plain' });
    expect((await json(context, `${Q1_ORIGIN}/__q1/observations`)).calls).toHaveLength(0);
    e.record('final-same-document-delivery', { document: final, writes: writes.map(identity), download: { bytes: actual.length, sha256: digest(actual) }, providerCalls: 0 });
    e.outcome = 'protocol-pass-pending-independent-visual-review';
  } catch (error) { failure = error; throw error; } finally { await e.finish(failure); }
});

test('Q2 deleted document: the minimal pending request remains reachable and closing it never recreates content', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let failure: unknown;
  try {
    const user = await login(page, context, e), title = 'Q2 明确删除后的原请求';
    await fillComposer(page, title, '独立合成删除场景：删除后只核验请求，不恢复正文');
    const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/tasks');
    await composer(page).getByRole('button', { name: '保存任务', exact: true }).click(); const response = await createdResponse; expect(response.status()).toBe(201); const task = await response.json();
    const editor = page.getByTestId('task-result-editor'); await expect(editor).toHaveAttribute('data-task-id', task.id);
    let original: Captured | null = null;
    await page.route(`**/api/tasks/${task.id}/result/versions`, async route => { original = capture(route); await route.abort('connectionreset'); });
    await editor.getByRole('textbox', { name: '文稿正文', exact: true }).fill('这段旧正文在删除后不能通过迟到请求复活');
    await editor.getByRole('button', { name: '保存为新版本', exact: true }).click(); await expect(bodyRecovery(page)).toBeVisible(); await expect.poll(() => !!original).toBe(true);
    await taskCard(page, title).getByRole('button', { name: '删除任务与成果', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除任务', exact: true }); await e.shot('explicit-synthetic-document-deletion', dialog);
    await dialog.getByRole('button', { name: '确认', exact: true }).click(); await expect(taskCard(page, title)).not.toBeVisible();
    expect(await json(context, '/api/tasks')).toHaveLength(0);
    await reload(page, e);
    const orphan = page.getByRole('region', { name: '列表之外的待确认文稿请求', exact: true }); await expect(orphan).toBeVisible();
    await e.shot('minimal-request-reachable-with-no-task-card', orphan); await orphan.getByRole('button', { name: '核对这份文稿的原请求', exact: true }).click();
    await expect(bodyRecovery(page)).toBeVisible(); await expect(page.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveCount(0);
    await confirmClose(page, bodyRecovery(page), e, 'close-deleted-document-original-request');
    await expect(bodyRecovery(page)).not.toBeVisible(); await expect(orphan.getByRole('status')).toContainText('文稿已删除，未恢复旧正文');
    await expect(orphan.getByRole('status')).not.toContainText('当前输入仍在'); await expect(orphan.getByRole('status')).not.toContainText('继续保存'); await e.shot('terminal-orphan-receipt-remains-visible', orphan);
    const captured = original as unknown as Captured;
    const receipt = await json(context, `/api/tasks/${task.id}/result/commands/${captured.key}`); expect(receipt.receipt.status).toBe('cancelled'); expect(receipt.document).toBeNull(); expect(receipt.task_deleted).toBe(true);
    await deliverOriginal(captured, user, 'RESULT_COMMAND_CLOSED', e);
    expect(await json(context, '/api/tasks')).toHaveLength(0); expect((await context.request.get(`/api/tasks/${task.id}/result`)).status()).toBe(404);
    expect((await json(context, `${Q1_ORIGIN}/__q1/observations`)).calls).toHaveLength(0);
    e.record('deleted-object-never-recreated', { original: identity(captured), receipt, taskCount: 0, providerCalls: 0 }); e.outcome = 'protocol-pass-pending-independent-visual-review';
  } catch (error) { failure = error; throw error; } finally { await e.finish(failure); }
});
