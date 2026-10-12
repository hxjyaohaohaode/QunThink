import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const source = await readFile(new URL('../src/services/messageCorrelation.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { findMatchingLocalMessage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const pending = { id: 'temp-A', tempId: 'temp-A', sender_type: 'user', status: 'sending' };

test('another tab echo never consumes this tab pending message', () => {
  assert.equal(findMatchingLocalMessage([pending], 'temp-B'), undefined);
  assert.equal(findMatchingLocalMessage([pending], undefined), undefined);
  assert.equal(findMatchingLocalMessage([pending], 'temp-A'), pending);
});

test('an exact late echo can reconcile a failed send, but not an already sent row', () => {
  const failed = { ...pending, status: 'failed' };
  const sent = { ...pending, status: 'sent' };
  assert.equal(findMatchingLocalMessage([failed], 'temp-A'), failed);
  assert.equal(findMatchingLocalMessage([sent], 'temp-A'), undefined);
});
