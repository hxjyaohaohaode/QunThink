import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const window = new Window();
globalThis.localStorage = window.localStorage;
const bundled = await build({ entryPoints: [resolve(root, 'src/stores/navigationStore.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { useNavigationStore: store } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const originalTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
const originalFrame = globalThis.requestAnimationFrame, originalCancelFrame = globalThis.cancelAnimationFrame;
const frames = new Map(), timers = new Map();
let sequence = 0;
globalThis.requestAnimationFrame = fn => { const id = ++sequence; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.setTimeout = fn => { const id = ++sequence; timers.set(id, fn); return id; };
globalThis.clearTimeout = id => timers.delete(id);
function flushFrames() { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(0); }
function flushTimers() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); }
beforeEach(() => {
  flushFrames(); flushTimers();
  store.setState({ activeDesktopView: 'workspace', activeMobileTab: 'workspace', isTransitioning: false });
});
after(() => {
  flushFrames(); flushTimers();
  Object.assign(globalThis, { setTimeout: originalTimeout, clearTimeout: originalClearTimeout,
    requestAnimationFrame: originalFrame, cancelAnimationFrame: originalCancelFrame });
  window.close();
});

for (const [setter, field, other] of [
  ['setActiveDesktopView', 'activeDesktopView', 'chat'],
  ['setActiveMobileTab', 'activeMobileTab', 'chats'],
]) {
  test(`${field}: A→B→A before the next frame keeps the latest intent`, () => {
    store.getState()[setter](other);
    store.getState()[setter]('workspace');
    flushFrames();
    assert.equal(store.getState()[field], 'workspace');
  });
  test(`${field}: stale transition completion cannot clear a newer transition`, () => {
    store.getState()[setter](other); flushFrames();
    const oldCompletions = [...timers.values()];
    store.getState()[setter]('settings'); flushFrames();
    assert.equal(store.getState()[field], 'settings');
    for (const complete of oldCompletions) complete();
    assert.equal(store.getState().isTransitioning, true);
    flushTimers(); assert.equal(store.getState().isTransitioning, false);
  });
  test(`${field}: switching is committed in the same UI event as local view state`, () => {
    store.getState()[setter](other);
    assert.equal(store.getState()[field], other);
    assert.equal(store.getState().isTransitioning, true);
  });
}

test('desktop and mobile transition completions cannot end one another', () => {
  store.getState().setActiveDesktopView('settings'); flushFrames();
  const desktopCompletions = [...timers.values()];
  store.getState().setActiveMobileTab('agents'); flushFrames();
  for (const complete of desktopCompletions) complete();
  assert.equal(store.getState().isTransitioning, true);
  flushTimers(); assert.equal(store.getState().isTransitioning, false);
});
