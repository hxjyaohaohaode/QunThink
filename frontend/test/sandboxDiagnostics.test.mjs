import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { runInNewContext } from 'node:vm';
const built = await build({ entryPoints: [new URL('../e2e/sandboxDiagnostics.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { readVersionDiagnostics, readSandboxDiagnostics, assertLinuxBrowserSandbox: verify } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const version = () => ({ executable: '/opt/google/chrome/chrome', commandLine: '/opt/google/chrome/chrome --headless --remote-debugging-pipe' });
const sandbox = () => ({ rows: [
  ['Layer 1 Sandbox', 'Namespace'], ['PID namespaces', 'Yes'], ['Network namespaces', 'Yes'],
  ['Seccomp-BPF sandbox', 'Yes'], ['Seccomp-BPF sandbox supports TSYNC', 'Yes'],
  ['Ptrace Protection with Yama LSM (Broker)', 'Yes'], ['Ptrace Protection with Yama LSM (Non-broker)', 'No'],
], evaluation: 'You are adequately sandboxed.' });
test('actual Linux status labels preserve a non-broker No; SUID is a valid layer 1 alternative', () => {
  const result = verify(version(), sandbox()); assert.equal(result.fields['Ptrace Protection with Yama LSM (Non-broker)'], 'No');
  const alternate = sandbox(); alternate.rows[0][1] = 'SUID'; assert.equal(verify(version(), alternate).fields['Layer 1 Sandbox'], 'SUID');
});
test('DOM readers extract version cells and sandbox table cells, not heading text', () => {
  const window = new Window(); try {
    const v = version(), s = sandbox(); window.document.body.innerHTML = `<h1>Sandbox Status</h1><table><tr><td id="executable_path"> ${v.executable} </td><td id="command_line">${v.commandLine}</td></tr></table><table id="sandbox-status">${s.rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table><p id="evaluation">${s.evaluation}</p>`;
    assert.deepEqual(readVersionDiagnostics(window.document), v); assert.deepEqual(readSandboxDiagnostics(window.document), s);
    // Playwright serializes these callbacks and supplies no argument. Prove the
    // same functions work in a separate realm with only its global document.
    const serializedVersion = runInNewContext(`(${readVersionDiagnostics.toString()})()`, { document: window.document });
    const serializedSandbox = runInNewContext(`(${readSandboxDiagnostics.toString()})()`, { document: window.document });
    assert.deepEqual(JSON.parse(JSON.stringify(serializedVersion)), v);
    assert.deepEqual(JSON.parse(JSON.stringify(serializedSandbox)), s);
    assert.equal(verify(readVersionDiagnostics(window.document), readSandboxDiagnostics(window.document)).executable, v.executable);
  } finally { window.close(); }
});
test('an empty or heading-only status page is explicitly unverified', () => {
  const window = new Window(); try { for (const html of ['', '<h1>Sandbox Status</h1><p>You are adequately sandboxed.</p>']) {
    window.document.body.innerHTML = html; assert.throws(() => verify(readVersionDiagnostics(window.document), readSandboxDiagnostics(window.document)), /unverified/);
    assert.throws(() => verify(version(), readSandboxDiagnostics(window.document)), /unverified/);
  } } finally { window.close(); }
});
for (const [index, row] of sandbox().rows.entries()) test(`missing or unknown field fails closed: ${row[0]}`, () => {
  const missing = sandbox(); missing.rows.splice(index, 1); assert.throws(() => verify(version(), missing), /unverified/);
  const unknown = sandbox(); unknown.rows[index][1] = 'Unknown'; assert.throws(() => verify(version(), unknown), /unverified/);
});
test('inactive layer 1, PID, network, seccomp or TSYNC cannot pass an optimistic evaluation', () => {
  for (let i = 0; i < 5; i++) { const value = sandbox(); value.rows[i][1] = i === 0 ? 'None' : 'No'; assert.throws(() => verify(version(), value), /unverified/); }
});
test('missing, malformed or disabled version fields fail closed', () => {
  for (const patch of [{ executable: null }, { executable: '' }, { executable: 'chrome' }, { commandLine: null }, { commandLine: '' }, { commandLine: '/other/binary' }]) assert.throws(() => verify({ ...version(), ...patch }, sandbox()), /unverified/);
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox', '--no-sandbox=true']) assert.throws(() => verify({ ...version(), commandLine: `${version().commandLine} ${flag}` }, sandbox()), /sandbox-disabling/);
});
test('duplicate/malformed rows or absent/negative overall evaluation fail closed', () => {
  for (const row of [['PID namespaces', 'No'], [], ['extra'], ['extra', 'Yes', 'other'], ['', 'Yes'], ['extra', '']]) { const value = sandbox(); value.rows.push(row); assert.throws(() => verify(version(), value), /unverified/); }
  for (const evaluation of [null, '', 'You are NOT adequately sandboxed.', 'Unknown']) assert.throws(() => verify(version(), { ...sandbox(), evaluation }), /unverified/);
});
test('browser fixture reads built-in pages, keeps sandbox enabled and validates before its success log', async () => {
  const spec = await readFile(new URL('../e2e/task-dependencies.spec.ts', import.meta.url), 'utf8');
  assert.match(spec, /channel: 'chrome', launchOptions: \{ chromiumSandbox: true \}/);
  assert.match(spec, /page\.goto\('chrome:\/\/version'\)/); assert.match(spec, /page\.goto\('chrome:\/\/sandbox'\)/);
  assert.match(spec, /page\.evaluate\(readVersionDiagnostics\)/); assert.match(spec, /page\.evaluate\(readSandboxDiagnostics\)/);
  assert.doesNotMatch(spec, /getBrowserCommandLine|newBrowserCDPSession|args\s*:/);
  assert.ok(spec.indexOf('assertLinuxBrowserSandbox(version, sandbox)') < spec.indexOf("console.log('[dependency-browser-verified]'"));
});
