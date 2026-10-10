import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createScopedSessionNavigator, createSettledSessionObserver, observeSessionTokenAttempt, readVisibleSessionState } from '../scripts/session-navigation.mjs';
const origin = 'http://127.0.0.1:3210';
const events = ['request', 'response', 'requestfinished', 'requestfailed'];
function request(url = `${origin}/api/auth/token`, method = 'GET') { return { url: () => url, method: () => method }; }
function response(status, req = request()) { return { status: () => status, request: () => req, url: () => req.url() }; }
async function view(observation, state) {
  for (let i = 0; i < 3; i++) {
    const result = observation.classify({ destination: state === 'destination', recovery: state === 'recovery' });
    if (result !== 'waiting') return result;
    await Promise.resolve();
  }
  return 'waiting';
}
function setup({ recover } = {}) {
  const page = new EventEmitter(); let clicks = 0, checks = 0;
  const emit = (status, req = request()) => { page.emit('request', req); const r = response(status, req); page.emit('response', r); page.emit('requestfinished', req); return r; };
  const navigate = createScopedSessionNavigator({ page, origin: () => origin, recover: recover || (async () => { clicks++; emit(200); }) });
  const run = (statuses, state, extras = {}) => {
    let phase = 0;
    return navigate({ action: async () => { statuses.forEach(status => emit(status)); }, waitForState: observation => view(observation, phase++ === 0 ? state : 'destination'), waitForDestination: async () => { checks++; }, ...extras });
  };
  const clean = () => { for (const event of events) assert.equal(page.listenerCount(event), 0, event); };
  return { page, navigate, emit, run, clean, clicks: () => clicks, checks: () => checks };
}

test('200 then 429 with a real recovery page uses the current request once', async () => {
  const s = setup(); await s.run([200, 429], 'recovery'); assert.equal(s.clicks(), 1); assert.equal(s.checks(), 1); s.clean();
});
test('responses arriving after navigation returns remain observed until the UI settles', async () => {
  const s = setup(); let phase = 0;
  await s.run([200], 'recovery', { waitForState: async observation => { if (phase++ === 0) { await Promise.resolve(); s.emit(429); return view(observation, 'recovery'); } return view(observation, 'destination'); } });
  assert.equal(s.clicks(), 1); s.clean();
});
test('429 then 200 with a stable actual destination never retries old throttling', async () => {
  const s = setup(); await s.run([429, 200], 'destination'); assert.equal(s.clicks(), 0); s.clean();
});
test('a contradictory destination with only 429 responses cannot pass', async () => {
  const s = setup(); await assert.rejects(s.run([429, 429], 'destination'), /known visible state/); assert.equal(s.clicks(), 0); s.clean();
});
test('duplicate 429 responses from one navigation produce one recovery only', async () => {
  const s = setup(); await s.run([429, 429], 'recovery'); assert.equal(s.clicks(), 1); assert.equal(s.checks(), 1); s.clean();
});
test('old request 200 arriving after the current 429 cannot replace its evidence', async () => {
  const s = setup(); const old = request(), current = request();
  await s.run([], 'recovery', { action: async () => {
    s.page.emit('request', old); s.page.emit('request', current);
    s.page.emit('response', response(429, current)); s.page.emit('requestfinished', current);
    s.page.emit('response', response(200, old)); s.page.emit('requestfinished', old);
  } }); assert.equal(s.clicks(), 1); s.clean();
});
test('a canceled older pending request cannot block the completed current successful effect', async () => {
  const s = setup(); await s.run([], 'destination', { action: async () => { s.page.emit('request', request()); s.emit(200); } });
  assert.equal(s.clicks(), 0); s.clean();
});
test('a transient visible destination cannot pass while the current token request is pending', () => {
  const observe = createSettledSessionObserver(); const latest = { sequence: 2, response: response(200), finished: false, failed: false };
  assert.equal(observe({ latest, destination: true, recovery: false }), 'waiting');
  assert.equal(observe({ latest, destination: true, recovery: false }), 'waiting');
  latest.response = response(429); latest.finished = true;
  assert.equal(observe({ latest, destination: true, recovery: false }), 'waiting');
  assert.equal(observe({ latest, destination: false, recovery: true }), 'recovery');
});
test('the completed current 200 and actual destination pass on their first observation', () => {
  const observe = createSettledSessionObserver(); const latest = { sequence: 1, response: response(200), finished: true, failed: false };
  assert.equal(observe({ latest, destination: false, recovery: false }), 'waiting');
  assert.equal(observe({ latest, destination: true, recovery: false }), 'destination');
  assert.equal(observe({ latest: { ...latest, sequence: 2, finished: false }, destination: true, recovery: false }), 'waiting');
});

test('a visible destination avoids the recovery RPC completely within the original polling budget', async () => {
  let elapsed = 138, destinationCalls = 0, retryCalls = 0;
  const visible = await readVisibleSessionState(
    { isVisible: async () => { destinationCalls++; elapsed += 138; return true; } },
    { isVisible: async () => { retryCalls++; throw new Error('absent recovery RPC must not run'); } },
  );
  assert.deepEqual(visible, { destination: true, recovery: false });
  assert.equal(destinationCalls, 1); assert.equal(retryCalls, 0); assert.ok(elapsed < 5000);
  const observe = createSettledSessionObserver();
  assert.equal(observe({ latest: { response: response(200), finished: true }, ...visible }), 'destination');
  assert.equal(observe({ latest: { response: response(200), finished: false }, ...visible }), 'waiting');
  assert.equal(observe({ latest: { response: response(429), finished: true }, ...visible }), 'waiting');
});
test('an absent destination queries the real recovery button exactly once and propagates its visibility', async () => {
  for (const recovery of [false, true]) {
    const calls = [];
    const visible = await readVisibleSessionState(
      { isVisible: async () => { calls.push('destination'); return false; } },
      { isVisible: async () => { calls.push('retry'); return recovery; } },
    );
    assert.deepEqual(calls, ['destination', 'retry']);
    assert.deepEqual(visible, { destination: false, recovery });
  }
});
test('visibility RPC failures propagate without inventing a successful page or recovery evidence', async () => {
  await assert.rejects(readVisibleSessionState(
    { isVisible: async () => { throw new Error('destination RPC failed'); } },
    { isVisible: async () => { assert.fail('retry must not run'); } },
  ), /destination RPC failed/);
  await assert.rejects(readVisibleSessionState(
    { isVisible: async () => false }, { isVisible: async () => { throw new Error('retry RPC failed'); } },
  ), /retry RPC failed/);
});
test('non-429 failures and a current 503 after an old 429 cannot authorize retry', async () => {
  for (const statuses of [[500], [401], [200], [429, 503]]) {
    const s = setup(); await assert.rejects(s.run(statuses, 'recovery'), /lacks a current token 429|known visible state/); assert.equal(s.clicks(), 0); s.clean();
  }
});
test('a recovery page without observed token 429 remains a failure', async () => {
  const s = setup(); await assert.rejects(s.run([], 'recovery'), /latest: none/); assert.equal(s.clicks(), 0); s.clean();
});
test('an old response cannot leak into a later navigation', async () => {
  const s = setup(); await s.run([429, 200], 'destination'); await assert.rejects(s.run([], 'recovery'), /latest: none/); assert.equal(s.clicks(), 0); s.clean();
});
test('late old-request responses are rejected by per-navigation request identity', async () => {
  const s = setup(), old = request(); s.page.emit('request', old);
  await assert.rejects(s.run([], 'recovery', { action: async () => { s.page.emit('response', response(429, old)); s.page.emit('requestfinished', old); } }), /latest: none/);
  assert.equal(s.clicks(), 0); s.clean();
});
test('unrelated origins paths and POSTs cannot authorize session recovery', async () => {
  for (const req of [request('https://elsewhere.test/api/auth/token'), request(`${origin}/api/auth/me`), request(`${origin}/api/auth/token`, 'POST')]) {
    const s = setup(); await assert.rejects(s.run([], 'recovery', { action: async () => { s.emit(429, req); } }), /latest: none/); assert.equal(s.clicks(), 0); s.clean();
  }
});
test('concurrent navigation is rejected before installing another set of listeners', async () => {
  const s = setup(); let release; const held = new Promise(resolve => { release = resolve; });
  const first = s.run([], 'destination', { action: async () => { await held; s.emit(200); } });
  await assert.rejects(s.run([429], 'recovery'), /Concurrent session navigation/);
  for (const event of events) assert.equal(s.page.listenerCount(event), 1);
  release(); await first; assert.equal(s.clicks(), 0); s.clean();
});
test('current request failure cannot be mistaken for a successful destination', async () => {
  const s = setup(); await assert.rejects(s.run([], 'destination', { action: async () => { const req = request(); s.page.emit('request', req); s.page.emit('requestfailed', req); } }), /current session token request failed/); s.clean();
});
test('uncertain navigation failures remove every listener without retrying', async () => {
  const s = setup(); await assert.rejects(s.run([], 'recovery', { action: async () => { throw new Error('network failed'); } }), /network failed/);
  assert.equal(s.clicks(), 0); s.clean(); await s.run([200], 'destination'); s.clean();
});
test('failed UI observations and rejected recovery both clean every scoped listener', async () => {
  const s = setup(); await assert.rejects(s.run([429], 'recovery', { waitForState: async () => { throw new Error('original deadline reached'); } }), /original deadline/); s.clean();
  const r = setup({ recover: async () => { throw new Error('second 429'); } }); await assert.rejects(r.run([429], 'recovery'), /second 429/); r.clean();
});
test('post-retry HTTP success cannot replace the final real destination assertion', async () => {
  const s = setup(); await assert.rejects(s.run([200, 429], 'recovery', { waitForDestination: async () => { throw new Error('destination assertion failed'); } }), /destination assertion failed/);
  assert.equal(s.clicks(), 1); s.clean();
});
test('retry response observer ignores requests that began before the actual click', async () => {
  const s = setup(); const old = request(), current = request();
  const result = await observeSessionTokenAttempt({ page: s.page, origin: () => origin, timeout: 1000, action: async () => {
    s.page.emit('response', response(429, old)); s.page.emit('request', current); s.page.emit('response', response(200, current));
  } }); assert.equal(result.status(), 200); assert.equal(result.request(), current); s.clean();
});
test('retry click failures and network failures clean listeners and bounded deadline timers', async () => {
  for (const mode of ['click', 'network']) {
    const s = setup(); let canceled = false;
    await assert.rejects(observeSessionTokenAttempt({ page: s.page, origin: () => origin, timeout: 1000, schedule: () => 7, cancel: id => { assert.equal(id, 7); canceled = true; }, action: async () => {
      if (mode === 'click') throw new Error('click failed');
      const req = request(); s.page.emit('request', req); s.page.emit('requestfailed', req);
    } }), /failed/); assert.equal(canceled, true); s.clean();
  }
});
test('retry observer fails at its original deadline without adding more time', async () => {
  const s = setup(); let expire, canceled = false;
  await assert.rejects(observeSessionTokenAttempt({ page: s.page, origin: () => origin, timeout: 4321, schedule: (callback, ms) => { assert.equal(ms, 4321); expire = callback; return 8; }, cancel: () => { canceled = true; }, action: async () => { expire(); } }), /original test budget/);
  assert.equal(canceled, true); s.clean();
});
test('native integration keeps original budget, stable real UI and four-listener finally cleanup', async () => {
  const native = await readFile(new URL('../e2e/sessionTokenRecovery.ts', import.meta.url), 'utf8');
  const scope = await readFile(new URL('../scripts/session-navigation.mjs', import.meta.url), 'utf8');
  assert.match(native, /const deadline = Date\.now\(\) \+ info\.timeout/);
  assert.match(native, /remaining = recovery\.deadline - Date\.now\(\) - 5000/);
  assert.match(native, /recovery\.navigate\(\{/); assert.match(native, /observation\.classify/);
  assert.match(native, /observation\.classify\(await readVisibleSessionState\(destination, retry\)\)/);
  assert.match(scope, /destination\.isVisible\(\)/); assert.match(scope, /visible \? false : await retry\.isVisible\(\)/);
  assert.match(native, /waitForDestination:.*expect\(destination\)\.toBeVisible/);
  assert.doesNotMatch(native, /setTimeout|setDefaultTimeout|waitForAuthenticatedDestination|waitForResponse/);
  for (const event of events) assert.ok(scope.includes(`page.off('${event}'`));
  assert.match(scope, /finally[\s\S]*requests\.clear\(\); latest = null; active = false/);
});
test('evidence screenshot waits for actual tab geometry across successive observations', async () => {
  const s = await readFile(new URL('../e2e/workspace.spec.ts', import.meta.url), 'utf8');
  const fresh = s.slice(s.indexOf("test('fresh accounts"), s.indexOf("test('real API"));
  const geometry = fresh.indexOf('const modelTab ='), picture = fresh.indexOf("info.outputPath('byok-empty-model-center.png')");
  assert.ok(geometry >= 0 && picture > geometry); const check = fresh.slice(geometry, picture);
  assert.match(check, /expect\.poll/); assert.match(check, /getBoundingClientRect/); assert.match(check, /aria-current/);
  assert.match(check, /inner\.left >= outer\.left && inner\.right <= outer\.right/);
  assert.match(check, /inner\.left \+ inner\.right - outer\.left - outer\.right/);
  assert.match(check, /previousIndicator\?\.aligned === true/);
  assert.doesNotMatch(check, /waitForTimeout|setTimeout|\.style\s*=/);
});
