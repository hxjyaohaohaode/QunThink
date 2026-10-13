import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createCommandReadGate, disposeCreateReadGate } from '../scripts/create-command-read-gate.mjs';
const require = createRequire(import.meta.url);
const path = require.resolve('playwright-core').replace(/index\.js$/, 'lib/coreBundle.js');
const code = await readFile(path, 'utf8');
const start = code.indexOf('\n    RouteHandler = class {'), end = code.indexOf('\n    RawHeaders = class ', start);
assert.ok(start >= 0 && end > start, 'installed Playwright RouteHandler source must be identifiable');
class ManualPromise extends Promise { constructor() { let resolve, reject; super((yes, no) => { resolve = yes; reject = no; }); this.resolve = resolve; this.reject = reject; } static get [Symbol.species]() { return Promise; } }
// Execute the installed SDK handler verbatim. Only its surrounding primitives
// and the browser transport are stand-ins; no browser process is launched.
const RouteHandler = runInNewContext(code.slice(start, end) + '\nRouteHandler;', { ManualPromise, currentZone: () => ({ without: () => ({ run: fn => fn() }) }), isTargetClosedError2: () => false, rewriteErrorMessage: () => {} });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('failed gate cleanup does not wait for Playwrights still-unhandled route and retains the original failure', async () => {
 const gate = createCommandReadGate({ ownerId: 'owner', origins: ['http://127.0.0.1:3210'] });
 const ticket = gate.begin({ method: 'GET', url: 'http://127.0.0.1:3210/api/tasks', ownerId: 'owner' }); gate.verify(ticket, { status: 200, body: [] });
 const handled = new ManualPromise(); let forwarded = 0;
 const handler = new RouteHandler(undefined, /.*/, async () => { try { await gate.wait(ticket); } catch (error) { if (gate.isCleanupError(error)) return; throw error; } forwarded++; });
 const active = handler.handle({ _startHandling: () => handled, request: () => ({}), _didThrow: false });
 let finished = false, mode;
 const stopping = disposeCreateReadGate(gate, async options => { mode = options.behavior; await handler.stop(options.behavior); }, false).then(() => { finished = true; });
 try { await tick(); assert.equal(finished, true, 'failure cleanup must not await the unresolved SDK handledPromise'); assert.equal(mode, 'ignoreErrors'); assert.equal(forwarded, 0); assert.equal(gate.snapshot().released, false); }
 finally { handled.resolve(true); await active; await stopping; }
 const original = new Error('original actionability failure');
 await assert.rejects(async () => { try { throw original; } finally { await disposeCreateReadGate(gate, options => handler.stop(options.behavior), false); } }, error => error === original);
});
test('successful gate teardown keeps Playwright wait semantics', async () => { let mode; await disposeCreateReadGate({ cleanup() {} }, async options => { mode = options.behavior; }, true); assert.equal(mode, 'wait'); });

test('failed cleanup cannot replace the original test error when unrouteAll itself rejects', async () => {
 const original = new Error('original assertion failure'), teardown = new Error('Target page, context or browser has been closed'); let mode;
 await assert.rejects(async () => { try { throw original; } finally { await disposeCreateReadGate({ cleanup() {} }, async options => { mode = options.behavior; throw teardown; }, false); } }, error => error === original);
 assert.equal(mode, 'ignoreErrors');
});
test('successful cleanup still propagates unrouteAll rejection', async () => {
 const teardown = new Error('failed to finish successful route cleanup');
 await assert.rejects(disposeCreateReadGate({ cleanup() {} }, async options => { assert.equal(options.behavior, 'wait'); throw teardown; }, true), error => error === teardown);
});
