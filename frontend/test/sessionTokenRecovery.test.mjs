import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSessionTokenRecovery, isSessionTokenResponse } from '../scripts/session-token-retry.mjs';

const origin = 'http://127.0.0.1:3210';
const response = (status, retryAfter, url = `${origin}/api/auth/token`, method = 'GET') => ({
  status: () => status, headers: () => ({ 'retry-after': retryAfter }), url: () => url, request: () => ({ method: () => method }),
});
function setup(overrides = {}) {
  const events = []; let time = 100000, retries = 0;
  const recover = createSessionTokenRecovery({
    origin: () => origin, remainingBudgetMs: () => 45000, now: () => time,
    onRateLimited: async () => { events.push('observe-visible-retry'); },
    wait: async ms => { events.push(['wait', ms]); time += ms; },
    retry: async () => { retries++; events.push('click-real-retry'); return response(200); },
    ...overrides,
  });
  return { recover, events, retries: () => retries };
}

test('only same-origin GET /api/auth/token qualifies for session recovery', () => {
  assert.equal(isSessionTokenResponse(response(429, '10'), origin), true);
  for (const [url, method] of [
    ['https://third-party.test/api/auth/token', 'GET'], [`${origin}/api/auth/register`, 'POST'],
    [`${origin}/api/auth/me`, 'GET'], [`${origin}/api/auth/token-extra`, 'GET'],
    [`${origin}/api/auth/token`, 'POST'], ['invalid', 'GET'],
  ]) assert.equal(isSessionTokenResponse(response(429, '10', url, method), origin), false);
});

test('a real token 429 waits the server interval then clicks exactly once', async () => {
  const s = setup();
  assert.equal((await s.recover(response(429, '10'))).status(), 200);
  assert.equal(s.retries(), 1);
  assert.deepEqual(s.events, ['observe-visible-retry', ['wait', 10100], 'click-real-retry']);
});

test('a successful token read preserves the one recovery allowance for a later reload', async () => {
  const s = setup();
  await s.recover(response(200)); assert.deepEqual(s.events, []);
  await s.recover(response(429, '2')); assert.equal(s.retries(), 1);
});

test('the same page cannot receive a second recovery after later navigation', async () => {
  const s = setup(); await s.recover(response(429, '2')); await s.recover(response(200));
  await assert.rejects(s.recover(response(429, '2')), /second session 429/);
  assert.equal(s.retries(), 1);
});

test('concurrent real token 429 responses reserve only one recovery before awaiting', async () => {
  let clicks = 0, observations = 0, waits = 0;
  const s = setup({
    onRateLimited: async () => { observations++; await Promise.resolve(); },
    wait: async () => { waits++; await Promise.resolve(); },
    retry: async () => { clicks++; return response(200); },
  });
  const results = await Promise.allSettled([s.recover(response(429, '2')), s.recover(response(429, '2'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /second session 429/);
  assert.equal(observations, 1); assert.equal(waits, 1); assert.equal(clicks, 1);
});

test('a failed reserved recovery cannot authorize another attempt on that page', async () => {
  const s = setup({ onRateLimited: async () => { throw new Error('recovery screen missing'); } });
  await assert.rejects(s.recover(response(429, '2')), /recovery screen missing/);
  await assert.rejects(s.recover(response(429, '2')), /second session 429/);
  assert.equal(s.retries(), 0); assert.deepEqual(s.events, []);
});

test('an immediate second token 429 fails without any third request', async () => {
  let retries = 0;
  const s = setup({ retry: async () => { retries++; return response(429, '2'); } });
  await assert.rejects(s.recover(response(429, '2')), /HTTP 429/);
  assert.equal(retries, 1);
});

test('non-429 statuses remain failures without waiting or clicking', async () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const s = setup(); await assert.rejects(s.recover(response(status, '2')), new RegExp(`HTTP ${status}`));
    assert.deepEqual(s.events, []); assert.equal(s.retries(), 0);
  }
});

test('unrelated response cannot authorize a retry even when it is 429', async () => {
  const s = setup();
  await assert.rejects(s.recover(response(429, '2', `${origin}/api/auth/me`)), /real same-origin GET/);
  assert.deepEqual(s.events, []);
});

test('missing invalid or excessive Retry-After fails before a retry', async () => {
  for (const value of [undefined, '', 'garbage', '-1', '121']) {
    const s = setup(); await assert.rejects(s.recover(response(429, value)), /bounded server Retry-After/);
    assert.deepEqual(s.events, []); assert.equal(s.retries(), 0);
  }
});

test('a valid wait outside the original deadline fails instead of adding time', async () => {
  const s = setup({ remainingBudgetMs: () => 12000 });
  await assert.rejects(s.recover(response(429, '10')), /original test budget/);
  assert.deepEqual(s.events, []); assert.equal(s.retries(), 0);
});

test('budget is rechecked after collecting the actual rate-limit UI evidence', async () => {
  let budget = 45000;
  const s = setup({ remainingBudgetMs: () => budget, onRateLimited: async () => { budget = 5000; } });
  await assert.rejects(s.recover(response(429, '10')), /original test budget/);
  assert.deepEqual(s.events, []); assert.equal(s.retries(), 0);
});

test('missing real retry button fails without a blind navigation action', async () => {
  const s = setup({ onRateLimited: async () => { throw new Error('button absent'); } });
  await assert.rejects(s.recover(response(429, '2')), /button absent/);
  assert.deepEqual(s.events, []); assert.equal(s.retries(), 0);
});

test('network uncertainty during the real retry propagates without another attempt', async () => {
  let retries = 0;
  const s = setup({ retry: async () => { retries++; throw new Error('network uncertainty'); } });
  await assert.rejects(s.recover(response(429, '2')), /network uncertainty/);
  assert.equal(retries, 1);
});

test('a retry returning a different endpoint fails instead of claiming session recovery', async () => {
  const s = setup({ retry: async () => response(200, undefined, `${origin}/api/auth/me`) });
  await assert.rejects(s.recover(response(429, '2')), /unrelated response/);
});

test('workspace integrates only bounded real token observation and real retry clicks', async () => {
  const native = await readFile(new URL('../e2e/sessionTokenRecovery.ts', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../e2e/workspace.spec.ts', import.meta.url), 'utf8');
  assert.match(native, /const deadline = Date\.now\(\) \+ info\.timeout/);
  assert.match(native, /remainingBudgetMs: \(\) => deadline - Date\.now\(\)/);
  assert.match(native, /observeSessionTokenAttempt\(\{ page, origin: \(\) => page\.url\(\), action, timeout \}\)/);
  assert.match(native, /retry\.click\(\{ timeout \}\)/);
  assert.doesNotMatch(native, /setTimeout|setDefaultTimeout|page\.reload|page\.goto|waitForAuthenticatedDestination|route\(/);
  assert.match(workspace, /test\.beforeEach.*beginSessionTokenRecovery\(page, info\)/);
  assert.equal((workspace.match(/page\.(?:goto|reload)\(/g) || []).length, (workspace.match(/navigateWithSessionTokenRecovery\(page, timeout => page\.(?:goto|reload)\(/g) || []).length);
  for (const original of ['expect(bootstraps).toContain(bob.id)', 'expect(session.valid).toBe(true)', 'expect(me.user.id).toBe(bob.id)', 'expect(uploads).toEqual([])', "not.toContainText('Private-QA-Canary-39208')", 'toHaveCount(1)']) assert.ok(workspace.includes(original), `Original assertion retained: ${original}`);
});

test('empty-model-center screenshot follows actual view assertions and precedes reload persistence check', async () => {
  const source = await readFile(new URL('../e2e/workspace.spec.ts', import.meta.url), 'utf8');
  const fresh = source.slice(source.indexOf("test('fresh accounts"), source.indexOf("test('real API"));
  const picture = fresh.indexOf("info.outputPath('byok-empty-model-center.png')");
  const visible = fresh.indexOf('await expect(models).toBeVisible()');
  const disabled = fresh.indexOf("name: '保存并应用', exact: true })).toBeDisabled()");
  const reload = fresh.indexOf('page.reload({ timeout })');
  for (const [name, index] of Object.entries({ picture, visible, disabled, reload })) assert.ok(index >= 0, `${name} must exist before testing order`);
  assert.ok(visible < picture); assert.ok(disabled < picture); assert.ok(picture < reload);
  assert.match(fresh.slice(picture), /model-catalog[\s\S]*models\)\.toEqual\(\[\]\)/);
  assert.match(fresh.slice(picture), /expect\(probes\)\.toEqual\(\[\]\)/);
});
