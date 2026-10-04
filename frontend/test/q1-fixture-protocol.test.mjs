import { Window } from 'happy-dom';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertQ1CiRuntime, messageBubbleSelector, inspectRequest, ORIGINAL, CORRECTION, PURPOSE, INVITATION, completionBody, streamBody } from '../scripts/q1-fixture-protocol.mjs';
test('Q1 runtime guard denies local/browser/listener execution; pure protocol checks need no listener', () => {
  for (const env of [{}, { CI: 'true' }, { CI: 'true', GITHUB_ACTIONS: 'true' }]) assert.throws(() => assertQ1CiRuntime(env), /restricted/);
});
test('fixture evidence separates missing source transfer from fixed output; hold applies only to task', () => {
  const request = text => ({ model: 'q1-fixture-unit', messages: [{ role: 'user', content: text }] });
  const absent = inspectRequest(request(PURPOSE));
  assert.equal(absent.hasOriginal, false); assert.equal(absent.hasCorrection, false); assert.equal(absent.content, INVITATION);
  const full = inspectRequest(request(`${PURPOSE}\n${ORIGINAL}\n${CORRECTION}`));
  assert.equal(full.hasOriginal, true); assert.equal(full.hasCorrection, true); assert.equal(full.hasPurpose, true); assert.equal(full.hold, false);
  assert.equal(inspectRequest(request(`${PURPOSE} Q1-CANCEL-AFTER-DISPATCH`)).hold, true);
  assert.equal(inspectRequest({ ...request(`${PURPOSE} Q1-CANCEL-AFTER-DISPATCH`), stream: true }).hold, false);
  assert.equal(completionBody('OK').choices[0].message.content, 'OK'); assert.match(streamBody('hello'), /\[DONE\]/);
  assert.throws(() => inspectRequest({ model: 'real-provider', messages: [] }), /synthetic/);
});

// A selector regression only: this synthetic DOM does not prove browser UX.
test('message selector targets inner MessageBubble despite shared outer ID', () => {
  const window = new Window();
  const id = '12345678-1234-4234-8234-123456789abc';
  window.document.body.innerHTML = `<div class="relative" data-message-id="${id}"><div><div class="flex group" data-message-id="${id}"><button title="创建任务">task</button></div></div></div>`;
  assert.equal(window.document.querySelectorAll(`[data-message-id="${id}"]`).length, 2);
  const matches = window.document.querySelectorAll(messageBubbleSelector(id));
  assert.equal(matches.length, 1);
  assert.ok(matches[0].matches('.group'));
  assert.ok(matches[0].querySelector('button[title="创建任务"]'));
  assert.throws(() => messageBubbleSelector('bad-selector"],body'), /UUID/);
});
