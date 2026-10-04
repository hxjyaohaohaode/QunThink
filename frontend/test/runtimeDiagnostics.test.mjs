import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
const result = await build({ entryPoints: [resolve(import.meta.dirname, '../src/observability/runtimeDiagnostics.ts')], bundle: true, format: 'esm', write: false });
const diagnostics = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
test('diagnostics allow only categorical data and are capped at 200 local events', () => {
  diagnostics.clearDiagnostics();
  diagnostics.recordDiagnostic('runtime', 'secret-user-input', 'failed');
  diagnostics.recordDiagnostic('secret', 'workspace', 'failed');
  diagnostics.recordDiagnostic('task', 'workspace', 'private error');
  assert.equal(diagnostics.getDiagnosticEvents().length, 0);
  for (let i = 0; i < 300; i++) diagnostics.recordDiagnostic('request', 'workspace', 'succeeded', i + .8);
  assert.equal(diagnostics.getDiagnosticEvents().length, 200);
  const data = JSON.parse(diagnostics.exportDiagnostics());
  assert.equal(data.events[0].sequence, 101);
  assert.deepEqual(Object.keys(data.events[0]).sort(), ['at', 'durationMs', 'kind', 'outcome', 'sequence', 'surface']);
  assert.equal(data.events.at(-1).durationMs, 300);
});
test('pause and clear actually remove records and never persist them', () => {
  diagnostics.setDiagnosticsEnabled(false); diagnostics.recordDiagnostic('runtime', 'app', 'failed');
  assert.equal(diagnostics.getDiagnosticEvents().length, 0);
  diagnostics.setDiagnosticsEnabled(true); diagnostics.recordDiagnostic('view', 'models', 'succeeded');
  assert.equal(diagnostics.getDiagnosticEvents().length, 1);
  diagnostics.clearDiagnostics(); assert.equal(diagnostics.getDiagnosticEvents().length, 0);
});


test('writing has its own allowlisted local surface without collecting document IDs, text or URLs',()=>{
 const window=new Window({url:'https://qunthink.test'}),previousElement=globalThis.Element;globalThis.Element=window.Element;diagnostics.setDiagnosticsEnabled(true);diagnostics.clearDiagnostics();diagnostics.setDiagnosticSurface('writing');const panel=window.document.createElement('section');panel.setAttribute('data-observe','writing');panel.setAttribute('data-task-id','secret-task-id');const button=window.document.createElement('button');button.textContent='private draft https://private.test';panel.append(button);window.document.body.append(panel);const stop=diagnostics.observeInteractions(window.document);button.click();diagnostics.recordDiagnostic('request',diagnostics.getDiagnosticSurface(),'succeeded',14);const data=diagnostics.exportDiagnostics();assert.equal(diagnostics.getDiagnosticEvents().length,3);assert.equal(diagnostics.getDiagnosticEvents().every(event=>event.surface==='writing'),true);assert.doesNotMatch(data,/secret-task|private draft|private.test|data-task/);for(const event of diagnostics.getDiagnosticEvents())assert.deepEqual(Object.keys(event).filter(key=>!['at','durationMs','kind','outcome','sequence','surface'].includes(key)),[]);stop();window.close();globalThis.Element=previousElement;
});
