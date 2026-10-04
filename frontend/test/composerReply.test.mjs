import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserWindow = new Window({ url: 'http://localhost/' });
globalThis.window = browserWindow;
globalThis.document = browserWindow.document;
globalThis.localStorage = browserWindow.localStorage;
globalThis.requestAnimationFrame = browserWindow.requestAnimationFrame.bind(browserWindow);

const bundled = await build({
  entryPoints: [resolve(frontendRoot, 'src/stores/uiStore.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
});
const { useUIStore } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('choosing another reply replaces the first instead of silently sending only one', () => {
  const store = useUIStore.getState();
  store.addReplyingTo('message-1');
  store.addReplyingTo('message-2');
  assert.deepEqual(useUIStore.getState().replyingTo, ['message-2']);

  store.setReplyingTo(['message-3', 'message-4']);
  assert.deepEqual(useUIStore.getState().replyingTo, ['message-4']);

  store.removeReplyingTo('message-4');
  assert.deepEqual(useUIStore.getState().replyingTo, []);
});
