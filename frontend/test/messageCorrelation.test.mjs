import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingLocalMessage } from '../src/services/messageCorrelation.ts';

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
