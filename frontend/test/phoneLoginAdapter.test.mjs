import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

// Execute the actual TS adapter and its browser-side guard against a controlled
// Page/DOM transport. These are Node contracts, never native Chrome evidence.
const origin = 'http://127.0.0.1:3210', phone = '13800000001', password = 'Synthetic-Browser-Only-2026', user = 'synthetic-A';
const events = ['request', 'response', 'requestfinished', 'requestfailed', 'framenavigated', 'close'];
async function adapter() {
  const result = await build({ stdin: { contents: `export * from './e2e/phoneLoginRecovery.ts'; export * from './e2e/sessionBootstrapRecovery.ts';`, resolveDir: new URL('..', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'controlled-playwright', setup(b) {
    b.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'playwright', namespace: 'controlled' }));
    b.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `
      export function expect(locator) { return { toBeVisible: async ({ timeout } = {}) => { if (!await locator.isVisible(timeout)) throw new Error('workspace not visible'); } }; }
      expect.poll = (read, { timeout } = {}) => ({ toBe: async expected => { for (let i=0; i<20; i++) { if (await read() === expected) return; await Promise.resolve(); } throw new Error('controlled poll still pending'); }, not: { toBe: async expected => { if (await read() === expected) throw new Error('navigation still pending'); } } });
    `, loader: 'js' }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
class Handle {
  constructor(page, value) { this.page = page; this.value = value; }
  async $(selector) { const element = this.value.querySelector(selector); return element ? new Handle(this.page, element) : null; }
  async evaluateHandle(fn, arg) { return new Handle(this.page, fn(this.value, arg)); }
  async evaluate(fn) { const result = fn(this.value); if (this.value.read) await this.page.hooks.guardRead?.(this.page, result); return result; }
  async click({ timeout }) { assert.ok(timeout > 0 && timeout <= 15000); assert.equal(this.value, this.page.submit); await this.page.hooks.nativeClick?.(this.page, timeout); await this.page.click(); }
  async dispose() { this.page.disposals++; await this.page.hooks.dispose?.(this.page); }
}
class Page extends EventEmitter {
  frame = {}; clicks = 0; destination = false; status = [429, 200]; disposals = 0; screenshots = []; requests = []; hooks = {};
  constructor() { super(); this.window = new Window({ url: origin }); this.resetForm(); }
  context() { return { newCDPSession: async () => {
    const session = new EventEmitter(); this.cdp = session;
    session.send = async command => { await this.hooks.cdpSend?.(this, command); return command === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main', loaderId: 'original', url: this.url() } } } : {}; };
    session.detach = async () => { await this.hooks.detach?.(this); session.emit('close'); };
    return session;
  } }; }
  async evaluateHandle() { return new Handle(this, this.currentDocument ?? this.window.document); }
  async evaluate(fn, handle) { await this.hooks.proof?.(this); const previous = globalThis.document; globalThis.document = this.currentDocument ?? this.window.document; try { return fn(handle.value); } finally { globalThis.document = previous; } }
  history(order = 'raw-first') { const raw = () => this.cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: this.url(), navigationType: 'historyApi' }); const publicEvent = () => this.emit('framenavigated', this.frame); if (order === 'raw-first') { raw(); publicEvent(); } else { publicEvent(); raw(); } }
  url() { return origin + '/'; }
  mainFrame() { return this.frame; }
  resetForm() {
    this.window.document.body.innerHTML = '<form><input placeholder="请输入手机号"><input placeholder="请输入密码" type="password"><p class="error"></p><button type="submit">登录</button></form>';
    this.form = this.window.document.querySelector('form'); this.phone = this.form.children[0]; this.password = this.form.children[1]; this.error = this.form.children[2]; this.submit = this.form.children[3];
    for (const element of [this.phone, this.password, this.submit]) element.getClientRects = () => element.isConnected ? [{}] : [];
    this.destination = false;
  }
  getByRole() { return {}; }
  getByPlaceholder(name) {
    const element = name === '请输入手机号' ? this.phone : this.password;
    return { fill: async (value, { timeout } = {}) => { assert.ok(timeout > 0 && timeout <= 15000); await this.hooks.nativeFill?.(this, name, timeout); element.value = value; element.dispatchEvent(new this.window.Event('input', { bubbles: true })); }, isVisible: async () => element.isConnected };
  }
  locator(selector) { assert.equal(selector, 'form'); return { filter: () => ({ elementHandle: async () => new Handle(this, this.form) }) }; }
  getByTestId(name) { assert.equal(name, 'workspace'); return { isVisible: async () => { await this.hooks.workspace?.(this); return this.destination; } }; }
  req(path = '/api/auth/login-phone', extra = {}) { return { url: () => path.startsWith('http') ? path : origin + path, method: () => path === '/api/auth/login-phone' ? 'POST' : 'GET', postDataJSON: () => ({ phone: this.phone.value, password: this.password.value }), headers: () => ({ 'x-expected-user-id': this.owner ?? user }), frame: () => this.frame, ...extra }; }
  response(status, req, extra = {}) { return { request: () => req, url: () => req.url(), status: () => status, headers: () => ({ 'retry-after': '1' }), json: async () => ({ user: { id: this.owner ?? user } }), ...extra }; }
  emitResponse(status, req = this.req(), extra = {}) { this.requests.push(req); this.emit('request', req); const response = this.response(status, req, extra); this.emit('response', response); this.emit('requestfinished', req); return response; }
  async click() {
    this.clicks++; await this.hooks.beforeSubmit?.(this);
    if (!this.form.dispatchEvent(new this.window.Event('submit', { bubbles: true, cancelable: true }))) return;
    if (this.hooks.click) return this.hooks.click(this);
    const status = this.status.shift() ?? 200; this.last = this.emitResponse(status);
    if (status === 429) this.error.textContent = '请求过于频繁';
    if (status === 200) this.initialize();
  }
  initialize() { this.emitResponse(200, this.req('/api/bootstrap')); this.emitResponse(200, this.req('/api/user/model-catalog')); this.form.remove(); this.destination = true; }
  async screenshot(options) { await this.hooks.nativeScreenshot?.(this, options.timeout); this.screenshots.push(options); assert.equal(options.mask.length, 2); await this.hooks.screenshot?.(this); }
  clean() { for (const e of events) assert.equal(this.listenerCount(e), 0, e); }
}
async function controlled(fn) {
  const oldNow = Date.now, oldSetTimeout = globalThis.setTimeout, oldClearTimeout = globalThis.clearTimeout;
  let now = 1000, pending = 0, waits = [], waitHook, nowHook;
  Date.now = () => { nowHook?.(); return now; };
  globalThis.setTimeout = (callback, ms) => { pending++; waits.push(ms); queueMicrotask(async () => { now += ms; await waitHook?.(); pending--; callback(); }); return waits.length; };
  globalThis.clearTimeout = () => {};
  try {
    const a = await adapter(), page = new Page(), attachments = [];
    const info = { timeout: 20000, attach: async (name, value) => { attachments.push({ name, body: JSON.parse(value.body) }); }, outputPath: name => name };
    a.beginSessionBootstrapRecovery(page, info);
    await fn({ a, page, info, attachments, waits, setWait: hook => { waitHook = hook; }, advance: ms => { now += ms; }, run: (p = page, owner = user, inputPhone = phone) => a.uiPhoneLogin(p, info, inputPhone, owner), now: () => now, setNowHook: hook => { nowHook = hook; } });
    page.clean(); assert.equal(pending, 0);
  } finally { Date.now = oldNow; globalThis.setTimeout = oldSetTimeout; globalThis.clearTimeout = oldClearTimeout; }
}

test('actual adapter first200 confirms current bootstrap plus workspace, masks fields and cleans handles', async () => controlled(async s => {
  s.page.status = [200]; await s.run(); assert.equal(s.page.clicks, 1); assert.deepEqual(s.waits, []); assert.equal(s.page.disposals, 4); assert.equal(s.attachments[0].body.deadline, 21000);
  assert.equal(JSON.stringify(s.attachments).includes(password), false); assert.equal(JSON.stringify(s.attachments).includes(phone), false);
}));
test('actual adapter429→200 performs one unchanged control retry after the real server delay', async () => controlled(async s => {
  await s.run(); assert.equal(s.page.clicks, 2); assert.deepEqual(s.waits, [1100]); assert.deepEqual(s.attachments.map(a => a.body.phase), ['rate-limited', 'workspace']);
}));
test('actual adapter second429 is terminal across repeated calls', async () => controlled(async s => {
  s.page.status = [429, 429]; await assert.rejects(s.run(), /Second phone/); await assert.rejects(s.run(), /previously failed/); assert.equal(s.page.clicks, 2);
}));
for (const at of ['screenshot', 'wait', 'last-read']) for (const kind of ['new-login', 'changed-input', 'changed-restored-input', 'navigation', 'failed-request']) test(`actual adapter ${kind} during ${at} cannot re-click`, async () => controlled(async s => {
  let changed = false;
  const mutate = page => {
    if (changed) return; changed = true;
    if (kind === 'new-login') page.emitResponse(401);
    if (kind === 'changed-input' || kind === 'changed-restored-input') { page.phone.value = '13900000002'; page.phone.dispatchEvent(new page.window.Event('input', { bubbles: true })); if (kind === 'changed-restored-input') page.phone.value = phone; }
    if (kind === 'navigation') page.emit('framenavigated', page.frame);
    if (kind === 'failed-request') page.emit('requestfailed', page.last.request());
  };
  if (at === 'screenshot') s.page.hooks.screenshot = mutate;
  if (at === 'wait') s.setWait(() => mutate(s.page));
  if (at === 'last-read') s.page.hooks.guardRead = page => { if (s.waits.length) mutate(page); };
  await assert.rejects(s.run(), /changed|no longer current/); assert.equal(s.page.clicks, 1);
}));
for (const kind of ['wrong-login-user', 'wrong-bootstrap-user', 'bootstrap-429', 'bootstrap-network', 'bootstrap-pending']) test(`actual adapter ${kind} after200 sends zero additionalPOSTs`, async () => controlled(async s => {
  s.page.hooks.click = page => {
    page.emitResponse(200, page.req(), { json: async () => ({ user: { id: kind === 'wrong-login-user' ? 'synthetic-B' : user } }) });
    const req = page.req('/api/bootstrap');
    if (kind === 'bootstrap-network' || kind === 'bootstrap-pending') { page.emit('request', req); if (kind === 'bootstrap-network') page.emit('requestfailed', req); }
    else page.emitResponse(kind === 'bootstrap-429' ? 429 : 200, req, { json: async () => ({ user: { id: kind === 'wrong-bootstrap-user' ? 'synthetic-B' : user } }) });
  };
  await assert.rejects(s.run(), /different user|expected user|changed|pending/); assert.equal(s.page.clicks, 1);
}));
test('actual adapter final workspace await cannot pass a replaced identity chain', async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.workspace = page => page.emitResponse(401);
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1);
}));
test('actual adapter deadline and unique evidence identity span navigation, repeated begin, two pages and B→A', async () => controlled(async s => {
  const original = s.a.capturedSessionDeadline(s.page, s.info); s.info.timeout = 100000;
  s.page.status = [200]; await s.run(); s.advance(2000); s.a.beginSessionBootstrapRecovery(s.page, s.info);
  s.page.emit('framenavigated', s.page.frame); s.page.resetForm(); s.page.status = [200]; s.page.owner = 'synthetic-B';
  await s.run(s.page, 'synthetic-B', '13900000002');
  assert.equal(s.a.capturedSessionDeadline(s.page, s.info), original);
  assert.deepEqual(s.attachments.map(a => a.name), ['phone-login-1-workspace.json', 'phone-login-2-workspace.json']);
  const second = new Page(); s.a.beginSessionBootstrapRecovery(second, s.info); assert.equal(s.a.capturedSessionDeadline(second, s.info), original);
  s.advance(15000); await assert.rejects(s.run(second), /original test budget/); assert.equal(second.clicks, 0); second.clean();
}));
test('actual adapter requires original deadline capture before any form fill', async () => controlled(async s => {
  const untouched = new Page(); await assert.rejects(s.run(untouched), /before registration/); assert.equal(untouched.clicks, 0); untouched.clean();
}));
test('submit-time browser guard blocks the POST if inputs change inside native click scheduling', async () => controlled(async s => {
  s.page.hooks.beforeSubmit = page => { if (page.clicks === 2) { page.phone.value = '13900000002'; page.phone.dispatchEvent(new page.window.Event('input', { bubbles: true })); } };
  await assert.rejects(s.run(), /did not submit/);
  assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1);
}));
test('actual adapter allows same-owner repeated catalogs and ordinary catalog errors', async () => controlled(async s => {
  s.page.hooks.click = page => { page.emitResponse(200); page.emitResponse(200, page.req('/api/bootstrap')); page.emitResponse(500, page.req('/api/user/model-catalog')); page.emitResponse(200, page.req('/api/user/model-catalog')); page.form.remove(); page.destination = true; };
  await s.run(); assert.equal(s.page.clicks, 1);
}));
test('actual adapter does not invent a catalog-network prerequisite for a verified workspace', async () => controlled(async s => {
  s.page.hooks.click = page => { page.emitResponse(200); page.emitResponse(200, page.req('/api/bootstrap')); page.form.remove(); page.destination = true; };
  await s.run(); assert.equal(s.page.clicks, 1);
}));
test('actual adapter login failure during final capture cannot falsely complete', async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.screenshot = page => page.emit('requestfailed', page.last.request());
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1);
}));
test('actual adapter same-document A→B→A operations retain one deadline and separate request identities', async () => controlled(async s => {
  for (const [owner, inputPhone] of [[user, phone], ['synthetic-B', '13900000002'], [user, phone]]) {
    s.page.resetForm(); s.page.owner = owner; s.page.status = [429, 200]; await s.run(s.page, owner, inputPhone);
  }
  assert.equal(s.page.clicks, 6); assert.deepEqual(s.waits, [1100, 1100, 1100]);
  assert.deepEqual([...new Set(s.attachments.map(a => a.body.deadline))], [21000]);
  assert.equal(new Set(s.attachments.map(a => a.name)).size, 6);
}));
for (const at of ['workspace', 'screenshot', 'dispose']) for (const status of [401, 409]) test(`actual adapter catalog${status} authentication invalidation during final ${at} fails without anotherPOST`, async () => controlled(async s => {
  let changed = false; s.page.status = [200];
  s.page.hooks[at] = page => {
    if (changed) return; changed = true;
    page.emitResponse(status, page.req('/api/user/model-catalog'), { json: async () => ({ code: status === 409 ? 'ACCOUNT_CHANGED' : 'UNAUTHORIZED' }) });
  };
  await assert.rejects(s.run(), /changed|authentication/);
  assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1);
  await assert.rejects(s.run(), /previously failed/);
}));
test('actual adapter valid native submit is not prevented and invokes exactly one originalPOST', async () => controlled(async s => {
  let submissions = 0; s.page.status = [200];
  s.page.form.addEventListener('submit', event => { assert.equal(event.defaultPrevented, false); submissions++; });
  await s.run(); assert.equal(submissions, 1); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1);
}));
test('actual adapter cancelled intent guard remains failed and cannot reopen an operation', async () => controlled(async s => {
  s.page.hooks.beforeSubmit = page => { page.phone.value = '13900000002'; page.phone.dispatchEvent(new page.window.Event('input', { bubbles: true })); };
  await assert.rejects(s.run(), /did not submit/); await assert.rejects(s.run(), /previously failed/);
  assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 0);
}));
for (const body of [{ code: 'CATALOG_REVISION_CONFLICT' }, { message: 'ACCOUNT_CHANGED' }, { error: { code: 'ACCOUNT_CHANGED' } }]) test(`actual adapter ordinary409 ${JSON.stringify(body)} remains diagnostic`, async () => controlled(async s => {
  let emitted = false; s.page.status = [200];
  s.page.hooks.screenshot = page => { if (!emitted) { emitted = true; page.emitResponse(409, page.req('/api/user/model-catalog'), { json: async () => body }); } };
  await s.run(); assert.equal(s.page.clicks, 1);
}));
for (const mode of ['reject', 'pending']) test(`actual adapter unknown409 body ${mode} after final disposal cannot pass or resend`, async () => controlled(async s => {
  let emitted = false, resolveBody; s.page.status = [200];
  s.page.hooks.dispose = page => {
    if (emitted) return; emitted = true;
    page.emitResponse(409, page.req('/api/user/model-catalog'), { json: () => mode === 'reject' ? Promise.reject(new Error('unreadable body')) : new Promise(resolve => { resolveBody = resolve; }) });
  };
  await assert.rejects(s.run(), /changed|pending/); assert.equal(s.page.clicks, 1);
  resolveBody?.({ code: 'ACCOUNT_CHANGED' }); await Promise.resolve(); await assert.rejects(s.run(), /previously failed/);
}));
test('actual adapter waits for asynchronous409 classification before final success', async () => controlled(async s => {
  let emitted = false; s.page.status = [200];
  s.page.hooks.dispose = page => {
    if (emitted) return; emitted = true;
    page.emitResponse(409, page.req('/api/user/model-catalog'), { json: async () => { await Promise.resolve(); await Promise.resolve(); return { code: 'ACCOUNT_CHANGED' }; } });
  };
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1);
}));
for (const status of [401, 409]) test(`actual adapter catalog${status} in the final drain continuation cannot falsely succeed`, async () => controlled(async s => {
  let afterCleanupReads = 0, emitted = false; s.page.status = [200];
  s.setNowHook(() => {
    // Dispose has completed. The fifth clock read is the drain's last internal
    // currentness check, immediately before its Promise resolves to the caller.
    if (s.page.disposals === 4 && ++afterCleanupReads === 5 && !emitted) {
      emitted = true;
      queueMicrotask(() => s.page.emitResponse(status, s.page.req('/api/user/model-catalog'), { json: async () => ({ code: 'ACCOUNT_CHANGED' }) }));
    }
  });
  await assert.rejects(s.run(), /changed|pending/); assert.equal(emitted, true); assert.equal(s.page.clicks, 1);
  await assert.rejects(s.run(), /previously failed/);
}));
for (const action of ['fill', 'click', 'screenshot']) test(`native ${action} lasting over five seconds uses remaining original budget without retry`, async () => controlled(async s => {
  const durations = []; s.page.status = [200];
  const act = timeout => { if (durations.length) return; assert.ok(timeout > 5000); assert.ok(timeout <= 15000); durations.push(6000); s.advance(6000); };
  if (action === 'fill') s.page.hooks.nativeFill = (_page, _name, timeout) => act(timeout);
  if (action === 'click') s.page.hooks.nativeClick = (_page, timeout) => act(timeout);
  if (action === 'screenshot') s.page.hooks.nativeScreenshot = (_page, timeout) => act(timeout);
  await s.run(); assert.deepEqual(durations, [6000]); assert.equal(s.page.clicks, 1); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1);
  assert.equal(s.attachments.at(-1).body.deadline, 21000); assert.deepEqual(s.waits, []);
}));
for (const action of ['fill', 'click', 'screenshot']) test(`native ${action} exhausting its remaining budget stops without an action retry`, async () => controlled(async s => {
  let calls = 0; s.page.status = [200];
  const exhaust = timeout => { calls++; assert.ok(timeout > 5000 && timeout <= 15000); s.advance(timeout + 1); throw new Error('native action reached original deadline'); };
  if (action === 'fill') s.page.hooks.nativeFill = (_page, _name, timeout) => exhaust(timeout);
  if (action === 'click') s.page.hooks.nativeClick = (_page, timeout) => exhaust(timeout);
  if (action === 'screenshot') s.page.hooks.nativeScreenshot = (_page, timeout) => exhaust(timeout);
  await assert.rejects(s.run(), /original deadline/); await assert.rejects(s.run(), /previously failed/);
  assert.equal(calls, 1); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, action === 'screenshot' ? 1 : 0);
  assert.deepEqual(s.waits, []);
}));
test('long native click with an already dispatchedPOST and uncertain timeout never resends it', async () => controlled(async s => {
  s.page.status = [200];
  s.page.hooks.nativeClick = async (page, timeout) => { await page.click(); s.advance(timeout + 1); throw new Error('native click outcome timed out'); };
  await assert.rejects(s.run(), /timed out/); assert.equal(s.page.clicks, 1); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1); assert.deepEqual(s.waits, []);
}));
test('actual form mutation during a long native click is sticky and blocks its POST', async () => controlled(async s => {
  s.page.status = [200];
  s.page.hooks.nativeClick = page => { s.advance(6000); page.phone.value = '13900000002'; page.phone.dispatchEvent(new page.window.Event('input', { bubbles: true })); page.phone.value = phone; };
  await assert.rejects(s.run(), /did not submit/); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 0); assert.equal(s.page.clicks, 1);
}));
test('account invalidation during a long native action fails and cannot authorize a second action', async () => controlled(async s => {
  s.page.status = [200];
  s.page.hooks.nativeClick = page => { s.advance(6000); page.emit('framenavigated', page.frame); };
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 1); assert.deepEqual(s.waits, []);
}));
test('a long native retry click still has no thirdPOST when its outcome is unknown', async () => controlled(async s => {
  s.page.hooks.nativeClick = async (page, timeout) => { if (page.clicks === 1) { await page.click(); s.advance(timeout + 1); throw new Error('native retry result unknown'); } };
  await assert.rejects(s.run(), /unknown/); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 2); assert.equal(s.page.clicks, 2);
}));
for (const field of ['phone', 'password']) test(`replacing then restoring the ${field} node cannot revive an observed changed intent`, async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.beforeSubmit = page => {
    const original = page[field], replacement = original.cloneNode(true); replacement.value = original.value;
    original.replaceWith(replacement); replacement.dispatchEvent(new page.window.Event('input', { bubbles: true })); replacement.replaceWith(original);
  };
  await assert.rejects(s.run(), /did not submit/); assert.equal(s.page.requests.filter(r => r.method() === 'POST').length, 0); assert.equal(s.page.clicks, 1);
}));

for (const order of ['raw-first', 'public-first']) test(`actual adapter pairs two accepted history events (${order})`, async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.workspace = page => { page.history(order); page.history(order); };
  await s.run(); assert.equal(s.page.clicks, 1); assert.equal(s.attachments.at(-1).body.document.historyEvents, 2);
}));
test('raw pre-admission history cannot become authorized by a later public event', async () => controlled(async s => {
  s.page.hooks.click = page => {
    page.cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: page.url(), navigationType: 'historyApi' });
    page.emitResponse(200); page.initialize(); page.emit('framenavigated', page.frame);
  };
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1);
  await assert.rejects(s.run(), /previously failed/);
}));
for (const side of ['raw', 'public']) test(`unpaired ${side} history cannot reach success`, async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.workspace = page => {
    if (side === 'raw') page.cdp.emit('Page.navigatedWithinDocument', { frameId: 'main', url: page.url(), navigationType: 'historyApi' });
    else page.emit('framenavigated', page.frame);
  };
  await assert.rejects(s.run(), /pending/); assert.equal(s.page.clicks, 1);
}));
test('fresh final proof rejects a replaced current Document even before its events arrive', async () => controlled(async s => {
  s.page.status = [200]; s.page.hooks.screenshot = page => { page.currentDocument = {}; };
  await assert.rejects(s.run(), /changed/); assert.equal(s.page.clicks, 1);
}));
for (const at of ['detach', 'document-dispose']) for (const event of ['cross-document', '401', '409']) test(`${event} during ${at} is terminal with zero extra POSTs`, async () => controlled(async s => {
  s.page.status = [200]; let emitted = false;
  const mutate = page => {
    if (emitted || at === 'document-dispose' && page.disposals !== 4) return; emitted = true;
    if (event === 'cross-document') page.cdp.emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'replacement', url: page.url() }, type: 'BackForwardCacheRestore' });
    else page.emitResponse(Number(event), page.req('/api/user/model-catalog'), { json: async () => ({ code: 'ACCOUNT_CHANGED' }) });
  };
  s.page.hooks[at === 'detach' ? 'detach' : 'dispose'] = mutate;
  await assert.rejects(s.run(), /changed|pending/); assert.equal(emitted, true); assert.equal(s.page.clicks, 1);
  await assert.rejects(s.run(), /previously failed/);
}));
test('history arriving in the final drain continuation cannot reuse the completed proof', async () => controlled(async s => {
  let reads = 0, emitted = false; s.page.status = [200];
  s.setNowHook(() => { if (s.page.disposals === 4 && ++reads === 5 && !emitted) { emitted = true; queueMicrotask(() => s.page.history()); } });
  await assert.rejects(s.run(), /changed|pending/); assert.equal(emitted, true); assert.equal(s.page.clicks, 1);
}));
