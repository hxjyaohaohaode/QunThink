import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const entry = '/e2e/f07-recovery.html';

test('F07 native fixture uses the real Vite HTML entry without fulfilled HTML or a forged React preamble', async () => {
  const spec = await readFile(new URL('../e2e/f07-message-recovery.spec.ts', import.meta.url), 'utf8');
  assert.ok(spec.includes("page.goto('/e2e/f07-recovery.html'"));
  assert.doesNotMatch(spec, /route\.fulfill|__vite_plugin_react_preamble_installed__|injectIntoGlobalHook|disable-web-security|no-sandbox/);
  const html = await readFile(new URL('../e2e/f07-recovery.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<script type="module" src="\/e2e\/f07RecoveryHarness\.tsx"><\/script>/);
  assert.doesNotMatch(html, /__vite_plugin_react_preamble_installed__|injectIntoGlobalHook|localStorage|document\.cookie/);
  const productionEntry = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(productionEntry + main, /f07-recovery\.html|f07RecoveryHarness/);
});

test('real loopback HTTP: normal Vite HTML transformation supplies React bootstrap before the actual harness module', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'qunthink-f07-vite-entry-'));
  let server;
  t.after(async () => {
    try {
      if (server) {
        try { await server.waitForRequestsIdle(); }
        finally { await server.close(); }
      }
    }
    finally { await rm(temporary, { recursive: true, force: true }); }
  });
  server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'),
    cacheDir: path.join(temporary, 'vite-cache'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(address.address, '127.0.0.1');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const suffix of ['', '?group=fixture%20room']) {
    const response = await fetch(origin + entry + suffix);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.ok(html.includes('/e2e/f07RecoveryHarness.tsx'), 'served entry is the harness, not the application SPA fallback');
    const preamble = html.indexOf('injectIntoGlobalHook(window)');
    assert.ok(preamble >= 0 && preamble < html.indexOf('/e2e/f07RecoveryHarness.tsx'), 'Vite-generated React preamble precedes the harness');
    assert.ok(html.includes('/@react-refresh') && html.includes('/@vite/client'));
    assert.ok(html.includes('window.$RefreshReg$ =') && html.includes('window.$RefreshSig$ ='));
  }
  for (const module of ['/e2e/f07RecoveryHarness.tsx', '/src/components/Chat/MessageInput.tsx', '/src/components/Chat/MessageList.tsx']) {
    const response = await fetch(origin + module);
    assert.equal(response.status, 200);
    const code = await response.text();
    assert.ok(code.length > 0 && !code.includes('<!doctype html>'), 'actual transformed module, not HTML fallback');
  }
});
