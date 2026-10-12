import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePhoneLoginDocument } from '../scripts/phone-login-document.mjs';

// Controlled Node/CDP protocol contracts only. These are not native-browser,
// production-login, or cross-document browser execution evidence.
const url = 'http://127.0.0.1:3210/';
const rawEvents = ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached', 'close'];
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class ControlledSession extends EventEmitter {
  constructor(page) { super(); this.page = page; this.commands = []; this.detaches = 0; }
  async send(command) {
    this.commands.push(command);
    for (const name of rawEvents) assert.ok(this.listenerCount(name) > 0, `${name} observed before ${command}`);
    await this.page.hooks.send?.(command, this.page);
    if (command === 'Page.enable') return {};
    assert.equal(command, 'Page.getFrameTree');
    return this.page.tree;
  }
  async detach() {
    this.detaches++;
    await this.page.hooks.detach?.(this.page);
    this.emit('close'); // The observer's own CDP disconnect is intentional.
  }
}

class ControlledPage {
  constructor({ hooks = {}, tree } = {}) {
    this.hooks = hooks;
    this.currentURL = url;
    this.currentDocument = { name: 'original-document' };
    this.tree = tree ?? { frameTree: {
      frame: { id: 'root', loaderId: 'original-loader', url },
      childFrames: [{ frame: { id: 'child', parentId: 'root', loaderId: 'child-loader', url: url + 'frame' } }],
    } };
    this.session = new ControlledSession(this);
    this.handles = [];
    this.evaluations = 0;
    this.handleDisposals = 0;
  }
  url() { return this.currentURL; }
  context() { return { newCDPSession: async page => { assert.equal(page, this); return this.session; } }; }
  inDocument(callback) {
    const existing = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { value: this.currentDocument, configurable: true });
    try { return callback(); }
    finally {
      if (existing) Object.defineProperty(globalThis, 'document', existing);
      else delete globalThis.document;
    }
  }
  async evaluateHandle(callback) {
    assert.deepEqual(this.session.commands, ['Page.enable', 'Page.getFrameTree']);
    const value = this.inDocument(callback);
    assert.equal(value, this.currentDocument, 'retain the actual original Document');
    const handle = { value, dispose: async () => {
      this.handleDisposals++;
      await this.hooks.handleDispose?.(this);
    } };
    this.handles.push(handle);
    await this.hooks.retain?.(this);
    return handle;
  }
  async evaluate(callback, handle) {
    this.evaluations++;
    assert.equal(handle, this.handles[0], 'prove the retained original Document in the current context');
    const read = () => this.inDocument(() => callback(handle.value));
    if (this.hooks.evaluate) return this.hooks.evaluate(this, read);
    return read();
  }
  rawHistory(extra = {}) {
    this.session.emit('Page.navigatedWithinDocument', { frameId: 'root', url, navigationType: 'historyApi', ...extra });
  }
  rawNavigation(frame = {}, type = 'Navigation') {
    this.session.emit('Page.frameNavigated', { frame: { id: 'root', loaderId: 'new-loader', url, ...frame }, type });
  }
  replaceDocument() { this.currentDocument = { name: 'replacement-document' }; }
}

async function controlled(run, options = {}) {
  const page = new ControlledPage(options);
  let loginStatus = null, bootstrapStatus = null, budgetCalls = 0;
  const observer = await observePhoneLoginDocument({
    page,
    budget: () => { budgetCalls++; return 500; },
    admitted: () => loginStatus === 200 && bootstrapStatus === 200,
  });
  const state = {
    page, observer,
    admit: (login = 200, bootstrap = 200) => { loginStatus = login; bootstrapStatus = bootstrap; },
    budgetCalls: () => budgetCalls,
  };
  try { await run(state); }
  finally {
    await observer.dispose();
    for (const name of rawEvents) assert.equal(page.session.listenerCount(name), 0, `remove ${name} after cleanup`);
    assert.equal(page.session.detaches, 1, 'detach once');
    assert.equal(page.handleDisposals, 1, 'release original Document once');
  }
}

async function prove(observer) {
  observer.beginProof();
  assert.equal(observer.verify(), false, 'a new asynchronous proof cannot pass immediately');
  assert.throws(() => observer.assertVerified(), /pending|document|navigation/);
  await flush();
  assert.equal(observer.verify(), true);
  observer.assertVerified();
}

function invalid(observer) {
  assert.throws(() => observer.assertCurrent(), /document|navigation/);
  assert.throws(() => observer.assertVerified(), /document|navigation|pending/);
  assert.throws(() => observer.verify(), /document|navigation/);
}

test('observer installs raw guards before CDP setup and retains the original Document before actions', async () => controlled(async ({ page, observer, budgetCalls }) => {
  assert.deepEqual(page.session.commands, ['Page.enable', 'Page.getFrameTree']);
  assert.ok(budgetCalls() > 0);
  assert.equal(page.evaluations, 0);
  observer.assertNoNavigation();
  assert.throws(() => observer.assertVerified(), /pending/);
  await prove(observer);
  assert.equal(page.evaluations, 1);
}));

test('each checkpoint requires a fresh current-context proof even without navigation events', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  await prove(observer);
  await prove(observer);
  assert.equal(page.evaluations, 3);
  observer.assertNoNavigation();
}));

for (const order of ['RRPP', 'PPRR', 'RPRP', 'PRPR', 'RPPR', 'PRRP']) {
  test(`two admitted same-URL history events allow cross-channel order ${order}`, async () => controlled(async ({ page, observer, admit }) => {
    await prove(observer);
    admit();
    for (const event of order) {
      if (event === 'R') page.rawHistory();
      else observer.navigate();
    }
    assert.throws(() => observer.assertVerified(), /pending/);
    assert.throws(() => observer.assertNoNavigation(), /Navigation/);
    await prove(observer);
    const snapshot = observer.snapshot();
    assert.equal(snapshot.publicEvents, 2);
    assert.equal(snapshot.historyEvents, 2);
    assert.equal(snapshot.verified, true);
    assert.equal(snapshot.invalid, false);
  }));
}

for (const channel of ['raw', 'public']) {
  for (const statuses of [[null, null], [200, null], [200, 429], [429, 200]]) {
    test(`${channel} history before exact login/bootstrap 200 admission is permanently invalid ${JSON.stringify(statuses)}`, async () => controlled(async ({ page, observer, admit }) => {
      admit(...statuses);
      if (channel === 'raw') page.rawHistory();
      else observer.navigate();
      admit();
      if (channel === 'raw') observer.navigate();
      else page.rawHistory();
      invalid(observer);
    }));
  }
}

for (const channel of ['raw', 'public']) {
  test(`third admitted ${channel} history event cannot be accepted as StrictMode initialization`, async () => controlled(async ({ page, observer, admit }) => {
    admit();
    for (let index = 0; index < 2; index++) { page.rawHistory(); observer.navigate(); }
    await prove(observer);
    if (channel === 'raw') page.rawHistory();
    else observer.navigate();
    invalid(observer);
  }));
}

for (const navigationType of ['fragment', 'other', 'unknown', undefined]) {
  test(`unsupported or missing raw same-document type ${navigationType} fails closed`, async () => controlled(async ({ page, observer, admit }) => {
    admit();
    page.rawHistory({ navigationType });
    observer.navigate();
    invalid(observer);
  }));
}

test('different-URL history cannot be repaired by restoring the original URL', async () => controlled(async ({ page, observer, admit }) => {
  admit();
  page.rawHistory({ url: url + 'elsewhere' });
  page.currentURL = url;
  observer.navigate();
  invalid(observer);
}));

for (const missing of ['raw', 'public']) {
  test(`missing ${missing} event remains unverified rather than inferring same-document navigation`, async () => controlled(async ({ page, observer, admit }) => {
    await prove(observer);
    admit();
    if (missing === 'raw') observer.navigate();
    else page.rawHistory();
    observer.beginProof();
    for (let index = 0; index < 5; index++) { assert.equal(observer.verify(), false); await flush(); }
    assert.throws(() => observer.assertVerified(), /pending/);
    assert.equal(page.evaluations, 1, 'unpaired events cannot start a passing proof');
  }));
}

for (const [name, frame, type] of [
  ['same-URL reload', {}, 'Navigation'],
  ['same-URL commit retaining loader ID', { loaderId: 'original-loader' }, 'Navigation'],
  ['changed root identity', { id: 'replacement-root' }, 'Navigation'],
  ['known child promoted to a parentless root', { id: 'child' }, 'Navigation'],
  ['BFCache restore', {}, 'BackForwardCacheRestore'],
  ['root frame with contradictory parent', { parentId: 'unexpected-parent' }, 'Navigation'],
]) {
  test(`raw ${name} invalidates permanently`, async () => controlled(async ({ page, observer, admit }) => {
    await prove(observer);
    admit();
    page.rawNavigation(frame, type);
    observer.navigate();
    invalid(observer);
  }));
}

test('BFCache away and back cannot revive the retained original Document', async () => controlled(async ({ page, observer, admit }) => {
  await prove(observer);
  admit();
  const original = page.currentDocument;
  page.replaceDocument();
  page.rawNavigation({ url: url + 'away' });
  page.currentDocument = original;
  page.rawNavigation({ loaderId: 'original-loader' }, 'BackForwardCacheRestore');
  page.currentURL = url;
  invalid(observer);
}));

test('new current Document without any navigation event is caught at the next checkpoint', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  page.replaceDocument();
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  invalid(observer);
  assert.equal(page.evaluations, 2);
}));

test('known child-frame navigation and detachment do not invalidate the root Document', async () => controlled(async ({ page, observer }) => {
  page.rawNavigation({ id: 'child', parentId: 'root', url: url + 'frame-next' });
  page.rawHistory({ frameId: 'child', url: url + 'frame#fragment', navigationType: 'fragment' });
  page.session.emit('Page.frameDetached', { frameId: 'child', reason: 'remove' });
  await prove(observer);
  observer.assertNoNavigation();
}));

for (const event of ['Page.navigatedWithinDocument', 'Page.frameDetached']) {
  test(`unrecognized frame identity in ${event} fails closed`, async () => controlled(async ({ page, observer }) => {
    page.session.emit(event, { frameId: 'unknown-frame', url, navigationType: 'historyApi' });
    invalid(observer);
  }));
}

test('an unrecognized frame with a claimed parent is not established subframe evidence', async () => controlled(async ({ page, observer }) => {
  page.rawNavigation({ id: 'unknown-frame', parentId: 'root' });
  invalid(observer);
}));

for (const event of ['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached']) {
  test(`missing frame identity in ${event} fails closed`, async () => controlled(async ({ page, observer }) => {
    page.session.emit(event, {});
    invalid(observer);
  }));
}

test('main-frame detachment is permanently invalid', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  page.session.emit('Page.frameDetached', { frameId: 'root', reason: 'swap' });
  invalid(observer);
}));

test('unexpected CDP close invalidates an already verified Document', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  page.session.emit('close');
  invalid(observer);
}));

test('rejected current-context proof cannot retain an earlier checkpoint success', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  page.hooks.evaluate = async () => { throw new Error('Execution context was destroyed'); };
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  invalid(observer);
}));

test('pending proof returns synchronously and cannot pass, restart, or reuse earlier verification', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  const pending = deferred();
  page.hooks.evaluate = () => pending.promise;
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  for (let index = 0; index < 5; index++) assert.equal(observer.verify(), false);
  assert.throws(() => observer.assertVerified(), /pending/);
  assert.throws(() => observer.beginProof(), /pending/);
  assert.equal(page.evaluations, 2, 'polling cannot create overlapping unbounded RPCs');
  pending.resolve(true);
  await flush();
  assert.throws(() => observer.assertVerified(), /pending/);
  assert.equal(observer.verify(), true);
  observer.assertVerified();
}));

test('history arriving during an in-flight proof requires a newer proof revision', async () => controlled(async ({ page, observer, admit }) => {
  const pending = deferred();
  page.hooks.evaluate = () => pending.promise;
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  admit();
  page.rawHistory(); observer.navigate();
  pending.resolve(true);
  await flush();
  assert.throws(() => observer.assertVerified(), /pending/);
  page.hooks.evaluate = undefined;
  assert.equal(observer.verify(), false, 'old revision cannot pass');
  await flush();
  assert.equal(observer.verify(), true);
  observer.assertVerified();
  assert.equal(page.evaluations, 2);
}));

test('intentional CDP close during cleanup preserves an already verified Document', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  await observer.dispose();
  observer.assertCurrent();
  observer.assertVerified();
  assert.equal(page.session.detaches, 1);
}));

test('final checkpoint after CDP detach obtains a fresh proof before releasing the Document', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  await observer.detach();
  assert.equal(page.handleDisposals, 0);
  await prove(observer);
  assert.equal(page.evaluations, 2);
  await observer.dispose();
  observer.assertVerified();
  assert.throws(() => observer.beginProof(), /pending/);
}));

test('silent Document replacement during detach is caught by the final fresh proof', async () => controlled(async ({ page, observer }) => {
  await prove(observer);
  page.hooks.detach = async () => { await Promise.resolve(); page.replaceDocument(); };
  await observer.detach();
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  invalid(observer);
}));

test('disposing with a still-pending proof cannot manufacture terminal verification', async () => controlled(async ({ page, observer }) => {
  const pending = deferred();
  page.hooks.evaluate = () => pending.promise;
  observer.beginProof();
  assert.equal(observer.verify(), false);
  await flush();
  await observer.dispose();
  assert.equal(observer.verify(), false);
  assert.throws(() => observer.assertVerified(), /pending/);
  pending.resolve(true);
  await flush();
  assert.throws(() => observer.assertVerified(), /pending/);
}));

for (const during of ['detach', 'handleDispose']) {
  test(`cross-document navigation while awaiting ${during} remains observed`, async () => controlled(async ({ page, observer }) => {
    await prove(observer);
    page.hooks[during] = async () => { await Promise.resolve(); page.rawNavigation(); };
    await observer.dispose();
    invalid(observer);
  }));
  for (const channel of ['raw', 'public']) {
    test(`new ${channel} history while awaiting ${during} cannot authorize final success`, async () => controlled(async ({ page, observer, admit }) => {
      await prove(observer);
      admit();
      page.hooks[during] = async () => {
        await Promise.resolve();
        if (channel === 'raw') page.rawHistory();
        else observer.navigate();
      };
      await observer.dispose();
      invalid(observer);
    }));
  }
}

test('root navigation observed during Page.enable is not forgotten by later setup', async () => {
  const page = new ControlledPage({ hooks: { send: async (command, target) => {
    if (command === 'Page.enable') target.rawNavigation();
  } } });
  await assert.rejects(observePhoneLoginDocument({ page, budget: () => 500, admitted: () => false }), /document|navigation/);
  for (const name of rawEvents) assert.equal(page.session.listenerCount(name), 0);
  assert.equal(page.session.detaches, 1);
});

for (const absent of ['id', 'loaderId']) {
  test(`setup rejects a frame tree missing the original main-frame ${absent}`, async () => {
    const frame = { id: 'root', loaderId: 'original-loader', url };
    delete frame[absent];
    const page = new ControlledPage({ tree: { frameTree: { frame } } });
    await assert.rejects(observePhoneLoginDocument({ page, budget: () => 500, admitted: () => false }), /main frame|document|navigation/);
    assert.equal(page.handles.length, 0);
    for (const name of rawEvents) assert.equal(page.session.listenerCount(name), 0);
  });
}
