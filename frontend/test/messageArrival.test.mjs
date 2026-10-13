import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/utils/messageArrival.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
const { appendedMessages } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const row = (id, second = id, extra = {}) => ({ id: String(id), created_at: new Date(2026, 0, 1, 0, 0, second).toISOString(), ...extra });
test('initial history and prepended pages never masquerade as new user activity', () => {
  const latest = [row(10), row(11), row(12)];
  assert.deepEqual(appendedMessages([], latest), []);
  assert.deepEqual(appendedMessages(latest, [row(1), row(2), ...latest]), []);
});
test('a real append is detected even when deletion keeps the total count unchanged', () => {
  assert.deepEqual(appendedMessages([row(1), row(2)], [row(2), row(3)]).map(item => item.id), ['3']);
});
test('identical timestamps retain the actual tail order, not timestamp guesses', () => {
  assert.deepEqual(appendedMessages([row(2, 1)], [row(1, 1), row(2, 1), row(3, 1)]).map(item => item.id), ['3']);
});
test('the first explicit optimistic send still follows its reply', () => {
  assert.deepEqual(appendedMessages([], [row(1, 1, { status: 'sending' })]).map(item => item.id), ['1']);
});

test('ordered live arrivals are detected ahead of an independent pending/preview tail', () => {
  const pending = row('temp_X', 50, { status: 'failed', tempId: 'temp_X' });
  assert.deepEqual(appendedMessages([row(10), pending], [row(10), row(11), pending], new Set(['11'])).map(item => item.id), ['11']);
});
test('ordered provenance distinguishes identical before insertion from a late live arrival', () => {
  const previous = [row(100)]; const current = [row(99), ...previous];
  assert.deepEqual(appendedMessages(previous, current, new Set(['99'])).map(item => item.id), ['99']);
  assert.deepEqual(appendedMessages(previous, current, new Set()), []);
});
test('ordered receipt promotion preserves the original send identity without new user activity', () => {
  const previous = [row('temp_X', 1, { tempId: 'temp_X', status: 'sending' })];
  const current = [row('receipt_X', 2, { client_message_id: 'temp_X', status: 'sent' })];
  assert.deepEqual(appendedMessages(previous, current, new Set(['receipt_X'])), []);
});
test('ordered history provenance never uses wall-clock fallback when every old row disappeared', () => {
  assert.deepEqual(appendedMessages([row(100, 1)], [row(99, 59)], new Set()), []);
});

test('the first confirmed live arrival in an empty ordered view is activity', () => {
  assert.deepEqual(appendedMessages([], [row(1)], new Set(['1'])).map(item => item.id), ['1']);
});

test('a batched optimistic send and its receipt remain one detectable logical arrival', () => {
  assert.deepEqual(appendedMessages([row(1)], [row(1), row('receipt_X',2,{client_message_id:'temp_X'})], new Set(['receipt_X'])).map(item=>item.id), ['receipt_X']);
});
