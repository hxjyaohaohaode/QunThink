import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { request } from '@playwright/test';
import { apiPhoneLogin } from '../scripts/api-phone-login-recovery.mjs';

// Node contracts and real loopback API transport only, never native UI proof.
const origin = 'http://127.0.0.1:3210';
const secrets = { phone: '13800000001', password: 'private-test-password', cookie: 'private-session-cookie', csrf: 'private-csrf-token', body: 'private-response-body' };
const cookie = () => ({ name: 'session_token', value: secrets.cookie, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' });
const response = (status, retryAfter = '7', user = 'target') => ({ url: () => origin + '/api/auth/login-phone', status: () => status, headers: () => ({ 'retry-after': retryAfter }), json: async () => ({ user: { id: user }, secret: secrets.body }) });
function setup() {
  const s = { time: Date.parse('2026-10-13T10:00:00Z'), hooks: {}, evidence: [], posts: [], waits: [], cookiesRead: 0, cookie: cookie(), statuses: [429, 200], retryAfter: '7' };
  s.deadline = s.time + 120000;
  s.intent = { phone: secrets.phone, password: secrets.password, expectedUserId: 'target', currentUserId: 'original' };
  s.context = new EventEmitter(); s.page = new EventEmitter(); const frame = {};
  Object.assign(s.page, { context: () => s.context, mainFrame: () => frame, url: () => origin + '/', isClosed: () => false });
  s.context.cookies = async url => { assert.equal(url, origin + '/api/auth/login-phone'); s.cookiesRead++; await s.hooks.cookies?.(); return s.cookie ? [{ ...s.cookie }] : []; };
  s.context.request = {
    get: async (path, options) => { assert.equal(path, origin + '/api/csrf-token'); s.getOptions = options; await s.hooks.csrf?.(); return { url: () => origin + '/api/csrf-token', status: () => 200, json: async () => { await s.hooks.csrfBody?.(); return { csrfToken: secrets.csrf }; } }; },
    post: async (path, options) => {
      assert.equal(path, origin + '/api/auth/login-phone'); s.posts.push({ path, options }); await s.hooks.post?.();
      const result = response(s.statuses.shift() ?? 200, s.retryAfter, s.resultUser ?? 'target');
      result.json = async () => { await s.hooks.body?.(); return { user: { id: s.resultUser ?? 'target' }, secret: secrets.body }; };
      return result;
    },
  };
  s.run = (changes = {}) => apiPhoneLogin({ page: s.page, context: s.context, deadline: s.deadline, intent: s.intent,
    now: () => s.time,
    wait: async ms => { s.waits.push(ms); s.time += ms; await s.hooks.wait?.(); },
    capture: async state => { s.evidence.push(state); await s.hooks.capture?.(state); }, ...changes });
  s.clean = () => { for (const event of ['close', 'framenavigated', 'request']) { assert.equal(s.page.listenerCount(event), 0); assert.equal(s.context.listenerCount(event), 0); } };
  return s;
}

test('confirmed API429 retries the exact phone intent once after Retry-After7 within the captured deadline', async () => {
  const s = setup(); await s.run(); s.clean();
  assert.equal(s.posts.length, 2); assert.deepEqual(s.waits, [7100]);
  assert.deepEqual(s.posts[0].options.data, { phone: secrets.phone, password: secrets.password });
  assert.equal(s.posts[0].options.data, s.posts[1].options.data);
  assert.equal(s.posts[0].options.headers, s.posts[1].options.headers);
  for (const post of s.posts) { assert.equal(post.options.maxRetries, 0); assert.equal(post.options.maxRedirects, 0); assert.ok(post.options.timeout > 0 && post.options.timeout <= 115000); }
  assert.deepEqual(s.evidence.map(e => e.phase), ['rate-limited', 'accepted']);
  assert.ok(s.evidence.every(e => e.deadline === s.deadline));
});
test('first200 is terminal without a wait and validates the exact target user', async () => {
  const s = setup(); s.statuses = [200]; await s.run(); s.clean(); assert.equal(s.posts.length, 1); assert.deepEqual(s.waits, []);
});
for (const path of ['https://unrelated.invalid/api/auth/login-phone', origin + '/api/auth/register', origin + '/api/auth/login-phone?other=1']) test(`unrelated429 from ${path} grants no retry`, async () => {
  const s = setup(), post = s.context.request.post;
  s.context.request.post = async (...args) => { const r = await post(...args); r.url = () => path; return r; };
  await assert.rejects(s.run(), /unrelated response/); s.clean(); assert.equal(s.posts.length, 1); assert.equal(s.waits.length, 0);
});
test('unrelated CSRF response sends no login POST', async () => {
  const s = setup(), get = s.context.request.get;
  s.context.request.get = async (...args) => { const r = await get(...args); r.url = () => 'https://unrelated.invalid/api/csrf-token'; return r; };
  await assert.rejects(s.run(), /unrelated CSRF/); s.clean(); assert.equal(s.posts.length, 0);
});
test('second429 fails closed and a repeated invocation cannot mint another retry', async () => {
  const s = setup(); s.statuses = [429, 429, 200]; await assert.rejects(s.run(), /Second API phone login 429/);
  await assert.rejects(s.run(), /previously failed/); s.clean(); assert.equal(s.posts.length, 2);
});
for (const value of [undefined, '', 'garbage', '-1', '121', '1.5', '+7', 'Infinity', '2026-10-13', 'Tue, 13 Oct 2026 09:59:59 GMT', 'Wed, 13 Oct 2026 10:00:07 GMT']) test(`invalid or unbounded Retry-After ${String(value)} sends no retry`, async () => {
  const s = setup(); s.retryAfter = value; // Override the response helper's default for missing headers.
  const post = s.context.request.post; s.context.request.post = async (...args) => { const r = await post(...args); r.headers = () => ({ 'retry-after': value }); return r; };
  await assert.rejects(s.run(), /bounded server Retry-After/); s.clean(); assert.equal(s.posts.length, 1); assert.equal(s.waits.length, 0);
});
test('canonical bounded HTTP-date Retry-After is allowed', async () => {
  const s = setup(); s.retryAfter = new Date(s.time + 7000).toUTCString(); await s.run(); assert.deepEqual(s.waits, [7100]); s.clean();
});
for (const status of [301, 307, 400, 401, 403, 409, 500, 503]) test(`HTTP${status} has zero additional POSTs`, async () => {
  const s = setup(); s.statuses = [status]; await assert.rejects(s.run(), /did not return 200/); s.clean(); assert.equal(s.posts.length, 1); assert.equal(s.waits.length, 0);
});
for (const position of [1, 2]) test(`unknown network result at attempt${position} is not retried or leaked`, async () => {
  const s = setup(); s.hooks.post = () => { if (s.posts.length === position) throw new Error(Object.values(secrets).join(' ')); };
  const error = await s.run().then(() => null, error => error); assert.ok(error); assert.equal(s.posts.length, position); s.clean();
  for (const secret of Object.values(secrets)) assert.equal(String(error).includes(secret), false);
});
for (const statuses of [[200], [429, 200]]) test(`wrong200 user after ${statuses.length} attempts cannot resubmit`, async () => {
  const s = setup(); s.statuses = [...statuses]; s.resultUser = 'wrong-user'; await assert.rejects(s.run(), /different user/); s.clean(); assert.equal(s.posts.length, statuses.length);
});
for (const at of ['capture', 'wait', 'last-cookie-read']) for (const field of ['phone', 'password', 'expectedUserId', 'currentUserId', 'cookie', 'navigation', 'close', 'auth-request']) test(`${field} change during ${at} prevents the retry`, async () => {
  const s = setup(); let changed = false;
  const change = () => {
    if (changed) return; changed = true;
    if (field in s.intent) s.intent[field] = 'changed';
    if (field === 'cookie') s.cookie.value = 'different-session';
    if (field === 'navigation') s.page.emit('framenavigated', s.page.mainFrame());
    if (field === 'close') s.context.emit('close');
    if (field === 'auth-request') s.context.emit('request', { url: () => origin + '/api/auth/logout', method: () => 'POST' });
  };
  if (at === 'capture') s.hooks.capture = state => { if (state.phase === 'rate-limited') change(); };
  if (at === 'wait') s.hooks.wait = change;
  if (at === 'last-cookie-read') s.hooks.cookies = () => { if (s.waits.length) change(); };
  await assert.rejects(s.run(), /changed/); s.clean(); assert.equal(s.posts.length, 1);
});
for (const at of ['initial', 'csrf', 'csrfBody', 'capture', 'wait', 'last-cookie-read']) test(`original budget exhausted at ${at} never extends or sends another POST`, async () => {
  const s = setup(); const expire = () => { s.time = s.deadline - 5000; };
  if (at === 'initial') expire();
  else if (at === 'last-cookie-read') s.hooks.cookies = () => { if (s.waits.length) expire(); };
  else s.hooks[at] = expire;
  await assert.rejects(s.run(), /original test budget/); s.clean(); assert.equal(s.posts.length, ['initial', 'csrf', 'csrfBody'].includes(at) ? 0 : 1);
});
test('Retry-After beyond remaining budget is refused before waiting', async () => {
  const s = setup(); s.deadline = s.time + 12000; await assert.rejects(s.run(), /original test budget/); assert.equal(s.posts.length, 1); assert.equal(s.waits.length, 0); s.clean();
});
test('an early or rejected timer cannot authorize an early POST', async () => {
  for (const wait of [async () => {}, async () => { throw new Error('timer failed'); }]) {
    const s = setup(); await assert.rejects(s.run({ wait })); s.clean(); assert.equal(s.posts.length, 1);
  }
});
test('cookie rotation during the first request rejects that429 authority', async () => {
  const s = setup(); s.hooks.post = () => { s.cookie.value = 'rotated'; }; await assert.rejects(s.run(), /changed/); s.clean(); assert.equal(s.posts.length, 1);
});
test('missing initial session cannot authorize a transition', async () => {
  const s = setup(); s.cookie = null; await assert.rejects(s.run(), /session cookie/); s.clean(); assert.equal(s.posts.length, 0);
});
for (const at of ['initial', 'after-wait']) test(`path-specific duplicate session cookie ${at} is refused for the exact login URL`, async () => {
  const s = setup(), original = s.context.cookies;
  s.context.cookies = async url => {
    const cookies = await original(url);
    if (at === 'initial' || s.waits.length) {
      const pathCookie = { ...cookie(), path: '/api/auth', value: 'path-specific-session' };
      if (new URL(url).pathname.startsWith(pathCookie.path)) cookies.push(pathCookie);
    }
    return cookies;
  };
  await assert.rejects(s.run(), /one current session cookie/); s.clean(); assert.equal(s.posts.length, at === 'initial' ? 0 : 1);
});
test('concurrent intent invalidates the original operation without sending a second POST', async () => {
  const s = setup(); s.hooks.capture = async state => { if (state.phase === 'rate-limited') await assert.rejects(s.run(), /Concurrent/); };
  await assert.rejects(s.run(), /changed/); s.clean(); assert.equal(s.posts.length, 1);
});
test('late body parse and evidence await after200 fail closed without another POST', async () => {
  for (const hook of ['body', 'capture']) {
    const s = setup(); s.statuses = [200]; s.hooks[hook] = () => { s.intent.expectedUserId = 'different'; };
    await assert.rejects(s.run(), /changed/); assert.equal(s.posts.length, 1); s.clean();
  }
});
for (const statuses of [[200], [429, 200]]) for (const hook of ['body', 'capture']) test(`accepted actor replaced during ${hook} after ${statuses.length} attempts fails with zero further POSTs`, async () => {
  const s = setup(); s.statuses = [...statuses];
  s.hooks.post = () => { if (s.statuses[0] === 200) s.cookie.value = 'accepted-target-session'; };
  s.hooks[hook] = state => { if (hook === 'body' || state.phase === 'accepted') s.cookie.value = 'replacement-session'; };
  await assert.rejects(s.run(), /actor changed/); s.clean(); assert.equal(s.posts.length, statuses.length);
  await assert.rejects(s.run(), /previously failed/); assert.equal(s.posts.length, statuses.length);
});
test('successful login may rotate to its new cookie without comparing it to the old actor', async () => {
  const s = setup(); s.hooks.post = () => { if (s.statuses[0] === 200) s.cookie.value = 'accepted-target-session'; };
  await s.run(); s.clean(); assert.equal(s.posts.length, 2);
});
test('200 malformed body and CSRF failures are terminal and sanitize thrown details', async () => {
  for (const hook of ['body', 'csrf', 'csrfBody']) {
    const s = setup(); s.statuses = [200]; s.hooks[hook] = () => { throw new Error(Object.values(secrets).join(' ')); };
    const error = await s.run().then(() => null, error => error); assert.ok(error); assert.equal(s.posts.length, hook === 'body' ? 1 : 0); s.clean();
    for (const secret of Object.values(secrets)) assert.equal(String(error).includes(secret), false);
  }
});
test('evidence is an allowlist without phone, password, cookie, CSRF or response body', async () => {
  const s = setup(); await s.run();
  for (const event of s.evidence) assert.deepEqual(Object.keys(event).sort(), ['attempt', 'deadline', 'method', 'path', 'phase', 'remainingBudgetMs', 'status']);
  for (const secret of Object.values(secrets)) assert.equal(JSON.stringify(s.evidence).includes(secret), false);
});
test('successful independent A→B→A calls retain one absolute deadline', async () => {
  const s = setup(); s.statuses = [200]; await s.run(); s.time += 2000;
  s.intent = { ...s.intent, currentUserId: 'target', expectedUserId: 'original' }; s.resultUser = 'original'; s.statuses = [429, 200];
  await s.run(); s.clean(); assert.equal(s.posts.length, 3); assert.ok(s.evidence.every(e => e.deadline === s.deadline));
});
test('metadata adapter obtains captured deadline and binds A→B/B→A without weakening business assertions', async () => {
  const source = await readFile(new URL('../e2e/task-metadata.spec.ts', import.meta.url), 'utf8');
  assert.match(source, /deadline: capturedSessionDeadline\(page, info\)/);
  assert.match(source, /apiLogin\(page, info, context, phoneB, ownerB\.id, ownerA\.id\)/);
  assert.match(source, /apiLogin\(page, info, context, phoneA, ownerA\.id, ownerB\.id\)/);
  assert.match(source, /expect\(await page\.evaluate\(\(\) => performance\.timeOrigin\)\)\.toBe\(timeOrigin\)/);
  assert.match(source, /not\.toContainText\('账号A私密冻结标题-991'\)/);
  assert.match(source, /metadata_revision: 2/);
});

test('actual TS API adapter rejects uncaptured budget and retains beforeEach deadline after timeout extension', async () => {
  const sourcePath = fileURLToPath(new URL('../e2e/task-metadata.spec.ts', import.meta.url));
  const built = await build({ entryPoints: [sourcePath], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'controlled-metadata-adapter', setup(b) {
    b.onLoad({ filter: /task-metadata\.spec\.ts$/ }, async () => ({ contents: (await readFile(sourcePath, 'utf8')) + '\nexport { apiLogin, beginSessionTokenRecovery };', loader: 'ts' }));
    b.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'playwright', namespace: 'controlled' }));
    b.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `export const test = Object.assign(() => {}, { use() {}, setTimeout() {}, beforeAll() {}, beforeEach() {} }); export function expect() { return {}; }`, loader: 'js' }));
  } }] });
  const adapter = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const s = setup(), savedNow = Date.now; s.page.getByRole = () => ({}); s.statuses = [200];
  const info = { timeout: 120000, attach: async (_name, attachment) => { s.evidence.push(JSON.parse(attachment.body)); } };
  const run = () => adapter.apiLogin(s.page, info, s.context, s.intent.phone, s.intent.expectedUserId, s.intent.currentUserId);
  Date.now = () => s.time;
  try {
    await assert.rejects(run(), /before registration/); assert.equal(s.posts.length, 0);
    adapter.beginSessionTokenRecovery(s.page, info); info.timeout = 360000; s.time += 50000;
    adapter.beginSessionTokenRecovery(s.page, info); await run();
    assert.equal(s.posts.length, 1); assert.equal(s.posts[0].options.timeout, 65000); assert.equal(s.evidence[0].deadline, s.deadline);
    s.time = s.deadline - 5000; await assert.rejects(run(), /original test budget/); assert.equal(s.posts.length, 1); s.clean();
  } finally { Date.now = savedNow; }
});

test('real Playwright API transport respects429, same session and intent, no browser or business write', async () => {
  const received = []; let count = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/api/csrf-token') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ csrfToken: secrets.csrf })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, body, cookie: req.headers.cookie, csrf: req.headers['x-csrf-token'], at: Date.now() });
    res.setHeader('content-type', 'application/json');
    if (++count === 1) { res.statusCode = 429; res.setHeader('Retry-After', '0'); res.end('{}'); }
    else { res.setHeader('Set-Cookie', 'session_token=accepted-session; Path=/; HttpOnly; SameSite=Lax'); res.end(JSON.stringify({ user: { id: 'target' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  // Deliberately wrong baseURL: the real adapter must use the captured page's
  // absolute origin, never send credentials to a context's unrelated default.
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:1', storageState: { cookies: [cookie()], origins: [] } });
  const context = new EventEmitter(), page = new EventEmitter(), frame = {};
  context.request = api; context.cookies = async () => (await api.storageState()).cookies;
  Object.assign(page, { context: () => context, mainFrame: () => frame, url: () => baseURL + '/', isClosed: () => false });
  try {
    await apiPhoneLogin({ page, context, deadline: Date.now() + 15000, intent: { phone: secrets.phone, password: secrets.password, expectedUserId: 'target', currentUserId: 'original' } });
    assert.equal(received.length, 2); assert.equal(received[0].body, received[1].body); assert.equal(received[0].cookie, received[1].cookie);
    assert.equal(received[0].csrf, secrets.csrf); assert.ok(received[1].at - received[0].at >= 100);
    assert.ok(received.every(r => r.method === 'POST' && r.url === '/api/auth/login-phone'));
  } finally { await api.dispose(); await new Promise(resolve => server.close(resolve)); }
});
