import { test, expect, type Page, type BrowserContext, type TestInfo, type Locator } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerSyntheticAccount } from '../authFixture';
import { assertQ1CiRuntime, Q1_ORIGIN, ORIGINAL, CORRECTION, LATER_CORRECTION, PURPOSE, INVITATION } from '../../scripts/q1-fixture-protocol.mjs';

if (!process.argv.includes('--list')) assertQ1CiRuntime();
const BASELINE = '5056661e681665b7c82c25460af3ea6bc9112f4e';
const TREES: Record<string, string> = {
  'frontend/src': '5e5448c92645c3f6b3189efdf1b684100cc3d00b',
  'backend/src': 'e324ad71b3016e09a17beacfcaefbfaba2eb893c',
  shared: '698b4c603b9e42e1a949b65730fda2f8cbf42b6b',
  'frontend/public': 'ed1479156ead8a97946e8ac90addb9e02a1c8ec6',
};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim();
type Json = Record<string, any>;
class Evidence {
  entries: Json[] = []; gaps: Json[] = []; sequence = 0; stage = 'initialization'; outcome = 'running';
  constructor(readonly page: Page, readonly info: TestInfo) {}
  async record(stage: string, data: Json = {}) { this.stage = stage; this.entries.push({ stage, at: new Date().toISOString(), ...data }); }
  gap(id: string, reason: string, blocked: string[] = []) { this.gaps.push({ id, reason, blocked }); }
  async shot(label: string, target?: Locator, clickable = false) {
    if (target) { await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded(); }
    const name = `${String(++this.sequence).padStart(2, '0')}-${label}`;
    const viewport = this.info.outputPath(`${name}-viewport.png`);
    await this.page.screenshot({ path: viewport });
    await this.info.attach(`${name}-viewport`, { path: viewport, contentType: 'image/png' });
    if (target) {
      // Natural frames first: screenshots must never fast-forward/cancel animations.
      await expect.poll(() => target.evaluate(el => { let opacity = 1; for (let node: Element | null = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity); return opacity; }), { timeout: 4000, message: `${label}: natural visible opacity` }).toBeGreaterThan(0.98);
      if (clickable) await target.click({ trial: true });
    }
    const full = this.info.outputPath(`${name}-full.png`);
    await this.page.screenshot({ path: full, fullPage: true });
    await this.info.attach(`${name}-full`, { path: full, contentType: 'image/png' });
  }
  async inventory(scope: Locator) {
    return scope.locator('button, input, textarea, select, a, [contenteditable], [role="textbox"]').evaluateAll(nodes => nodes.map(node => {
      const el = node as HTMLElement, r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { tag: el.tagName, role: el.getAttribute('role'), text: el.innerText || el.getAttribute('aria-label') || el.getAttribute('title'),
        label: 'labels' in el ? Array.from((el as HTMLInputElement).labels || []).map(label => label.textContent?.trim()).join(' | ') : null, type: el.getAttribute('type'), editable: el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.getAttribute('type') || 'text')),
        disabled: el.hasAttribute('disabled'), visible: r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none', href: el.getAttribute('href') };
    }));
  }
  async finish(error?: unknown) {
    if (error && this.outcome === 'running') this.outcome = 'execution-error-requires-triage';
    if (this.outcome === 'running') this.outcome = this.gaps.length ? 'product-gap' : 'partial-protocol-pass';
    const protectedFinal = protectedSnapshot();
    const harnessIntegrityError = protectedFinal.unchanged ? null : 'Protected source/brand bytes or untracked files changed during the test';
    if (harnessIntegrityError && !error) this.outcome = 'harness-isolation-error';
    const metadata = { protectedFinal, harnessIntegrityError, applicationBaseline: BASELINE, applicationTree: '11324c41148214008c54a29195480a440673cd49',
      testedCommit: git('rev-parse', 'HEAD'), testedTree: git('rev-parse', 'HEAD^{tree}'), githubSha: process.env.GITHUB_SHA,
      githubRunId: process.env.GITHUB_RUN_ID, project: this.info.project.name, browserVersion: this.page.context().browser()?.version(),
      os: process.platform, timezone: 'UTC', viewport: this.page.viewportSize(), backendMode: 'development', storage: 'isolated JSON; PostgreSQL/Goal runtime disabled',
      auth: 'dev-only synthetic registration followed by actual UI phone/password login; real SMS and production onboarding untested',
      model: 'deterministic local HTTP fixture; no semantic-quality, production-provider or actual-cost claim',
      outcome: this.outcome, stage: this.stage, gaps: this.gaps, entries: this.entries,
      executionError: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error };
    if (process.env.GITHUB_EVENT_PATH) { const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')); Object.assign(metadata, { pullRequestHead: event.pull_request?.head?.sha }); }
    await this.info.attach('q1-outcome-ledger.json', { body: JSON.stringify(metadata, null, 2), contentType: 'application/json' });
    // Preserve the original UI/product failure when final isolation also fails.
    if (!error) expect(protectedFinal.unchanged, 'Protected application tree must remain frozen through end of run').toBe(true);
  }
}
async function get(context: BrowserContext, path: string) {
  const response = await context.request.get(path); expect(response.ok(), `Read-only corroboration ${path}`).toBe(true); return response.json();
}
async function fixtureCalls(context: BrowserContext, model: string) { return (await get(context, `${Q1_ORIGIN}/__q1/observations`)).calls.filter((call: Json) => call.model === model); }
async function tasks(context: BrowserContext) { return get(context, '/api/tasks') as Promise<Json[]>; }
async function taskById(context: BrowserContext, id: string) { const task = (await tasks(context)).find(t => t.id === id); expect(task, 'Original task still exists').toBeTruthy(); return task!; }
function card(page: Page, title: string) { return page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) }); }
async function workspace(page: Page, info: TestInfo) {
  if (await page.getByTestId('workspace').isVisible()) return;
  if (info.project.name === 'mobile-reduced-motion') { await page.getByRole('button', { name: '返回', exact: true }).click(); await page.getByRole('button', { name: '工作台', exact: true }).click(); }
  else await page.getByRole('button', { name: '返回工作台', exact: true }).click();
  await expect(page.getByTestId('workspace')).toBeVisible();
}
async function openDetails(page: Page, title: string) {
  const target = card(page, title); await expect(target).toBeVisible();
  const opener = target.getByRole('button', { name: /^(打开详情|检查草稿)$/ });
  if (await opener.count()) await opener.click();
  return target;
}
function protectedSnapshot() {
  const paths = [...Object.keys(TREES), '有字logo.txt', '纯logo.txt'];
  const actualTrees = Object.fromEntries(Object.keys(TREES).map(path => [path, git('rev-parse', `HEAD:${path}`)]));
  const changed = git('diff', '--name-only', 'HEAD', '--', ...paths);
  const untracked = git('ls-files', '--others', '--', ...paths);
  let brand = '', brandError = '';
  try { brand = execFileSync('node', ['scripts/verify-brand.mjs'], { encoding: 'utf8', cwd: repoRoot }).trim(); } catch (cause) { brandError = String(cause); }
  return { actualTrees, changed, untracked, brand, brandError, unchanged: Object.entries(TREES).every(([path, hash]) => actualTrees[path] === hash) && !changed && !untracked && !brandError };
}
async function setup(page: Page, context: BrowserContext, info: TestInfo, e: Evidence) {
  const protection = protectedSnapshot(); await e.record('protected-start', protection);
  expect(protection.unchanged).toBe(true);
  const forbiddenRequests: string[] = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && !['http://127.0.0.1:3210', 'http://127.0.0.1:3202'].includes(url.origin)) {
      forbiddenRequests.push(`${route.request().method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  const phone = `138${String(randomInt(10000000, 99999999))}`;
  const user = await registerSyntheticAccount(context, { phone, nickname: 'Q1 合成体验用户' });
  await context.clearCookies(); await page.goto('/');
  await e.record('ui-login-before', { fixtureAccountId: user.id, realSmsOnboarding: 'not-tested' });
  await e.shot('login-before', page.getByPlaceholder('请输入手机号'));
  await page.getByPlaceholder('请输入手机号').fill(phone);
  await page.getByPlaceholder('请输入密码', { exact: true }).fill('Synthetic-Browser-Only-2026');
  await page.locator('form').getByRole('button', { name: '登录', exact: true }).click();
  const work = page.getByTestId('workspace'); await expect(work).toBeVisible();
  await e.shot('first-workspace-after-login', work.getByText('连接你的第一个 AI'));
  const model = `q1-fixture-${randomUUID()}`;
  await work.getByRole('button', { name: '模型中心', exact: true }).click();
  const center = page.getByRole('region', { name: '模型中心', exact: true });
  await center.getByRole('button', { name: '＋ 服务商', exact: true }).click();
  await center.getByLabel('服务商名称', { exact: true }).fill('Q1 本地确定性协议夹具（非真实模型）');
  await center.getByLabel('服务地址（Base URL）', { exact: true }).fill(`${Q1_ORIGIN}/v1`);
  await center.getByRole('checkbox', { name: '无需密钥（如本地模型服务）' }).check();
  await center.getByRole('button', { name: '＋ 手动添加模型', exact: true }).click();
  await center.getByLabel('显示名称', { exact: true }).fill('Q1 合成协议模型');
  await center.getByLabel('模型 ID', { exact: true }).fill(model);
  await e.shot('model-before-save', center.getByRole('button', { name: '保存并应用', exact: true }), true);
  await center.getByRole('button', { name: '保存并应用', exact: true }).click();
  await expect(center.getByText('当前配置已保存', { exact: true })).toBeVisible();
  await expect(center.getByRole('button', { name: '测试对话', exact: true })).toBeEnabled();
  await center.getByRole('button', { name: '测试对话', exact: true }).click();
  await expect(center.getByText(/对话：测试通过/)).toBeVisible();
  await e.record('model-protocol-probe', { model, calls: await fixtureCalls(context, model) });
  await e.shot('model-probe-after', center.getByText(/对话：测试通过/));
  await work.getByRole('button', { name: '工作台', exact: true }).click();
  const scene = work.locator('article').filter({ has: page.getByRole('heading', { name: '一起聊聊', exact: true }) });
  await e.shot('visible-conversation-entry', scene.getByRole('button', { name: '创建会话', exact: true }), true);
  const createResponse = page.waitForResponse(r => r.url().endsWith('/api/groups') && r.request().method() === 'POST');
  await scene.getByRole('button', { name: '创建会话', exact: true }).click();
  const created = await createResponse; expect(created.status()).toBe(201); const group = await created.json();
  const input = page.getByPlaceholder('输入消息，@提及 AI 成员...'); await expect(input).toBeVisible();
  await e.record('conversation-created-through-ui', { group, noHiddenManualMode: true });
  await e.shot('conversation-before-notes', input);
  const messages: Json[] = [];
  for (const note of [ORIGINAL, CORRECTION]) {
    const response = page.waitForResponse(r => r.url().endsWith(`/api/groups/${group.id}/messages`) && r.request().method() === 'POST');
    await input.fill(note); await input.press('Enter');
    const sent = await response; expect(sent.status()).toBe(201); const message = await sent.json(); messages.push(message);
    await expect(page.locator(`[data-message-id="${message.id}"]`)).toContainText(note);
    // Observe normal scheduling without replacing it by a store flag. A fixture
    // responses/silence are recorded from durable messages in a bounded observation window.
    let previousSignature = '', stableSince = Date.now();
    const observationEnds = Date.now() + 12000;
    let normalMessages: Json[] = [];
    while (Date.now() < observationEnds) {
      normalMessages = (await get(context, `/api/groups/${group.id}/messages`)).messages;
      const signature = JSON.stringify(normalMessages.map((m: Json) => [m.id, m.content, m.edited_at]));
      if (signature !== previousSignature) { previousSignature = signature; stableSince = Date.now(); }
      const actualCalls = await fixtureCalls(context, model);
      if (actualCalls.some((call: Json) => call.kind === 'chat' && JSON.stringify(call.body.messages).includes(note)) && Date.now() - stableSince >= 1200) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await e.record('normal-chat-scheduling-observation', { noteId: message.id, messages: normalMessages, observedMillisecondsBound: 12000,
      note: 'Actual replies/silence retained; no requirement of exactly one response and no claim of long-term inactivity.' });
  }
  const visibleMessages = await get(context, `/api/groups/${group.id}/messages`);
  const observedCalls = await fixtureCalls(context, model);
  expect(observedCalls.filter((call: Json) => call.kind === 'probe')).toHaveLength(1);
  expect(observedCalls.filter((call: Json) => call.kind === 'other')).toHaveLength(0);
  await e.record('conversation-notes-and-normal-replies', { messages: visibleMessages.messages, fixtureCalls: observedCalls, group: await get(context, `/api/groups/${group.id}`),
    controls: await e.inventory(page.locator('.glass-header')), forbiddenBrowserRequests: forbiddenRequests });
  await e.shot('conversation-after-notes', page.locator(`[data-message-id="${messages[1].id}"]`));
  expect(forbiddenRequests).toEqual([]);
  return { model, group, messages, user };
}
async function composeFromMessage(page: Page, context: BrowserContext, e: Evidence, origin: Json, title: string, purpose = PURPOSE) {
  const source = page.locator(`[data-message-id="${origin.id}"]`); await source.hover();
  await source.getByTitle('创建任务', { exact: true }).click();
  const work = page.getByTestId('workspace'); await expect(work).toBeVisible();
  await expect(work.getByLabel('希望得到什么')).toHaveValue(origin.content);
  await expect(work.getByLabel('作为依据的会话')).toHaveValue(origin.group_id);
  await work.getByLabel('任务名称', { exact: true }).fill(title);
  await work.getByLabel('希望得到什么').fill(purpose);
  const sourceControls = await e.inventory(work.locator('form'));
  await e.record('source-and-purpose-review', { sourceMessageId: origin.id, sourceEditedAt: origin.edited_at ?? null, purpose, sourceControls,
    observedScope: 'one origin message plus the selected entire conversation; no per-note inclusion/exclusion controls' });
  await e.shot('task-before-save', work.getByRole('button', { name: '保存任务', exact: true }), true);
  return work;
}

test('Q1 product outcome: source conversation to editable invitation and same-draft return', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let error: unknown;
  try {
    const state = await setup(page, context, info, e);
    const title = 'Q1 活动邀请正文';
    const work = await composeFromMessage(page, context, e, state.messages[1], title);
    await e.record('chosen-source-scope', { uiLabel: '作为依据的会话', selectedConversation: state.group.id, meaning: 'Explicit whole-conversation scope; includes the two notes and observed AI replies. Per-note picking is not imposed as an extra Q1 requirement.' });
    const create = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await work.getByRole('button', { name: '保存任务', exact: true }).click();
    const createResponse = await create; expect(createResponse.status()).toBe(201); const task = await createResponse.json();
    expect(task.source_message_id).toBe(state.messages[1].id); expect(task.source_message_edited_at).toBe(state.messages[1].edited_at ?? null);
    expect(task.group_id).toBe(state.group.id); expect(task.prompt).toBe(PURPOSE);
    const target = await openDetails(page, title);
    await e.shot('saved-task-before-generation', target.getByRole('button', { name: '生成草稿', exact: true }), true);
    const runResponse = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}/run`) && r.request().method() === 'POST');
    await target.getByRole('button', { name: '生成草稿', exact: true }).click();
    const response = await runResponse; expect(response.status()).toBe(200); const generated = await response.json();
    await expect(target.locator('.workspace-result')).toContainText('Dear colleagues');
    expect(generated.result).toBe(INVITATION); expect(generated.status).toBe('needs_review');
    const calls = (await fixtureCalls(context, state.model)).filter((call: Json) => call.kind === 'task');
    expect(calls).toHaveLength(1); expect(calls[0].hasOriginal).toBe(true); expect(calls[0].hasCorrection).toBe(true); expect(calls[0].hasPurpose).toBe(true);
    for (const source of state.messages) expect(generated.source_messages).toContainEqual({ id: source.id, revision: source.revision ?? null, edited_at: source.edited_at ?? null });
    expect(generated.history[0].context_audit.omitted).toBe(0);
    await e.record('source-provenance-boundary', { providerIdsAndRevisions: 'not included in provider text', persistedSourceRevisions: generated.source_messages, visibleSourceAccess: 'conversation link and fixture-preserved URLs; no claim of exact generated-claim-to-message revision lineage' });
    await e.record('actual-generated-body-and-context', { task: generated, fixtureCalls: calls, modelSemanticQuality: 'not-tested; body is predetermined',
      requestedSources: state.messages.map(m => m.id), actualIncludedSourceIds: generated.source_messages.map((m: Json) => m.id) });
    await info.attach('actual-invitation-body.txt', { body: generated.result, contentType: 'text/plain' });
    await e.shot('actual-invitation-body', target.locator('.workspace-result'));
    const resultControls = await e.inventory(target.locator('.workspace-result'));
    const editable = resultControls.filter((control: Json) => control.visible && control.editable);
    await e.record('actual-result-control-inventory', { resultControls, editable });
    if (!editable.length) e.gap('editable-invitation-missing', 'The actual generated body has copy and accept controls but no rendered body editor.',
      ['manual-body-edit', 'manual-edit-preservation', 'accept-exact-manually-edited-version', 'source-impact-on-manually-edited-version', 'reopen-and-continue-same-manually-edited-draft']);
    else throw new Error('Frozen-baseline unexpected editable control: reviewer must update the scenario before claiming edit coverage');
    await e.shot('precise-editor-breakpoint', target.getByRole('button', { name: '复制文本', exact: true }), true);
    await target.getByRole('button', { name: '复制文本', exact: true }).click();
    await expect(target.getByRole('button', { name: '已复制 ✓', exact: true })).toBeVisible();
    const clipboardPermission = await page.evaluate(async () => { try { return (await navigator.permissions.query({ name: 'clipboard-read' as PermissionName })).state; } catch { return 'unsupported'; } });
    let copied: string | null = null; if (clipboardPermission === 'granted') copied = await page.evaluate(() => navigator.clipboard.readText());
    if (copied !== null) expect(copied).toBe(INVITATION);
    await e.record('partial-copy', { permission: clipboardPermission, clipboardReadVerified: copied !== null, note: 'No additional browser permission was granted; copy UI acknowledgment alone is not clipboard readback proof.' });
    // Separate, explicitly partial exploration: accepting the unedited fixture
    // run cannot satisfy the blocked manually edited-version requirement.
    const accept = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}/accept`));
    await target.getByRole('button', { name: '确认此稿成果', exact: true }).click();
    const acceptedResponse = await accept; expect(acceptedResponse.status()).toBe(200); const accepted = await acceptedResponse.json();
    expect(accepted.accepted_run_id).toBe(generated.run_id); expect(accepted.result).toBe(generated.result);
    await expect(target.locator('.workspace-result')).toContainText('已确认的文字成果');
    await e.record('partial-accept-unedited-run', { request: acceptedResponse.request().postDataJSON(), task: accepted, q1EditedVersionAcceptance: 'blocked' });
    await e.shot('partial-unedited-run-accepted', target.locator('.workspace-result'));
    await target.getByRole('button', { name: '打开来源会话 →', exact: true }).click();
    const source = page.locator(`[data-message-id="${state.messages[1].id}"]`); await expect(source).toBeVisible(); await source.hover();
    await source.getByTitle('编辑', { exact: true }).click(); await source.locator('textarea').fill(LATER_CORRECTION);
    await e.shot('source-edit-before-save', source.getByRole('button', { name: '保存', exact: true }), true);
    const change = page.waitForResponse(r => r.url().endsWith(`/api/messages/${state.messages[1].id}`) && r.request().method() === 'PUT');
    await source.getByRole('button', { name: '保存', exact: true }).click(); const changed = await change; expect(changed.status()).toBe(200);
    await expect(source).toContainText('2026-10-22');
    await workspace(page, info); const staleCard = await openDetails(page, title);
    await expect(staleCard).toContainText('创建此任务的原始消息已被更改或撤回');
    await expect(staleCard.getByRole('button', { name: '重新生成', exact: true })).toBeDisabled();
    const stale = await taskById(context, task.id);
    expect(stale.id).toBe(task.id); expect(stale.run_id).toBe(generated.run_id); expect(stale.accepted_run_id).toBe(generated.run_id);
    expect(stale.source_input_stale).toBe(true); expect(stale.source_stale).toBe(true);
    await e.record('partial-same-task-after-source-edit', { changedSource: await changed.json(), task: stale, controls: await e.inventory(staleCard) });
    e.gap('same-draft-source-recovery', 'Editing the linked origin disables regeneration and tells the user to create another task; current result/history bodies are withheld rather than allowing this draft to be revised.');
    await e.shot('same-task-source-change-breakpoint', staleCard);
    await page.reload(); const reopened = await openDetails(page, title); const persisted = await taskById(context, task.id);
    expect(persisted.run_id).toBe(generated.run_id); expect(persisted.source_input_stale).toBe(true); expect((await tasks(context)).filter(t => t.title === title)).toHaveLength(1);
    await expect(reopened.getByRole('button', { name: '重新生成', exact: true })).toBeDisabled();
    const finalCalls = await fixtureCalls(context, state.model);
    expect(finalCalls.filter((call: Json) => call.kind === 'task')).toHaveLength(1);
    await e.record('partial-reopen-same-task', { task: persisted, fixtureCalls: finalCalls, sameTaskId: task.id, sameRunId: generated.run_id, editedDraftContinuation: 'blocked' });
    await e.shot('reopened-same-task-still-blocked', reopened);
    e.outcome = 'product-gap';
    expect(e.gaps, 'Q1 PRODUCT GAP: inspect q1-outcome-ledger.json; partial protocol paths are not product completion').toEqual([]);
  } catch (cause) { error = cause; throw cause; }
  finally { await e.finish(error); }
});

test('Q1 partial fault evidence: lost save ACK, reload, dispatched cancellation and late receipt', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let error: unknown; let model = '';
  try {
    const state = await setup(page, context, info, e); model = state.model;
    const title = 'Q1 断回执和停止路径';
    const work = await composeFromMessage(page, context, e, state.messages[1], title, `${PURPOSE}\nQ1-CANCEL-AFTER-DISPATCH`);
    const createIntents: Json[] = []; let saved: Json | null = null;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      createIntents.push({ key: route.request().headers()['idempotency-key'], payload: route.request().postDataJSON() });
      const response = await route.fetch(); expect(response.status()).toBe(201); saved = await response.json();
      await route.abort('connectionreset');
    });
    await work.getByRole('button', { name: '保存任务', exact: true }).click();
    await expect(work.getByRole('button', { name: '核验并重试保存', exact: true })).toBeVisible();
    await expect(work.getByLabel('希望得到什么')).toBeDisabled();
    await e.record('save-committed-ack-lost', { createIntents, savedTask: saved });
    await e.shot('lost-ack-before-reload', work.getByRole('button', { name: '核验并重试保存', exact: true }), true);
    expect(saved).toBeTruthy(); const savedId = (saved as unknown as Json).id;
    const reloadDialog = async (dialog: import('@playwright/test').Dialog) => {
      const expected = dialog.type() === 'beforeunload';
      await e.record('reload-dialog', { type: dialog.type(), message: dialog.message(), action: expected ? 'accept-intended-reload' : 'dismiss-unexpected-dialog' });
      if (expected) await dialog.accept(); else await dialog.dismiss();
    };
    page.once('dialog', reloadDialog);
    try { await page.reload(); } finally { page.off('dialog', reloadDialog); }
    const target = await openDetails(page, title); const recovered = await taskById(context, savedId);
    expect(recovered.client_request_id).toBe(createIntents[0].key); expect(recovered.prompt).toBe(createIntents[0].payload.prompt);
    expect((await tasks(context)).filter(t => t.title === title)).toHaveLength(1); expect(createIntents).toHaveLength(1);
    await e.record('reload-recovers-same-saved-task', { task: recovered, originalIntent: createIntents[0],
      recoveryBoundary: 'Saved server task is discoverable. The tab-local uncertain-create banner/intent is no longer shown; pre-admission or server-unavailable reload is not covered.' });
    await e.shot('same-save-recovered-after-reload', target);
    const runKeys: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/api/tasks/${savedId}/run`)) runKeys.push(request.headers()['idempotency-key']); });
    await target.getByRole('button', { name: '生成草稿', exact: true }).click();
    await expect.poll(async () => (await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task' && call.hold).length).toBe(1);
    const running = await taskById(context, savedId); expect(running.status).toBe('running'); expect(running.dispatch_status).toBe('sent_or_unknown');
    await e.record('actual-http-arrival-before-stop', { task: running, fixtureCalls: await fixtureCalls(context, model), runKeys });
    await e.shot('http-dispatched-awaiting-response', target.getByRole('button', { name: '停止生成', exact: true }), true);
    await target.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(target.getByRole('button', { name: '已核验，允许重试', exact: true })).toBeVisible();
    const cancelled = await taskById(context, savedId); expect(cancelled.status).toBe('outcome_unknown'); expect(cancelled.run_id).toBe(running.run_id);
    await e.record('cancel-after-dispatch', { task: cancelled });
    await e.shot('stopped-but-outcome-unknown', target.getByRole('button', { name: '已核验，允许重试', exact: true }), true);
    const release = await context.request.post(`${Q1_ORIGIN}/__q1/release?model=${encodeURIComponent(model)}`); expect(release.ok()).toBe(true);
    await expect.poll(async () => (await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task' && call.releasedAt).length).toBe(1);
    await e.record('late-provider-receipt-released', { release: await release.json(), calls: await fixtureCalls(context, model),
      limitation: 'If the HTTP socket was already aborted, evidence is a late response attempt after processing, not proof the client received a late ACK.' });
    await page.reload(); const reopened = await openDetails(page, title); const unknown = await taskById(context, savedId);
    expect(unknown.status).toBe('outcome_unknown'); expect(unknown.run_id).toBe(running.run_id); expect(unknown.result_pending_review).toBe(false);
    expect(runKeys).toHaveLength(1); expect((await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task')).toHaveLength(1);
    await e.shot('same-unknown-run-after-reload', reopened);
    const resolve = reopened.getByRole('button', { name: '已核验，允许重试', exact: true }); await resolve.click();
    const dialog = page.getByRole('dialog', { name: '记录核验并允许重试', exact: true }); await expect(dialog).toBeVisible();
    await e.shot('review-dialog-before-dismissal', dialog.getByRole('button', { name: '取消', exact: true }), true);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await expect(resolve).toBeFocused();
    expect((await taskById(context, savedId)).status).toBe('outcome_unknown');
    await e.record('dismissal-keeps-same-unknown-run', { task: await taskById(context, savedId), focused: await resolve.evaluate(el => el === document.activeElement), fixtureCalls: await fixtureCalls(context, model), q1Completion: 'not-claimed' });
    await e.shot('dismissed-without-new-call', resolve, true);
    e.outcome = 'partial-protocol-pass';
  } catch (cause) { error = cause; throw cause; }
  finally {
    if (model) await context.request.post(`${Q1_ORIGIN}/__q1/release?model=${encodeURIComponent(model)}`).catch(() => {});
    await e.finish(error);
  }
});
