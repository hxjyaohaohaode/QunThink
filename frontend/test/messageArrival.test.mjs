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
