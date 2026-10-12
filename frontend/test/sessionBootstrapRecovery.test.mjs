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
