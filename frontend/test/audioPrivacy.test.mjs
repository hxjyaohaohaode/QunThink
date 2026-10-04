import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

test('old account-independent TTS cache is removed and new audio stays in memory', async () => {
  const browserWindow = new Window({ url: 'http://localhost/' });
  globalThis.window = browserWindow;
  globalThis.localStorage = browserWindow.localStorage;
  browserWindow.localStorage.setItem('tts-audios-store', JSON.stringify({
    state: { ttsAudios: { old: { transcript: 'private from another account' } } }
  }));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bundled = await build({
    entryPoints: [resolve(root, 'src/stores/audioStore.ts')],
    bundle: true, format: 'esm', platform: 'browser', write: false
  });
  const { useAudioStore } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
  assert.equal(browserWindow.localStorage.getItem('tts-audios-store'), null);
  assert.deepEqual(useAudioStore.getState().ttsAudios, {});
  useAudioStore.getState().setTTSAudio('current', {
    audioUrl: '/api/tts/audio/current.wav', transcript: 'current account', createdAt: new Date().toISOString()
  });
  assert.equal(browserWindow.localStorage.getItem('tts-audios-store'), null);
  useAudioStore.getState().clearAll();
  assert.deepEqual(useAudioStore.getState().ttsAudios, {});
});
