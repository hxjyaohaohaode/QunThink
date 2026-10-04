import { test, expect, type Page, type BrowserContext, type TestInfo, type Locator } from '@playwright/test';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { registerSyntheticAccount } from '../authFixture';
import { pickWorkspaceNavigationState, CONTEXT_DISCLOSURE } from '../../scripts/q1-navigation.mjs';
import { assertQ1CiRuntime, Q1_ORIGIN, ORIGINAL, CORRECTION, LATER_CORRECTION, PURPOSE, INVITATION, messageBubbleSelector, observeNewChatCalls } from '../../scripts/q1-fixture-protocol.mjs';

if (!process.argv.includes('--list')) assertQ1CiRuntime();
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', cwd: repoRoot }).trim();
const BASELINE = git('rev-parse', 'HEAD');
// Snapshot the tested commit, not the historical no-editor application's tree.
// Start/end gates still reject modified or untracked production/brand bytes.
const TREES = Object.fromEntries(['frontend/src', 'backend/src', 'shared', 'frontend/public'].map(path => [path, git('rev-parse', `HEAD:${path}`)]));
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
      const visualState = await target.evaluate(el => {
        let cumulativeOpacity = 1;
        const ancestors = [];
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          cumulativeOpacity *= Number(style.opacity);
          const bounds = node.getBoundingClientRect();
          ancestors.push({ tag: node.tagName, className: node.getAttribute('class'), opacity: style.opacity, visibility: style.visibility, rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
        }
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const identify = (node: Element | null) => node ? { tag: node.tagName, id: node.id, className: node.getAttribute('class'), role: node.getAttribute('role') } : null;
        return { cumulativeOpacity, ancestors, activeElement: identify(document.activeElement), centerHitElement: identify(hit), centerHitTarget: hit === el || !!hit && el.contains(hit), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      });
      this.entries.push({ stage: 'natural-screenshot-observation', at: new Date().toISOString(), label, visualState,
        interpretation: 'Observed opacity/geometry, not a visibility pass. Review natural pixels/video; do not impose a generic fully-opaque threshold on every design.' });
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
    const metadata = { protectedFinal, harnessIntegrityError, applicationBaseline: BASELINE, applicationTree: git('rev-parse', 'HEAD^{tree}'), historicalNoEditorBaseline: '5056661e681665b7c82c25460af3ea6bc9112f4e',
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
  const response = await context.request.get(path); expect(response.ok(), `Read-only corroboration ${path}: HTTP ${response.status()}`).toBe(true); return response.json();
}
async function fixtureCalls(context: BrowserContext, model: string) { return (await get(context, `${Q1_ORIGIN}/__q1/observations`)).calls.filter((call: Json) => call.model === model); }
async function tasks(context: BrowserContext) { return get(context, '/api/tasks') as Promise<Json[]>; }
async function taskById(context: BrowserContext, id: string) { const task = (await tasks(context)).find(t => t.id === id); expect(task, 'Original task still exists').toBeTruthy(); return task!; }
// Both MessageList and MessageBubble expose data-message-id. Select the actual
// .group MessageBubble (MessageBubble.tsx), never an arbitrary first match.
function messageBubble(page: Page, id: string) { return page.locator(messageBubbleSelector(id)); }
function card(page: Page, title: string) { return page.locator('[data-observe="task-card"]').filter({ has: page.getByRole('heading', { name: title, exact: true }) }); }
async function workspace(page: Page, info: TestInfo, e: Evidence) {
  const mobile = info.project.name === 'mobile-reduced-motion';
  const controls = {
    workspace: page.getByTestId('workspace'),
    writingClose: page.getByRole('button', { name: '收起文稿，返回对话', exact: true }),
    mobileWorkspace: page.getByRole('button', { name: '⌘ 工作台', exact: true }),
    mobileBack: page.getByRole('button', { name: '返回', exact: true }),
    desktopBack: page.getByRole('button', { name: '返回工作台', exact: true })
  };
  const started = Date.now(), observations: Json[] = [];
  try {
  for (let step = 0; step < 4; step++) {
    let next = 'waiting';
    await expect.poll(async () => {
      const visible = Object.fromEntries(await Promise.all(Object.entries(controls).map(async ([name, locator]) => [name, await locator.isVisible()])));
      next = pickWorkspaceNavigationState(visible, mobile);
      observations.push({ elapsedMs: Date.now() - started, visible, next });
      return next;
    }, { timeout: 20000, intervals: [100, 250, 500], message: 'Observe a known authenticated workspace/chat navigation state; do not infer Back from an unready workspace' }).not.toBe('waiting');
    if (next === 'workspace') {
      await e.record('workspace-navigation-observed', { observations, elapsedMs: Date.now() - started, meaning: 'Readiness observation only, not an acceptable user waiting-time verdict' });
      await e.shot('workspace-ready-for-original-draft', controls.workspace); return;
    }
    if (next === 'close-writing') { await controls.writingClose.click({ timeout: 20000 }); await expect(controls.writingClose).not.toBeVisible(); }
    else if (next === 'mobile-home') { await controls.mobileWorkspace.click({ timeout: 20000 }); await expect(controls.workspace).toBeVisible({ timeout: 20000 }); }
    else if (next === 'mobile-chat') { await controls.mobileBack.click({ timeout: 20000 }); await expect(controls.mobileWorkspace).toBeVisible({ timeout: 20000 }); }
    else if (next === 'desktop-chat') { await controls.desktopBack.click({ timeout: 20000 }); await expect(controls.workspace).toBeVisible({ timeout: 20000 }); }
  }
  throw new Error('Actual workspace navigation did not settle after the known visible steps');
  } catch (error) {
    await e.record('workspace-navigation-blocked', { observations, elapsedMs: Date.now() - started });
    await e.shot('workspace-navigation-unresolved');
    throw error;
  }
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
// This gate is specific to LoginPage's finite form entry animation. It does
// not classify disabled/semitransparent components elsewhere as invisible.
async function waitForLoginForm(page: Page, e: Evidence) {
  const input = page.getByPlaceholder('请输入手机号');
  const handle = await input.elementHandle();
  expect(handle, 'Phone field exists after the initial natural frame').toBeTruthy();
  const started = Date.now(); const observations: Json[] = []; let failure: unknown;
  try {
    await expect.poll(async () => {
      const state = await handle!.evaluate(el => {
        let opacity = 1, shown = true;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = getComputedStyle(node); opacity *= Number(style.opacity);
          shown = shown && style.display !== 'none' && style.visibility !== 'hidden';
        }
        const r = el.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left));
        const visibleHeight = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
        const visibleArea = r.width * r.height > 0 ? visibleWidth * visibleHeight / (r.width * r.height) : 0;
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const centerHit = hit === el || !!hit && el.contains(hit);
        return { opacity, shown, visibleArea, centerHit, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
      });
      observations.push({ elapsedMs: Date.now() - started, ...state });
      return state.opacity >= 0.999 && state.shown && state.visibleArea >= 0.99 && state.centerHit;
    }, { timeout: 20000, intervals: [100, 250, 500], message: 'Login form must finish its existing entry before real input; 20s is only the CI observation ceiling' }).toBe(true);
  } catch (cause) { failure = cause; }
  await e.record('login-specific-visual-readiness', { elapsedMs: Date.now() - started, observations, ready: !failure, failureReason: failure instanceof Error ? failure.message : null,
    interpretation: 'A successful gate permits input; it is not an acceptable-speed or reduced-motion usability verdict. Review initial/ready pixels and video timing.' });
  await e.shot(failure ? 'login-still-not-ready' : 'login-ready-before-input', failure ? undefined : input);
  if (failure) throw failure;
}

async function setup(page: Page, context: BrowserContext, info: TestInfo, e: Evidence, withModel = true) {
  const providerCallCountAtStart = (await get(context, `${Q1_ORIGIN}/__q1/observations`)).calls.length;
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
  await waitForLoginForm(page, e);
  await page.getByPlaceholder('请输入手机号').fill(phone);
  await page.getByPlaceholder('请输入密码', { exact: true }).fill('Synthetic-Browser-Only-2026');
  await page.locator('form').getByRole('button', { name: '登录', exact: true }).click();
  const work = page.getByTestId('workspace'); await expect(work).toBeVisible();
  await e.shot('first-workspace-after-login', work);
  const model = `q1-fixture-${randomUUID()}`;
  if (withModel) {
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
  }
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
    const knownCallIds = (await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'chat').map((call: Json) => call.id);
    const response = page.waitForResponse(r => r.url().endsWith(`/api/groups/${group.id}/messages`) && r.request().method() === 'POST');
    await input.fill(note); await input.press('Enter');
    const sent = await response; expect(sent.status()).toBe(201); const message = await sent.json(); messages.push(message);
    await expect(messageBubble(page, message.id)).toContainText(note);
    // The fixture endpoint is observed at most four times, one second apart.
    // Message API receives one corroborating read per note, not a polling loop.
    const actualCalls = withModel ? await observeNewChatCalls(() => fixtureCalls(context, model), knownCallIds) : [];
    const normalMessages = (await get(context, `/api/groups/${group.id}/messages`)).messages;
    await e.record('normal-chat-scheduling-observation', { noteId: message.id, userEnteredText: note, storedReceiptText: message.content,
      storedTextExactlyMatchesInput: message.content === note, messages: normalMessages, fixtureCalls: actualCalls,
      sampling: 'At most four local fixture reads with 1000ms intervals, followed by one message API read',
      note: 'Actual replies/silence retained; provider arrival does not prove durable reply completion, exact one-response behavior, or long-term inactivity.' });
  }
  const visibleMessages = await get(context, `/api/groups/${group.id}/messages`);
  const observedCalls = await fixtureCalls(context, model);
  expect(observedCalls.filter((call: Json) => call.kind === 'probe')).toHaveLength(withModel ? 1 : 0);
  expect(observedCalls.filter((call: Json) => call.kind === 'other')).toHaveLength(0);
  await e.record('conversation-notes-and-normal-replies', { messages: visibleMessages.messages, fixtureCalls: observedCalls, group: await get(context, `/api/groups/${group.id}`),
    controls: await e.inventory(page.locator('.glass-header')), forbiddenBrowserRequests: forbiddenRequests });
  await e.shot('conversation-after-notes', messageBubble(page, messages[1].id));
  expect(forbiddenRequests).toEqual([]);
  return { model, group, messages, user, providerCallCountAtStart };
}
async function composeFromMessage(page: Page, context: BrowserContext, e: Evidence, origin: Json, title: string, purpose = PURPOSE) {
  const source = messageBubble(page, origin.id); await source.hover();
  await source.getByRole('button', { name: '写成文稿 ↗', exact: true }).click();
  const panel = page.locator('aside.writing-panel'); await expect(panel).toBeVisible();
  await expect(panel.getByText('从这条消息开始', { exact: true })).toBeVisible();
  await panel.getByLabel('文稿名称', { exact: true }).fill(title);
  await panel.getByLabel('用途与检查要求', { exact: true }).fill(purpose);
  await e.record('source-and-purpose-review', { sourceMessageId: origin.id, sourceEditedAt: origin.edited_at ?? null, purpose, sourceControls: await e.inventory(panel), observedScope: 'Originating message plus visible recent40-message conversation scope' });
  await e.shot('same-conversation-before-save', panel.getByRole('button', { name: '保存用途，开始写正文', exact: true }), true);
  return panel;
}
async function reloadWithEvidence(page: Page, e: Evidence) {
  const handler = async (dialog: import('@playwright/test').Dialog) => {
    await e.record('intended-reload-dialog', { type: dialog.type(), message: dialog.message() });
    if (dialog.type() === 'beforeunload') await dialog.accept(); else await dialog.dismiss();
  };
  page.on('dialog', handler);
  try { await page.reload(); } finally { page.off('dialog', handler); }
}
async function reopenInConversation(page: Page, info: TestInfo, title: string, e: Evidence) {
  await workspace(page, info, e);
  const target = await openDetails(page, title);
  await target.getByRole('button', { name: '打开来源会话 →', exact: true }).click();
  const editor = page.getByTestId('task-result-editor'); await expect(editor).toBeVisible(); return editor;
}
const currentVersion = (document: Json) => document.versions.find((version: Json) => version.id === document.head_version_id);
async function saveVersion(page: Page, editor: Locator, id: string) {
  const response = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${id}/result/versions`) && r.request().method() === 'POST');
  await editor.getByRole('button', { name: /^(保存为新版本|保存复核后的新版本)$/ }).click();
  const saved = await response; expect(saved.status()).toBe(200); return saved.json();
}

test('Q1 complete result protocol: same invitation, human revision, exact acceptance, changed source and reopen', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let error: unknown;
  try {
    const state = await setup(page, context, info, e), title = 'Q1 可继续编辑的活动邀请';
    const source = messageBubble(page, state.messages[1].id); await source.hover();
    await source.getByRole('button', { name: '写成文稿 ↗', exact: true }).click();
    const panel = page.getByRole(info.project.name === 'mobile-reduced-motion' ? 'dialog' : 'complementary', { name: '会话文稿', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByLabel('文稿名称', { exact: true }).fill(title);
    await panel.getByLabel('用途与检查要求', { exact: true }).fill(PURPOSE);
    await e.record('actual-conversation-writing-entry', { source: state.messages[1].id, controls: await e.inventory(panel), scope: 'Visible recent conversation, up to40 messages, with originating message bound' });
    await e.shot('same-conversation-purpose-before-save', panel.getByRole('button', { name: '保存用途，开始写正文', exact: true }), true);
    const createResponse = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await panel.getByRole('button', { name: '保存用途，开始写正文', exact: true }).click();
    const created = await createResponse; expect(created.status()).toBe(201); const task = await created.json();
    expect(task.source_message_id).toBe(state.messages[1].id); expect(task.group_id).toBe(state.group.id); expect(task.prompt).toBe(PURPOSE);
    let editor = panel.getByTestId('task-result-editor');
    await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toBeVisible();
    await e.shot('empty-real-body-editor-before-generation', editor.getByRole('textbox', { name: '文稿正文', exact: true }));
    await editor.getByRole('button', { name: '让 AI 提供候选稿', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '让 AI 提供一个候选稿？', exact: true });
    await e.shot('candidate-provider-consent', confirm.getByRole('button', { name: '确认', exact: true }), true);
    const runResponse = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}/run`) && r.request().method() === 'POST');
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    const generatedResponse = await runResponse; expect(generatedResponse.status()).toBe(200); const generated = await generatedResponse.json();
    await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(INVITATION);
    const calls = (await fixtureCalls(context, state.model)).filter((call: Json) => call.kind === 'task'); expect(calls).toHaveLength(1); expect(calls[0].hasPurpose).toBe(true);
    const providerTexts = calls[0].body.messages.map((message: Json) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
    for (const note of state.messages) { expect(providerTexts.some((text: string) => text.includes(note.content))).toBe(true); expect(generated.source_messages).toContainEqual({ id: note.id, revision: note.revision ?? null, edited_at: note.edited_at ?? null }); }
    await e.record('actual-provider-body-and-source-receipts', { calls, generated, userInputs: [ORIGINAL, CORRECTION], storedReceipts: state.messages, semanticQuality: 'not-tested, deterministic fixture' });
    await editor.getByRole('button', { name: '全文预览', exact: true }).click();
    const full = editor.getByRole('region', { name: '文稿全文预览', exact: true });
    await expect(full).toContainText('Dear colleagues'); await expect(full).toContainText('Sources:');
    await expect(full.getByRole('button', { name: /展开全文/ })).toHaveCount(0);
    await e.shot('actual-invitation-full-preview', full);
    await e.shot('actual-invitation-final-sources-visible', full.locator('p').filter({ hasText: /^Sources:/ }));
    await editor.getByRole('button', { name: '编辑正文', exact: true }).click();
    const humanSentence = 'Human revision: Please bring one well-used object and share its story.';
    const humanBody = INVITATION.replace('Thank you for considering the invitation.', humanSentence);
    await editor.getByRole('textbox', { name: '文稿正文', exact: true }).fill(humanBody);
    await e.shot('manual-sentence-before-save', editor.getByRole('textbox', { name: '文稿正文', exact: true }));
    const saved = await saveVersion(page, editor, task.id); const manual = currentVersion(saved.document);
    expect(manual.content).toBe(humanBody); expect(manual.kind).toBe('manual'); expect(manual.content_hash).toBe(createHash('sha256').update(humanBody).digest('hex'));
    await e.record('manual-version-saved', { response: saved, manualSentence: humanSentence });
    await reloadWithEvidence(page, e); editor = await reopenInConversation(page, info, title, e);
    await expect(editor).toHaveAttribute('data-task-id', task.id); await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(humanBody);
    await e.shot('same-manual-body-after-reload', editor.getByRole('textbox', { name: '文稿正文', exact: true }));
    const accepting = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}/result/accept`) && r.request().method() === 'POST');
    await editor.getByRole('button', { name: `验收版本 ${manual.sequence}`, exact: true }).click();
    const acceptedResponse = await accepting; expect(acceptedResponse.status()).toBe(200); const accepted = await acceptedResponse.json();
    expect(acceptedResponse.request().postDataJSON().version_id).toBe(manual.id); expect(acceptedResponse.request().postDataJSON().content_hash).toBe(manual.content_hash);
    expect(accepted.document.accepted_version_id).toBe(manual.id); expect(accepted.document.accepted_content_hash).toBe(manual.content_hash);
    await e.record('exact-human-version-accepted', { request: acceptedResponse.request().postDataJSON(), response: accepted });
    await e.shot('specific-human-version-accepted', editor.getByRole('button', { name: `已验收版本 ${manual.sequence}`, exact: true }));
    await page.getByRole('button', { name: '收起文稿，返回对话', exact: true }).click();
    await workspace(page, info, e); await page.getByRole('button', { name: '已确认文稿', exact: true }).click();
    await expect(card(page, title)).toBeVisible();
    const acceptedSummary = await taskById(context, task.id);
    expect(acceptedSummary.accepted_run_id).toBeNull(); expect(acceptedSummary.result_head_version_id).toBe(manual.id); expect(acceptedSummary.result_accepted_version_id).toBe(manual.id);
    await e.record('accepted-manual-result-found-through-visible-filter', { task: acceptedSummary });
    await e.shot('accepted-manual-result-in-workspace-filter', card(page, title));
    const acceptedCard = await openDetails(page, title); await acceptedCard.getByRole('button', { name: '打开来源会话 →', exact: true }).click();
    editor = page.getByTestId('task-result-editor'); await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(humanBody);
    await page.getByRole('button', { name: '收起文稿，返回对话', exact: true }).click();
    const originalSource = messageBubble(page, state.messages[1].id); await originalSource.hover();
    await originalSource.getByLabel('更多消息操作', { exact: true }).click();
    await originalSource.getByTitle('编辑', { exact: true }).click(); await originalSource.locator('textarea').fill(LATER_CORRECTION);
    await e.shot('real-source-22-before-save', originalSource.getByRole('button', { name: '保存', exact: true }), true);
    const changing = page.waitForResponse(r => r.url().endsWith(`/api/messages/${state.messages[1].id}`) && r.request().method() === 'PUT');
    await originalSource.getByRole('button', { name: '保存', exact: true }).click(); const changed = await changing; expect(changed.status()).toBe(200);
    await page.getByRole('button', { name: '打开会话文稿', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(title) }).click();
    editor = page.getByTestId('task-result-editor'); await expect(editor).toContainText('需要复核');
    await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(humanBody);
    const sourceDetails = editor.locator('details.writing-context'); if (!await sourceDetails.getAttribute('open').then(value => value !== null)) await sourceDetails.locator(CONTEXT_DISCLOSURE).click();
    const changedMaterial = sourceDetails.locator(`[data-source-id="${state.messages[1].id}"]`);
    await changedMaterial.getByText('查看这条材料全文', { exact: true }).click();
    await expect(changedMaterial.locator('.writing-source-body')).toHaveAttribute('open', '');
    await expect(changedMaterial).toContainText('2026-10-22'); await expect(changedMaterial).toContainText('已修改');
    await expect(changedMaterial).toContainText('https://example.invalid/q1/correction');
    await e.shot('source-change-with-human-body-preserved', changedMaterial);
    const history = editor.locator('details.writing-history'); await history.locator(':scope > summary').click();
    const oldManual = history.locator('li').filter({ has: page.getByText(`版本 ${manual.sequence}`, { exact: true }) });
    await oldManual.getByText('展开完整版本', { exact: true }).click(); await expect(oldManual).toContainText(humanSentence); await expect(oldManual).toContainText('曾验收');
    await e.shot('old-accepted-manual-version-still-readable', oldManual);
    await e.shot('old-accepted-human-sentence-visible', oldManual.getByText(humanSentence));
    await editor.getByRole('checkbox', { name: '我已核对上面这组材料，保存时记录此次来源复核', exact: true }).check();
    const reviewedBody = humanBody.replaceAll('20 October 2026', '22 October 2026');
    await editor.getByRole('textbox', { name: '文稿正文', exact: true }).fill(reviewedBody);
    const reviewed = await saveVersion(page, editor, task.id);
    expect(currentVersion(reviewed.document).content).toBe(reviewedBody); expect(reviewed.document.source.status).toBe('current');
    expect(reviewed.document.accepted_version_id).toBe(manual.id); expect(currentVersion(reviewed.document).id).not.toBe(manual.id);
    expect(reviewed.document.versions.find((version: Json) => version.id === manual.id).content).toBe(humanBody);
    const reviewedSummary = await taskById(context, task.id);
    expect(reviewedSummary.source_stale).toBe(false); expect(reviewedSummary.source_input_stale).toBe(true); expect(reviewedSummary.result).toBe(reviewedBody);
    await e.record('current-human-body-and-old-generation-brief-separated', { task: reviewedSummary, documentSource: reviewed.document.source });
    await e.record('explicit-source-review-new-version', { changedSource: await changed.json(), response: reviewed, originalTaskId: task.id });
    await editor.getByRole('button', { name: '复制全文', exact: true }).click();
    await expect(editor.locator('.writing-feedback')).toContainText(/已复制当前全文|浏览器未允许自动复制/);
    await e.record('copy-natural-browser-result', { visibleFeedback: await editor.locator('.writing-feedback').innerText(), permissionGrantedByHarness: false });
    await editor.getByRole('button', { name: '选择全文', exact: true }).click();
    await expect.poll(() => editor.getByRole('textbox', { name: '文稿正文', exact: true }).evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe(reviewedBody);
    const downloading = page.waitForEvent('download'); await editor.getByRole('button', { name: '下载文本', exact: true }).click();
    const download = await downloading, downloadPath = await download.path(); expect(downloadPath).toBeTruthy(); expect(await readFile(downloadPath!, 'utf8')).toBe(reviewedBody);
    await info.attach('actual-human-invitation-download.txt', { path: downloadPath!, contentType: 'text/plain' });
    await e.record('actual-delivery-fallback', { suggestedFilename: download.suggestedFilename(), bodyHash: createHash('sha256').update(reviewedBody).digest('hex'), selectionExact: true, downloadExact: true });
    await e.shot('usable-copy-selection-download-feedback', editor.getByRole('button', { name: '下载文本', exact: true }));
    await reloadWithEvidence(page, e); await workspace(page, info, e);
    await expect(card(page, title).locator('.workspace-status')).not.toContainText('来源已变化');
    await e.shot('final-workspace-body-current-and-generation-brief-separate', card(page, title));
    editor = await reopenInConversation(page, info, title, e);
    await expect(editor).toHaveAttribute('data-task-id', task.id); await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(reviewedBody);
    expect((await tasks(context)).filter(item => item.title === title)).toHaveLength(1);
    expect((await fixtureCalls(context, state.model)).filter((call: Json) => call.kind === 'task')).toHaveLength(1);
    await e.record('same-draft-reopened-and-continuable', { document: await get(context, `/api/tasks/${task.id}/result`), sameTaskId: task.id, humanSentence, modelSemanticQuality: 'not-tested' });
    await e.shot('final-same-draft-result', editor.getByRole('textbox', { name: '文稿正文', exact: true }));
    e.outcome = 'q1-result-chain-protocol-pass-pending-independent-visual-review';
  } catch (cause) { error = cause; throw cause; }
  finally { await e.finish(error); }
});

test('Q1 writing before model setup: committed body ACK lost, reload and same command recovery', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let error: unknown;
  try {
    const state = await setup(page, context, info, e, false), title = 'Q1 先写作再连接模型';
    await page.getByRole('button', { name: '打开会话文稿', exact: true }).click();
    const panel = page.getByRole(info.project.name === 'mobile-reduced-motion' ? 'dialog' : 'complementary', { name: '会话文稿', exact: true });
    await panel.getByLabel('文稿名称', { exact: true }).fill(title);
    await panel.getByLabel('用途与检查要求', { exact: true }).fill('整理给同事的邀请，日期依据最新材料，人工写作，不需要模型。');
    const creating = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
    await panel.getByRole('button', { name: '保存用途，开始写正文', exact: true }).click();
    const createResponse = await creating; expect(createResponse.status()).toBe(201); const task = await createResponse.json();
    let editor = panel.getByTestId('task-result-editor'); const body = '诚邀同事于10月20日14:00来到南楼201。\n人工句：请带一本反复读过的书，共享一个未解决的问题。';
    await editor.getByRole('textbox', { name: '文稿正文', exact: true }).fill(body);
    await expect(editor.getByRole('button', { name: '让 AI 提供候选稿', exact: true })).toBeDisabled();
    const intents: Json[] = []; let saved: Json | null = null;
    await page.route(`**/api/tasks/${task.id}/result/versions`, async route => {
      intents.push({ key: route.request().headers()['idempotency-key'], input: route.request().postDataJSON() });
      const response = await route.fetch(); expect(response.status()).toBe(200); saved = await response.json();
      await route.abort('connectionreset');
    });
    await editor.getByRole('button', { name: '保存为新版本', exact: true }).click();
    await expect(editor.getByRole('button', { name: '核验原请求', exact: true })).toBeVisible();
    await e.record('manual-save-committed-ack-lost', { taskId: task.id, intents, committedResponse: saved, devicePrivateContentChoice: 'default off; minimal command receipt retained' });
    await e.shot('manual-save-unknown-before-reload', editor.getByRole('button', { name: '核验原请求', exact: true }));
    await reloadWithEvidence(page, e); await workspace(page, info, e);
    const continueOriginal = page.getByRole('button', { name: '打开文稿核验', exact: true });
    await expect(continueOriginal).toBeVisible();
    await e.shot('visible-original-receipt-recovery-entry', continueOriginal, true);
    await continueOriginal.click(); editor = page.getByTestId('task-result-editor');
    await expect(editor).toHaveAttribute('data-task-id', task.id);
    await expect(editor.getByRole('button', { name: '核验原请求', exact: true })).toBeVisible();
    const checking = page.waitForResponse(r => r.url().endsWith(`/api/tasks/${task.id}/result/commands/${intents[0].key}`));
    await editor.getByRole('button', { name: '核验原请求', exact: true }).click();
    const checked = await checking; expect(checked.status()).toBe(200); const receipt = await checked.json();
    expect(receipt.receipt.id).toBe(intents[0].key); expect(currentVersion(receipt.document).content).toBe(body);
    await expect(editor.getByRole('textbox', { name: '文稿正文', exact: true })).toHaveValue(body);
    await expect(editor.getByRole('button', { name: '核验原请求', exact: true })).toHaveCount(0);
    expect(intents).toHaveLength(1); expect(receipt.document.versions).toHaveLength(1);
    expect((await get(context, `${Q1_ORIGIN}/__q1/observations`)).calls.length).toBe(state.providerCallCountAtStart);
    await e.record('same-body-command-recovered-after-reload', { taskId: task.id, receipt, intents, noNewSavePost: true, providerCalls: 0,
      limitations: 'Only committed write with dropped browser acknowledgement. Pre-admission/no-server and delayed client200 are separate tests.' });
    await e.shot('manual-first-real-body-recovered', editor.getByRole('textbox', { name: '文稿正文', exact: true }));
    const downloading = page.waitForEvent('download'); await editor.getByRole('button', { name: '下载文本', exact: true }).click();
    const download = await downloading, path = await download.path(); expect(path).toBeTruthy(); expect(await readFile(path!, 'utf8')).toBe(body);
    await info.attach('manual-first-real-download.txt', { path: path!, contentType: 'text/plain' });
    e.outcome = 'manual-first-committed-save-recovery-protocol-pass-pending-visual-review';
  } catch (cause) { error = cause; throw cause; }
  finally { await e.finish(error); }
});

test('Q1 partial fault evidence: lost save ACK, reload, dispatched cancellation and late receipt', async ({ page, context }, info) => {
  const e = new Evidence(page, info); let error: unknown; let model = '';
  try {
    const state = await setup(page, context, info, e); model = state.model;
    const title = 'Q1 断回执和停止路径';
    const work = await composeFromMessage(page, context, e, state.messages[1], title, `${PURPOSE}\nQ1-CANCEL-AFTER-DISPATCH`);
    const createIntents: Json[] = []; let saved: Json | null = null; let allowAuthorityRead = true;
    await page.route('**/api/tasks', async route => {
      if (route.request().method() !== 'POST') return allowAuthorityRead ? route.continue() : route.abort('connectionreset');
      createIntents.push({ key: route.request().headers()['idempotency-key'], payload: route.request().postDataJSON() });
      const response = await route.fetch(); expect(response.status()).toBe(201); saved = await response.json();
      allowAuthorityRead = false;
      await route.abort('connectionreset');
    });
    await work.getByRole('button', { name: '保存用途，开始写正文', exact: true }).click();
    await expect(work.getByRole('button', { name: '核验并重试保存', exact: true })).toBeVisible();
    await expect(work.getByLabel('用途与检查要求')).toBeDisabled();
    await e.record('save-committed-ack-lost', { createIntents, savedTask: saved, additionalFault: 'Browser task-list GET blocked until intentional reload, so the unknown banner is observed before automatic authoritative receipt recovery' });
    await e.shot('lost-ack-before-reload', work.getByRole('button', { name: '核验并重试保存', exact: true }), true);
    expect(saved).toBeTruthy(); const savedId = (saved as unknown as Json).id;
    const reloadDialog = async (dialog: import('@playwright/test').Dialog) => {
      const expected = dialog.type() === 'beforeunload';
      await e.record('reload-dialog', { type: dialog.type(), message: dialog.message(), action: expected ? 'accept-intended-reload' : 'dismiss-unexpected-dialog' });
      if (expected) await dialog.accept(); else await dialog.dismiss();
    };
    page.once('dialog', reloadDialog);
    allowAuthorityRead = true;
    try { await page.reload(); } finally { page.off('dialog', reloadDialog); }
    const target = await openDetails(page, title); const recovered = await taskById(context, savedId);
    expect(recovered.client_request_id).toBe(createIntents[0].key); expect(recovered.prompt).toBe(createIntents[0].payload.prompt);
    expect((await tasks(context)).filter(t => t.title === title)).toHaveLength(1); expect(createIntents).toHaveLength(1);
    await e.record('reload-recovers-same-saved-task', { task: recovered, originalIntent: createIntents[0],
      recoveryBoundary: 'Only committed-save discovery is covered by this inherited fault scenario. Minimal receipt reload and pre-admission failures need separate outcome assertions.' });
    await e.shot('same-save-recovered-after-reload', target);
    const runKeys: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith(`/api/tasks/${savedId}/run`)) runKeys.push(request.headers()['idempotency-key']); });
    await target.getByRole('button', { name: '生成草稿', exact: true }).click();
    await expect.poll(async () => (await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task' && call.hold).length).toBe(1);
    const running = await taskById(context, savedId); expect(running.status).toBe('running'); expect(running.dispatch_status).toBe('sent_or_unknown');
    await e.record('actual-http-arrival-before-stop', { task: running, fixtureCalls: await fixtureCalls(context, model), runKeys });
    await e.shot('http-dispatched-awaiting-response', target.getByRole('button', { name: '停止生成', exact: true }), true);
    await target.getByRole('button', { name: '停止生成', exact: true }).click();
    await expect(target.locator(':scope > .flex.flex-wrap').getByRole('button', { name: '已核验，允许重试', exact: true })).toBeVisible();
    const cancelled = await taskById(context, savedId); expect(cancelled.status).toBe('outcome_unknown'); expect(cancelled.run_id).toBe(running.run_id);
    await e.record('cancel-after-dispatch', { task: cancelled });
    await e.shot('stopped-but-outcome-unknown', target.locator(':scope > .flex.flex-wrap').getByRole('button', { name: '已核验，允许重试', exact: true }), true);
    const release = await context.request.post(`${Q1_ORIGIN}/__q1/release?model=${encodeURIComponent(model)}`); expect(release.ok()).toBe(true);
    await expect.poll(async () => (await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task' && call.releasedAt).length).toBe(1);
    await e.record('late-provider-receipt-released', { release: await release.json(), calls: await fixtureCalls(context, model),
      limitation: 'If the HTTP socket was already aborted, evidence is a late response attempt after processing, not proof the client received a late ACK.' });
    await page.reload(); const reopened = await openDetails(page, title); const unknown = await taskById(context, savedId);
    expect(unknown.status).toBe('outcome_unknown'); expect(unknown.run_id).toBe(running.run_id); expect(unknown.result_pending_review).toBe(false);
    expect(runKeys).toHaveLength(1); expect((await fixtureCalls(context, model)).filter((call: Json) => call.kind === 'task')).toHaveLength(1);
    await e.shot('same-unknown-run-after-reload', reopened);
    const resolve = reopened.locator(':scope > .flex.flex-wrap').getByRole('button', { name: '已核验，允许重试', exact: true }); await resolve.click();
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
