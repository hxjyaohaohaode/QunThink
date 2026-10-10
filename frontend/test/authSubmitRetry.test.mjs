import test from 'node:test';
import assert from 'node:assert/strict';
import { submitAuthWithSingleRateLimitRetry } from '../scripts/auth-submit-retry.mjs';
const response = (status, retryAfter) => ({ status: () => status, headers: () => ({ 'retry-after': retryAfter }) });
const time = Date.parse('2026-10-10T02:38:48Z');
function options(events, extra = {}) {
  return { remainingBudgetMs: () => 45000, onRateLimited: async () => { events.push('visible-rejection'); },
    now: () => time, wait: async ms => { events.push(['wait', ms]); }, ...extra };
}
test('confirmed 429 waits for Retry-After, observes the UI, and submits once more', async () => {
  const events = []; let calls = 0;
  const result = await submitAuthWithSingleRateLimitRetry(async () => { events.push('submit'); return ++calls === 1 ? response(429, '10') : response(200); }, options(events));
  assert.equal(result.status(), 200); assert.equal(calls, 2);
  assert.deepEqual(events, ['submit', 'visible-rejection', ['wait', 10100], 'submit']);
});
test('success and non-429 errors never wait or retry', async () => {
  for (const status of [200, 400, 401, 403, 500]) {
    const events = []; let calls = 0; const original = response(status, '10');
    assert.equal(await submitAuthWithSingleRateLimitRetry(async () => { calls++; return original; }, options(events)), original);
    assert.equal(calls, 1); assert.deepEqual(events, []);
  }
});
test('an uncertain network failure is never resubmitted', async () => {
  const events = []; let calls = 0;
  await assert.rejects(submitAuthWithSingleRateLimitRetry(async () => { calls++; throw new Error('lost acknowledgement'); }, options(events)), /lost acknowledgement/);
  assert.equal(calls, 1); assert.deepEqual(events, []);
});
test('missing, malformed and unbounded Retry-After fail without a retry', async () => {
  for (const value of [undefined, '', 'garbage', '-1', '121']) {
    const events = []; let calls = 0;
    await assert.rejects(submitAuthWithSingleRateLimitRetry(async () => { calls++; return response(429, value); }, options(events)), /bounded server Retry-After/);
    assert.equal(calls, 1); assert.deepEqual(events, []);
  }
});
test('server waits exceeding the remaining original budget fail instead of extending it', async () => {
  const events = []; let calls = 0;
  await assert.rejects(submitAuthWithSingleRateLimitRetry(async () => { calls++; return response(429, '10'); }, options(events, { remainingBudgetMs: () => 12000 })), /original test budget/);
  assert.equal(calls, 1); assert.deepEqual(events, []);
});
test('a second 429 is returned without a third attempt', async () => {
  const events = []; let calls = 0;
  const result = await submitAuthWithSingleRateLimitRetry(async () => { calls++; return response(429, '10'); }, options(events));
  assert.equal(result.status(), 429); assert.equal(calls, 2);
  assert.deepEqual(events, ['visible-rejection', ['wait', 10100]]);
});
test('a failed visible-rejection check cannot trigger a blind retry', async () => {
  const events = []; let calls = 0;
  await assert.rejects(submitAuthWithSingleRateLimitRetry(async () => { calls++; return response(429, '10'); }, options(events, { onRateLimited: async () => { throw new Error('not visible'); } })), /not visible/);
  assert.equal(calls, 1); assert.deepEqual(events, []);
});
test('time consumed while collecting UI evidence is rechecked against the deadline', async () => {
  const events = []; let calls = 0, remaining = 45000;
  await assert.rejects(submitAuthWithSingleRateLimitRetry(async () => { calls++; return response(429, '10'); }, options(events, {
    remainingBudgetMs: () => remaining, onRateLimited: async () => { remaining = 5000; },
  })), /original test budget/);
  assert.equal(calls, 1); assert.deepEqual(events, []);
});
