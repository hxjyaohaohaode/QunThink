import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createScopedBootstrapNavigator, createSessionBootstrapRecovery, isSessionUserResponse } from '../scripts/session-bootstrap-recovery.mjs';
const origin = 'http://127.0.0.1:3210';
const events = ['request', 'response', 'requestfinished', 'requestfailed'];
function request(path = '/api/auth/token', method = 'GET') { return { url: () => path.startsWith('http') ? path : origin + path, method: () => method }; }
function response(status, req = request(), retryAfter = '1') { return { status: () => status, request: () => req, url: () => req.url(), headers: () => ({ 'retry-after': retryAfter }) }; }
function setup() {
  const page = new EventEmitter(); let recovered = [], destinationChecks = 0;
  const emit = (status, path = '/api/auth/token') => { const req = typeof path === 'string' ? request(path) : path; page.emit('request', req); const r = response(status, req); page.emit('response', r); page.emit('requestfinished', req); return r; };
  const navigate = createScopedBootstrapNavigator({ page, origin: () => origin, recover: async r => { recovered.push(r); emit(200); emit(200, '/api/auth/me'); } });
  const run = (action, initial = 'recovery', overrides = {}) => {
    let phase = 0;
    return navigate({ action, waitForState: observation => Promise.resolve(observation.classify({ destination: phase++ > 0 || initial === 'destination', recovery: initial === 'recovery' && phase === 1 })), waitForDestination: async () => { destinationChecks++; }, ...overrides });
  };
  const clean = () => { for (const name of events) assert.equal(page.listenerCount(name), 0, name); };
  return { page, emit, navigate, run, recovered, clean, destinationChecks: () => destinationChecks };
}

test('actual token200 plus current me429 with visible recovery selects the me response once', async () => {
  const s = setup(); await s.run(async () => { s.emit(200); s.emit(429, '/api/auth/me'); });
  assert.equal(s.recovered.length, 1); assert.equal(s.recovered[0].url(), origin + '/api/auth/me'); assert.equal(s.destinationChecks(), 1); s.clean();
});
test('current token429 can recover before any me and final token plus me success is mandatory', async () => {
  const s = setup(); await s.run(async () => s.emit(429)); assert.equal(s.recovered.length, 1); s.clean();
});
test('token200 and current me200 with actual destination needs no retry', async () => {
  const s = setup(); await s.run(async () => { s.emit(200); s.emit(200, '/api/auth/me'); }, 'destination'); assert.equal(s.recovered.length, 0); s.clean();
});
test('token-only success, me-only success and a pending me cannot pass a visible destination', async () => {
  for (const mode of ['token', 'me', 'pending']) {
    const s = setup(); await assert.rejects(s.run(async () => {
      if (mode !== 'me') s.emit(200);
      if (mode === 'me') s.emit(200, '/api/auth/me');
      if (mode === 'pending') s.page.emit('request', request('/api/auth/me'));
    }, 'destination'), /known visible state/); assert.equal(s.recovered.length, 0); s.clean();
  }
});
test('late prior me429 cannot authorize retry in the current token generation', async () => {
  const s = setup(); const old = request('/api/auth/me');
  await assert.rejects(s.run(async () => { s.emit(200); s.page.emit('request', old); s.emit(200); s.page.emit('response', response(429, old)); s.page.emit('requestfinished', old); }), /known visible state/);
  assert.equal(s.recovered.length, 0); s.clean();
});
test('late prior token429 cannot override current token200 and me200', async () => {
  const s = setup(); const old = request();
  await s.run(async () => { s.page.emit('request', old); s.emit(200); s.emit(200, '/api/auth/me'); s.page.emit('response', response(429, old)); s.page.emit('requestfinished', old); }, 'destination');
  assert.equal(s.recovered.length, 0); s.clean();
});
test('requests started before this navigation cannot authorize any recovery', async () => {
  const s = setup(); const old = request('/api/auth/me'); s.page.emit('request', old);
  await assert.rejects(s.run(async () => { s.emit(200); s.page.emit('response', response(429, old)); s.page.emit('requestfinished', old); }), /known visible state/); assert.equal(s.recovered.length, 0); s.clean();
});
test('foreign origin, lookalike path and POST me cannot authorize retry', async () => {
  for (const req of [request('https://foreign.invalid/api/auth/me'), request('/api/auth/me-extra'), request('/api/auth/me', 'POST')]) {
    const s = setup(); await assert.rejects(s.run(async () => { s.emit(200); s.emit(429, req); }), /known visible state/); assert.equal(s.recovered.length, 0); s.clean();
  }
});
test('non429 me failures and a contradictory destination never authorize retry', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const s = setup(); await assert.rejects(s.run(async () => { s.emit(200); s.emit(status, '/api/auth/me'); }), /lacks a current bootstrap 429/); assert.equal(s.recovered.length, 0); s.clean();
  }
  const s = setup(); await assert.rejects(s.run(async () => { s.emit(200); s.emit(429, '/api/auth/me'); }, 'destination'), /known visible state/); assert.equal(s.recovered.length, 0); s.clean();
});
test('network failure on current token or me is unknown and never blindly retried', async () => {
  for (const path of ['/api/auth/token', '/api/auth/me']) {
    const s = setup(); await assert.rejects(s.run(async () => { if (path.endsWith('/me')) s.emit(200); const r = request(path); s.page.emit('request', r); s.page.emit('requestfailed', r); }), /request failed; no blind retry/); assert.equal(s.recovered.length, 0); s.clean();
  }
});
test('a retry with only token success cannot falsely finish without its current me success', async () => {
  const s = setup(); const navigate = createScopedBootstrapNavigator({ page: s.page, origin: () => origin, recover: async () => s.emit(200) });
  let phase = 0; await assert.rejects(navigate({ action: async () => { s.emit(200); s.emit(429, '/api/auth/me'); }, waitForState: async o => o.classify({ destination: phase++ > 0, recovery: phase === 1 }), waitForDestination: async () => assert.fail('no successful destination') }), /did not reach current successful token and me/); s.clean();
});
test('deadline, UI assertion and action failures clean all listeners without changing the budget', async () => {
  for (const at of ['action', 'state', 'destination']) {
    const s = setup(); const overrides = at === 'state' ? { waitForState: async () => { throw new Error('original deadline'); } } : at === 'destination' ? { waitForDestination: async () => { throw new Error('UI not ready'); } } : {};
    await assert.rejects(s.run(async () => { if (at === 'action') throw new Error('navigation failed'); s.emit(429); }, 'recovery', overrides), /original deadline|UI not ready|navigation failed/); s.clean();
  }
});
test('concurrent navigation is rejected and later navigation cannot reuse an old me response', async () => {
  const s = setup(); let release; const gate = new Promise(r => { release = r; });
  const first = s.run(async () => { await gate; s.emit(200); s.emit(200, '/api/auth/me'); }, 'destination');
  await assert.rejects(s.run(async () => s.emit(429)), /Concurrent bootstrap/); release(); await first;
  await assert.rejects(s.run(async () => s.emit(200)), /known visible state/); s.clean();
});
function recovery(options = {}) {
  let clock = 1000, clicks = 0, waits = [], observed = [];
  const recover = createSessionBootstrapRecovery({ origin: () => origin, remainingBudgetMs: () => 20000, now: () => clock, wait: async ms => { waits.push(ms); clock += ms; }, onRateLimited: async r => observed.push(r.url()), retry: async () => { clicks++; return response(200); }, ...options });
  return { recover, clicks: () => clicks, waits, observed };
}
test('me429 honors server Retry-After with one real token retry and no business write', async () => {
  const s = recovery(); await s.recover(response(429, request('/api/auth/me'), '2'));
  assert.deepEqual(s.waits, [2100]); assert.equal(s.clicks(), 1); assert.deepEqual(s.observed, [origin + '/api/auth/me']);
  await assert.rejects(s.recover(response(429)), /second bootstrap/); assert.equal(s.clicks(), 1);
});
test('a page reserves its one retry before screenshot or wait awaits', async () => {
  let release; const gate = new Promise(r => { release = r; }); const s = recovery({ onRateLimited: async () => gate });
  const first = s.recover(response(429, request('/api/auth/me'))); await assert.rejects(s.recover(response(429)), /second bootstrap/); release(); await first; assert.equal(s.clicks(), 1);
});
test('missing, invalid, unbounded Retry-After and insufficient original budget fail before clicking', async () => {
  for (const value of [undefined, '', 'bad', '-1', '99999999']) {
    const s = recovery(); const r = response(429, request('/api/auth/me')); r.headers = () => value === undefined ? {} : { 'retry-after': value };
    await assert.rejects(s.recover(r), /bounded server Retry-After|original test budget/); assert.equal(s.clicks(), 0);
  }
  const s = recovery({ remainingBudgetMs: () => 5500 }); await assert.rejects(s.recover(response(429, request('/api/auth/me'))), /original test budget/); assert.equal(s.clicks(), 0);
});
test('non429, nonGET, lookalike and foreign-origin responses cannot authorize a recovery click', async () => {
  for (const r of [response(500, request('/api/auth/me')), response(429, request('/api/auth/me', 'POST')), response(429, request('/api/auth/me-x')), response(429, request('https://foreign.invalid/api/auth/me'))]) {
    const s = recovery(); await assert.rejects(s.recover(r), /requires the real|Only an observed/); assert.equal(s.clicks(), 0);
  }
  assert.equal(isSessionUserResponse(response(429, request('/api/auth/me')), origin), true);
});
test('retry network failure, non200 token and unrelated response cannot masquerade as successful auth', async () => {
  for (const retry of [async () => { throw new Error('network unknown'); }, async () => response(429), async () => response(200, request('/api/auth/me'))]) {
    const s = recovery({ retry }); await assert.rejects(s.recover(response(429, request('/api/auth/me'))), /network unknown|token failed|actual same-origin token/);
  }
});
test('native metadata opt-in uses the original deadline, actual retry control, and no new request dispatch', async () => {
  const s = await readFile(new URL('../e2e/sessionBootstrapRecovery.ts', import.meta.url), 'utf8');
  assert.match(s, /deadline = testDeadlines\.get\(info\) \?\? Date\.now\(\) \+ info\.timeout/); assert.match(s, /remaining = recovery\.deadline - Date\.now\(\) - 5000/);
  assert.match(s, /observeSessionTokenAttempt/); assert.match(s, /retry\.click\(\{ timeout \}\)/); assert.match(s, /readVisibleSessionState\(destination, retry\)/);
  assert.doesNotMatch(s, /setDefaultTimeout|request\.post|request\.put|fetch\(|waitForTimeout/);
});

for (const changed of ['new-me-401', 'new-token-network-failure', 'new-me-200', 'during-screenshot']) test(`stale429 never authorizes a retry after ${changed} changes the current bootstrap`, async () => {
  const page = new EventEmitter(); let clicks = 0, clock = 0;
  const emit = (status, path = '/api/auth/token') => { const req = request(path), r = response(status, req); page.emit('request', req); page.emit('response', r); page.emit('requestfinished', req); return r; };
  const supersede = () => {
    if (changed === 'new-token-network-failure') { const req = request(); page.emit('request', req); page.emit('requestfailed', req); }
    else { emit(200); emit(changed === 'new-me-200' ? 200 : 401, '/api/auth/me'); }
  };
  const recover = createSessionBootstrapRecovery({ origin: () => origin, remainingBudgetMs: () => 20000 - clock, now: () => clock,
    onRateLimited: async () => { if (changed === 'during-screenshot') supersede(); },
    wait: async ms => { clock += ms; if (changed !== 'during-screenshot') supersede(); },
    retry: async () => { clicks++; const token = emit(200); emit(200, '/api/auth/me'); return token; },
  });
  const navigate = createScopedBootstrapNavigator({ page, origin: () => origin, recover }); let phase = 0;
  await assert.rejects(navigate({ action: async () => { emit(200); emit(429, '/api/auth/me'); }, waitForState: async o => o.classify({ destination: phase++ > 0, recovery: phase === 1 }), waitForDestination: async () => assert.fail('no recovery should occur') }), /stale 429/);
  assert.equal(clicks, 0); for (const event of events) assert.equal(page.listenerCount(event), 0);
});


test('all metadata pages in the same test retain its first deadline, including repeated begin calls', async () => {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [new URL('../e2e/sessionBootstrapRecovery.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'playwright-deadline-fixture', setup(b) { b.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'playwright', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const expect=()=>{};', loader: 'js' })); } }] });
  const { beginSessionBootstrapRecovery, navigateWithSessionBootstrapRecovery } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  class Page extends EventEmitter { url() { return origin + '/'; } getByRole() { return {}; } getByTestId() { return {}; } }
  const originalNow = Date.now; let now = 1000, called = 0; Date.now = () => now;
  try {
    const info = { timeout: 10000 }, first = new Page(); beginSessionBootstrapRecovery(first, info);
    now = 9000; const second = new Page(); beginSessionBootstrapRecovery(second, info); beginSessionBootstrapRecovery(first, info);
    for (const page of [first, second]) await assert.rejects(navigateWithSessionBootstrapRecovery(page, async () => { called++; }), /original test budget/);
    assert.equal(called, 0); for (const page of [first, second]) for (const event of events) assert.equal(page.listenerCount(event), 0);
  } finally { Date.now = originalNow; }
});

async function bootstrapAdapter() {
  const { build } = await import('esbuild');
  const result = await build({ entryPoints: [new URL('../e2e/sessionBootstrapRecovery.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'playwright-epoch-fixture', setup(b) {
    b.onResolve({ filter: /^@playwright\/test$/ }, () => ({ path: 'playwright', namespace: 'epoch' }));
    b.onLoad({ filter: /.*/, namespace: 'epoch' }, () => ({ contents: `
      export function expect(locator) { return { toBeVisible: async () => { if (!await locator.isVisible()) throw new Error('UI not visible'); } }; }
      expect.poll = read => ({ not: { toBe: async expected => { if (await read() === expected) throw new Error('bootstrap state still waiting'); } } });
    `, loader: 'js' }));
  } }] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#epochs`);
}
function epochPage() {
  class Page extends EventEmitter {
    destination = false; clicks = 0; navigations = []; retryStatus = 200;
    url() { return origin + '/'; }
    emitResponse(status, path = '/api/auth/token') {
      const req = request(path), r = response(status, req, '0'); this.emit('request', req); this.emit('response', r); this.emit('requestfinished', req); return r;
    }
    getByRole() { return { isVisible: async () => !this.destination, click: async () => { this.clicks++; this.emitResponse(this.retryStatus); if (this.retryStatus === 200) { this.emitResponse(200, '/api/auth/me'); this.destination = true; } } }; }
    getByTestId() { return { isVisible: async () => this.destination }; }
    async screenshot() {}
    async goto() { this.navigations.push('goto'); this.destination = false; this.emitResponse(200); this.emitResponse(429, '/api/auth/me'); }
    async reload() { this.navigations.push('reload'); this.destination = false; this.emitResponse(429); }
  }
  const page = new Page(), attached = [];
  const info = { timeout: 20000, attach: async (name, value) => attached.push(JSON.parse(value.body)), outputPath: name => name };
  const clean = () => { for (const name of events) assert.equal(page.listenerCount(name), 0, name); };
  return { page, info, attached, clean };
}
test('real adapter assigns a new recovery epoch only after completed goto then explicit reload', async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter(); const s = epochPage(); begin(s.page, s.info);
  await navigate(s.page, () => s.page.goto()); assert.equal(s.page.clicks, 1); assert.equal(s.page.destination, true);
  // Repeated begin must not change the shared deadline or the current recovery identity.
  begin(s.page, s.info); await navigate(s.page, () => s.page.reload());
  assert.equal(s.page.clicks, 2); assert.deepEqual(s.page.navigations, ['goto', 'reload']);
  assert.deepEqual(s.attached.map(a => a.path), ['/api/auth/me', '/api/auth/token']);
  assert.ok(s.attached[1].remainingBudgetMs < s.attached[0].remainingBudgetMs); s.clean();
});

test('a second 429 within one epoch is terminal and re-navigation cannot mint another retry', async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter(); const s = epochPage(); s.page.retryStatus = 429; begin(s.page, s.info);
  await assert.rejects(navigate(s.page, () => s.page.goto()), /token failed; no further retry/);
  begin(s.page, s.info); await assert.rejects(navigate(s.page, () => s.page.reload()), /prior bootstrap navigation failed/);
  assert.equal(s.page.clicks, 1); assert.deepEqual(s.page.navigations, ['goto']); s.clean();
});
for (const failure of ['401', 'network-unknown']) test(`a current ${failure} cannot authorize clicks or reset a failed epoch`, async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter(); const s = epochPage(); begin(s.page, s.info);
  await assert.rejects(navigate(s.page, async () => {
    s.page.emitResponse(200);
    if (failure === '401') s.page.emitResponse(401, '/api/auth/me');
    else { const r = request('/api/auth/me'); s.page.emit('request', r); s.page.emit('requestfailed', r); }
  }), /lacks a current bootstrap 429|request failed; no blind retry/);
  begin(s.page, s.info); await assert.rejects(navigate(s.page, () => s.page.reload()), /prior bootstrap navigation failed/);
  assert.equal(s.page.clicks, 0); assert.deepEqual(s.page.navigations, []); s.clean();
});
test('late 429 from a completed previous epoch cannot authorize the new epoch recovery', async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter(); const s = epochPage(); begin(s.page, s.info); const old = request('/api/auth/me');
  await navigate(s.page, async () => { s.page.emitResponse(200); s.page.emit('request', old); s.page.emitResponse(200, '/api/auth/me'); s.page.destination = true; });
  await assert.rejects(navigate(s.page, async () => { s.page.destination = false; s.page.emitResponse(200); s.page.emit('response', response(429, old)); s.page.emit('requestfinished', old); }), /bootstrap state still waiting/);
  assert.equal(s.page.clicks, 0); s.clean();
});
test('a successful epoch never extends the original test deadline for reload or repeated begin', async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter(); const s = epochPage(); const originalNow = Date.now; let clock = 1000, reloads = 0; Date.now = () => clock;
  try {
    begin(s.page, s.info);
    await navigate(s.page, async () => { s.page.emitResponse(200); s.page.emitResponse(200, '/api/auth/me'); s.page.destination = true; });
    clock = 17000; begin(s.page, s.info);
    await assert.rejects(navigate(s.page, async () => { reloads++; await s.page.reload(); }), /original test budget/);
    assert.equal(reloads, 0); assert.equal(s.page.clicks, 0); s.clean();
  } finally { Date.now = originalNow; }
});
test('failed action, visible-state check or final UI check permanently closes its navigator epoch', async () => {
  for (const at of ['action', 'state', 'destination']) {
    const s = setup(); let factories = 0;
    const navigate = createScopedBootstrapNavigator({ page: s.page, origin: () => origin, createRecovery: () => { factories++; return async () => { s.emit(200); s.emit(200, '/api/auth/me'); }; } });
    let phase = 0;
    const args = { action: async () => { if (at === 'action') throw new Error('action failed'); s.emit(429); }, waitForState: async o => { if (at === 'state') throw new Error('state failed'); return o.classify({ destination: phase++ > 0, recovery: phase === 1 }); }, waitForDestination: async () => { throw new Error('destination failed'); } };
    await assert.rejects(navigate(args), /failed/); await assert.rejects(navigate(args), /prior bootstrap navigation failed/);
    assert.equal(factories, 1); s.clean();
  }
});

test('separate pages in one test preserve both epoch screenshots and JSON identities', async () => {
  const { beginSessionBootstrapRecovery: begin, navigateWithSessionBootstrapRecovery: navigate } = await bootstrapAdapter();
  const a = epochPage(), b = epochPage(), shots = [], names = [];
  a.info.attach = async (name, value) => { names.push(name); a.attached.push(JSON.parse(value.body)); };
  a.page.screenshot = b.page.screenshot = async ({ path }) => { shots.push(path); };
  begin(a.page, a.info); begin(b.page, a.info);
  await navigate(a.page, () => a.page.goto()); await navigate(b.page, () => b.page.goto());
  assert.equal(new Set(shots).size, 2); assert.equal(new Set(names).size, 2);
  assert.deepEqual(a.attached.map(value => value.navigationEpoch), [1, 2]);
  assert.equal(a.page.clicks, 1); assert.equal(b.page.clicks, 1); a.clean(); b.clean();
});

for (const changed of ['token401', 'token-pending', 'new-successful-pair', 'me-network-failure', 'me429', 'me-pending']) test(`final UI await cannot accept a changed ${changed} bootstrap or open another epoch`, async () => {
  const s = setup();
  await assert.rejects(s.run(async () => s.emit(429), 'recovery', { waitForDestination: async () => {
    if (changed === 'token401') s.emit(401);
    if (changed === 'token-pending') s.page.emit('request', request());
    if (changed === 'new-successful-pair') { s.emit(200); s.emit(200, '/api/auth/me'); }
    if (changed === 'me429') s.emit(429, '/api/auth/me');
    if (changed === 'me-pending' || changed === 'me-network-failure') { const r = request('/api/auth/me'); s.page.emit('request', r); if (changed === 'me-network-failure') s.page.emit('requestfailed', r); }
    await Promise.resolve();
  } }), /current bootstrap changed/);
  await assert.rejects(s.run(async () => s.emit(429)), /prior bootstrap navigation failed/);
  assert.equal(s.recovered.length, 1); s.clean();
});
