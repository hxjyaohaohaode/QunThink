import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createPhoneLoginRecovery, assertExpectedLoginUser } from '../scripts/phone-login-recovery.mjs';
const origin = 'http://127.0.0.1:3210', phone = '13800000001', password = 'Synthetic-Browser-Only-2026', user = 'synthetic-A';
const events = ['request', 'response', 'requestfinished', 'requestfailed', 'framenavigated', 'close'];
function setup(options = {}) {
  const page = new EventEmitter(), frame = {}; page.url = () => origin + '/'; page.mainFrame = () => frame;
  let clock = 1000, clicks = 0, visible = false, disposed = 0;
  const waits = [], captures = [], timeouts = [], state = { unchanged: true, visible: true, enabled: true, rateLimited: true };
  const req = (path = '/api/auth/login-phone', extra = {}) => ({ url: () => path.startsWith('http') ? path : origin + path, method: () => path === '/api/auth/login-phone' ? 'POST' : 'GET', postDataJSON: () => ({ phone, password }), headers: () => ({ 'x-expected-user-id': user }), frame: () => frame, ...extra });
  const response = (status, request = req(), extra = {}) => ({ request: () => request, url: () => request.url(), status: () => status, headers: () => ({ 'retry-after': '1' }), json: async () => ({ user: { id: user } }), ...extra });
  const emit = (status, request = req(), extra = {}) => { page.emit('request', request); const value = response(status, request, extra); page.emit('response', value); page.emit('requestfinished', request); return value; };
  const success = (status = 200) => { emit(status); if (status === 200) { emit(200, req('/api/bootstrap')); emit(200, req('/api/user/model-catalog')); visible = true; } };
  const recovery = createPhoneLoginRecovery({ page, deadline: options.deadline ?? 21000, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; await options.wait?.(s); } });
  const form = { read: async () => { await options.read?.(s); return { ...state }; }, click: async (timeout, beginClick) => { beginClick(); timeouts.push(timeout); clicks++; if (options.click) await options.click(s, clicks); else success(clicks === 1 ? options.status ?? 429 : 200); }, dispose: async () => { disposed++; await options.dispose?.(s); } };
  const run = overrides => recovery({ phone, password, expectedUserId: user, prepare: async () => form, poll: async read => { if (!await read()) throw new Error('state still pending'); }, capture: async value => { captures.push(value); await options.capture?.(s, value); }, workspace: async () => { await options.workspace?.(s); if (!visible) throw new Error('workspace not visible'); }, ...overrides });
  const s = { page, req, response, emit, success, run, state, waits, captures, timeouts, form, clock: () => clock, advance: ms => { clock += ms; }, clicks: () => clicks, disposed: () => disposed, show: () => { visible = true; }, clean: () => { for (const e of events) assert.equal(page.listenerCount(e), 0, e); } };
  return s;
}
test('current POST200 verifies bootstrap user/header and actual workspace without a retry', async () => { const s = setup({ status: 200 }); await s.run(); assert.equal(s.clicks(), 1); assert.deepEqual(s.waits, []); assert.equal(s.disposed(), 1); s.clean(); });
test('own completed POST429 waits Retry-After and clicks the same form exactly once more', async () => { const s = setup(); await s.run(); assert.equal(s.clicks(), 2); assert.deepEqual(s.waits, [1100]); assert.equal(s.captures.at(-1).phase, 'workspace'); s.clean(); });
test('a second429 is terminal and cannot mint a new retry on repeated invocation', async () => { const s = setup({ click: s => s.emit(429) }); await assert.rejects(s.run(), /Second phone/); await assert.rejects(s.run(), /previously failed/); assert.equal(s.clicks(), 2); s.clean(); });
for (const status of [401, 403, 500, 503]) test(`POST${status} never resubmits`, async () => { const s = setup({ status }); await assert.rejects(s.run(), /did not return 200/); assert.equal(s.clicks(), 1); s.clean(); });
for (const at of ['capture', 'wait', 'read', 'workspace', 'dispose']) test(`superseding request during ${at} cannot reuse an old429 or pass success`, async () => {
  let changed = false;
  const change = s => { if (!changed && (s.clicks() || at === 'read')) { changed = true; s.emit(401); } };
  const s = setup({ [at]: change }); await assert.rejects(s.run(), /operation changed/); assert.ok(s.clicks() <= (['workspace', 'dispose'].includes(at) ? 2 : 1)); s.clean();
});
for (const at of ['capture', 'wait']) for (const change of ['navigation', 'network', 'replacement-response', 'form', 'bootstrap-before-login']) test(`${change} during ${at} invalidates the429 allowance`, async () => {
  let first;
  const s = setup({ click: s => { first = s.emit(429); }, [at]: s => {
    if (change === 'navigation') s.page.emit('framenavigated', s.page.mainFrame());
    if (change === 'network') s.page.emit('requestfailed', first.request());
    if (change === 'replacement-response') s.page.emit('response', s.response(200, first.request()));
    if (change === 'form') s.state.unchanged = false;
    if (change === 'bootstrap-before-login') s.emit(200, s.req('/api/bootstrap'));
  } });
  await assert.rejects(s.run(), /changed|no longer current/); assert.equal(s.clicks(), 1); s.clean();
});
test('old same URL/body responses never count as a request started by this click', async () => {
  const s = setup({ click: s => { const old = s.req(); s.page.emit('response', s.response(429, old)); s.page.emit('requestfinished', old); } });
  await assert.rejects(s.run(), /pending/); assert.equal(s.clicks(), 1); s.clean();
});
for (const variant of ['foreign', 'path', 'query', 'method', 'body', 'password', 'extra', 'frame']) test(`${variant} request cannot authorize a retry`, async () => {
  const s = setup({ click: s => {
    const path = variant === 'foreign' ? 'https://foreign.invalid/api/auth/login-phone' : variant === 'path' ? '/api/auth/login-phone-extra' : variant === 'query' ? '/api/auth/login-phone?old=1' : '/api/auth/login-phone';
    const extra = variant === 'method' ? { method: () => 'GET' } : variant === 'frame' ? { frame: () => ({}) } : ['body', 'password', 'extra'].includes(variant) ? { postDataJSON: () => ({ phone: variant === 'body' ? '13900000002' : phone, password: variant === 'password' ? 'changed' : password, ...(variant === 'extra' ? { other: true } : {}) }) } : {};
    s.emit(429, s.req(path, extra));
  } }); await assert.rejects(s.run(), /changed|pending/); assert.equal(s.clicks(), 1); s.clean();
});
for (const retryAfter of [undefined, '', 'invalid', '-1', '121', '99999999']) test(`invalid Retry-After ${retryAfter} fails before an extra click`, async () => {
  const s = setup({ click: s => s.emit(429, s.req(), { headers: () => ({ 'retry-after': retryAfter }) }) }); await assert.rejects(s.run(), /bounded server/); assert.equal(s.clicks(), 1); s.clean();
});
test('insufficient original deadline cannot authorize a retry', async () => { const s = setup({ deadline: 6500 }); await assert.rejects(s.run(), /original test budget/); assert.equal(s.clicks(), 1); s.clean(); });
test('screenshot time consumes the original budget and cannot extend Retry-After', async () => { const s = setup({ capture: (s, value) => { if (value.phase === 'rate-limited') s.advance(500); } }); await s.run(); assert.deepEqual(s.waits, [600]); assert.equal(s.clock(), 2100); });
for (const failure of ['login-user', 'bootstrap-user', 'bootstrap-header', 'bootstrap-429', 'bootstrap-500', 'bootstrap-network', 'bootstrap-pending']) test(`${failure} after POST200 never resends the POST`, async () => {
  const s = setup({ click: s => {
    s.emit(200, s.req(), { json: async () => ({ user: { id: failure === 'login-user' ? 'synthetic-B' : user } }) });
    const req = s.req('/api/bootstrap', failure === 'bootstrap-header' ? { headers: () => ({ 'x-expected-user-id': 'synthetic-B' }) } : {});
    if (failure === 'bootstrap-network' || failure === 'bootstrap-pending') { s.page.emit('request', req); if (failure === 'bootstrap-network') s.page.emit('requestfailed', req); }
    else s.emit(failure === 'bootstrap-429' ? 429 : failure === 'bootstrap-500' ? 500 : 200, req, { json: async () => ({ user: { id: failure === 'bootstrap-user' ? 'synthetic-B' : user } }) });
  } }); await assert.rejects(s.run(), /different user|expected user|operation changed|pending/); assert.equal(s.clicks(), 1); s.clean();
});
test('ordinary catalog error respects real product workspace behavior without resubmission', async () => {
  const s = setup({ click: s => { s.emit(200); s.emit(200, s.req('/api/bootstrap')); s.emit(500, s.req('/api/user/model-catalog')); s.show(); } }); await s.run(); assert.equal(s.clicks(), 1); s.clean();
});
test('concurrent login is rejected before any additional prepare or click', async () => {
  let release; const gate = new Promise(r => { release = r; }); const s = setup({ capture: (_, state) => state.phase === 'rate-limited' ? gate : undefined });
  const running = s.run(); await new Promise(r => setImmediate(r)); await assert.rejects(s.run(), /Concurrent/); release(); await running; assert.equal(s.clicks(), 2); s.clean();
});
test('API200 asserts the exact expected user and API429 stays explicit failure', async () => {
  const s = setup(); await assertExpectedLoginUser(s.response(200), user);
  await assert.rejects(assertExpectedLoginUser(s.response(200), 'synthetic-B'), /different user/);
  await assert.rejects(assertExpectedLoginUser(s.response(429), user), /did not return 200/);
});
test('native spec preserves held ACK, CAS, UUID, same-document and privacy assertions', async () => {
  const source = await readFile(new URL('../e2e/task-metadata.spec.ts', import.meta.url), 'utf8');
  assert.match(source, /apiLogin\(context, phoneB, ownerB.id\)/); assert.match(source, /apiLogin\(context, phoneA, ownerA.id\)/);
  assert.ok(source.indexOf('uiPhoneLogin(page, info, phoneA, ownerA.id)') < source.indexOf('release(); await expect.poll(() => fulfilled)'));
  for (const text of ['performance.timeOrigin)).toBe(timeOrigin)', "not.toContainText('账号A私密冻结标题-991')", 'newCommand.client_request_id).not.toBe(firstSent.client_request_id)', 'newCommand.expected_revision).toBe(1)', 'sent.expected_revision).toBe(0)']) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source.slice(source.indexOf('async function apiLogin'), source.indexOf("test('same live")), /retry|429|setTimeout/);
});
test('failure of an older same-owner model read is diagnostic and cannot invalidate the current workspace', async () => {
  const s = setup({ click: s => { s.emit(200); s.emit(200, s.req('/api/bootstrap')); const older = s.req('/api/user/model-catalog'); s.page.emit('request', older); s.emit(200, s.req('/api/user/model-catalog')); s.page.emit('requestfailed', older); s.show(); } });
  await s.run(); assert.equal(s.clicks(), 1); s.clean();
});
test('a newer login in the final adapter read is rejected before the extra control click', async () => {
  const s = setup(); const original = s.form.click;
  s.form.click = async (timeout, begin, current) => { if (s.clicks()) s.emit(401); return original(timeout, begin, current); };
  await assert.rejects(s.run(), /operation changed/); assert.equal(s.clicks(), 1); s.clean();
});
for (const attempt of [1, 2]) test(`network-unknown on submit ${attempt} cannot replay the POST`, async () => {
  const s = setup({ click: (s, count) => { if (count < attempt) return s.emit(429); const req = s.req(); s.page.emit('request', req); s.page.emit('requestfailed', req); } });
  await assert.rejects(s.run(), /operation changed/); assert.equal(s.clicks(), attempt); s.clean();
});
for (const body of ['login', 'bootstrap']) test(`supersession while reading the ${body} response body cannot pass success`, async () => {
  const s = setup({ click: s => {
    const staleBody = { json: async () => { s.emit(401); return { user: { id: user } }; } };
    s.emit(200, s.req(), body === 'login' ? staleBody : {});
    s.emit(200, s.req('/api/bootstrap'), body === 'bootstrap' ? staleBody : {}); s.show();
  } }); await assert.rejects(s.run(), /operation changed/); assert.equal(s.clicks(), 1); s.clean();
});
test('old bootstrap response arriving after the current successful chain cannot substitute its identity', async () => {
  const s = setup({ click: s => { const old = s.req('/api/bootstrap'); s.success(); s.page.emit('response', s.response(200, old, { json: async () => ({ user: { id: 'synthetic-B' } }) })); s.page.emit('requestfinished', old); } });
  await s.run(); assert.equal(s.clicks(), 1); s.clean();
});
test('state polling and final workspace retain five-second bounds while native actions use original remaining time', async () => {
  const s = setup({ status: 200 }), polls = [], destinations = [];
  await s.run({ poll: async (read, timeout) => { polls.push(timeout); assert.equal(await read(), true); }, workspace: async timeout => { destinations.push(timeout); } });
  assert.equal(s.timeouts[0], 15000); assert.ok(polls.length); assert.ok(polls.every(timeout => timeout === 5000)); assert.deepEqual(destinations, [5000]); s.clean();
});
