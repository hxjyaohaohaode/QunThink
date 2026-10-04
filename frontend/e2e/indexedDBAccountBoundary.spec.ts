import { test, expect, type Page } from '@playwright/test';

// Native IndexedDB coverage for the existing authorized CI browser job. These
// tests do not sign in, call model providers, or require real user data.
async function fixture(page: Page) {
  await page.route('**/__indexeddb-fixture.html', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>IndexedDB regression fixture</title>',
  }));
  await page.goto('/__indexeddb-fixture.html');
}

test('native late-open completion never replaces another account connection', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = '/src/utils/indexedDB.ts';
    const api = await import(/* @vite-ignore */ path);
    const alice = `idb-open-a-${crypto.randomUUID()}`, bob = `idb-open-b-${crypto.randomUUID()}`;
    const msg = (id: string) => ({ id, group_id: 'same-group', content: id, created_at: '2026-10-04T00:00:00Z' });
    const nativeOpen = indexedDB.open.bind(indexedDB);
    let release!: () => void, announce!: () => void;
    const held = new Promise<void>(resolve => { announce = resolve; });
    indexedDB.open = (name, version) => {
      const request = nativeOpen(name, version);
      if (name !== `ai-chat-group-${alice}`) return request;
      return new Proxy(request, {
        get(target, key) { return Reflect.get(target, key, target); },
        set(target, key, value) {
          if (key === 'onsuccess') { target.onsuccess = event => { release = () => value(event); announce(); }; return true; }
          return Reflect.set(target, key, value, target);
        },
      });
    };
    try {
      api.setIndexedDBUserId(alice); const old = api.saveMessagesToIndexedDB([msg('alice-old')]); await held;
      api.setIndexedDBUserId(bob); const first = await api.saveMessagesToIndexedDB([msg('bob-one')]);
      release(); const oldResult = await old;
      const second = await api.saveMessagesToIndexedDB([msg('bob-two')]);
      const ids = (await api.loadMessagesFromIndexedDB('same-group')).map((m: { id: string }) => m.id).sort();
      return { oldResult, first, second, ids };
    } finally {
      indexedDB.open = nativeOpen; await api.clearAllIndexedDBForUser(alice); await api.clearAllIndexedDBForUser(bob); api.setIndexedDBUserId(null);
    }
  });
  expect(result).toEqual({ oldResult: false, first: true, second: true, ids: ['bob-one', 'bob-two'] });
});

test('native aborted transaction cannot report a save or retain partial message writes', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = '/src/utils/indexedDB.ts'; const api = await import(/* @vite-ignore */ path);
    const user = `idb-abort-${crypto.randomUUID()}`; api.setIndexedDBUserId(user);
    const msg = (id: string) => ({ id, group_id: 'same-group', content: id, created_at: '2026-10-04T00:00:00Z' });
    await api.saveMessagesToIndexedDB([msg('seed')]);
    const nativePut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = key === undefined ? nativePut.call(this, value) : nativePut.call(this, value, key);
      if (this.transaction.db.name === `ai-chat-group-${user}`) request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    };
    try {
      const saved = await api.saveMessagesToIndexedDB([msg('must-rollback-1'), msg('must-rollback-2')]);
      const ids = (await api.loadMessagesFromIndexedDB('same-group')).map((m: { id: string }) => m.id);
      return { saved, ids };
    } finally { IDBObjectStore.prototype.put = nativePut; await api.clearAllIndexedDBForUser(user); api.setIndexedDBUserId(null); }
  });
  expect(result).toEqual({ saved: false, ids: ['seed'] });
});

test('native blocked deletion stays fenced until completion and does not touch another account', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path = '/src/utils/indexedDB.ts'; const api = await import(/* @vite-ignore */ path);
    const alice = `idb-delete-a-${crypto.randomUUID()}`, bob = `idb-delete-b-${crypto.randomUUID()}`;
    const msg = (id: string) => ({ id, group_id: 'same-group', content: id, created_at: '2026-10-04T00:00:00Z' });
    api.setIndexedDBUserId(alice); await api.saveMessagesToIndexedDB([msg('alice-old')]);
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(`ai-chat-group-${alice}`, 1); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
    });
    // Deliberately keep the second connection alive through versionchange.
    blocker.onversionchange = () => {};
    const nativeDelete = indexedDB.deleteDatabase.bind(indexedDB);
    let completed!: Promise<void>;
    indexedDB.deleteDatabase = name => {
      const request = nativeDelete(name);
      completed = new Promise<void>((resolve, reject) => { request.addEventListener('success', () => resolve()); request.addEventListener('error', () => reject(request.error)); });
      return request;
    };
    try {
      const cleared = await api.clearAllIndexedDBForUser(alice);
      const premature = await api.saveMessagesToIndexedDB([msg('must-not-repopulate')]);
      api.setIndexedDBUserId(bob); const bobSaved = await api.saveMessagesToIndexedDB([msg('bob-private')]);
      blocker.close(); await completed;
      const bobIds = (await api.loadMessagesFromIndexedDB('same-group')).map((m: { id: string }) => m.id);
      api.setIndexedDBUserId(alice); const aliceIds = (await api.loadMessagesFromIndexedDB('same-group')).map((m: { id: string }) => m.id);
      const after = await api.saveMessagesToIndexedDB([msg('fresh-alice')]);
      return { cleared, premature, bobSaved, bobIds, aliceIds, after };
    } finally { blocker.close(); indexedDB.deleteDatabase = nativeDelete; await api.clearAllIndexedDBForUser(alice); await api.clearAllIndexedDBForUser(bob); api.setIndexedDBUserId(null); }
  });
  expect(result).toEqual({ cleared: false, premature: false, bobSaved: true, bobIds: ['bob-private'], aliceIds: [], after: true });
});

test('native retention keeps unconfirmed drafts outside the normal history cap', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const path='/src/utils/indexedDB.ts';const api=await import(/* @vite-ignore */ path);const user=`idb-draft-retention-${crypto.randomUUID()}`;api.setIndexedDBUserId(user);
    const records=[{id:'failed',group_id:'g',content:'synthetic pending draft',created_at:'2020-01-01',status:'failed'},...Array.from({length:1001},(_,i)=>({id:`sent-${i}`,group_id:'g',content:'synthetic confirmed',created_at:new Date(1700000000000+i*1000).toISOString(),status:'sent'}))];
    const saved=await api.saveMessagesToIndexedDB(records);const before=await api.loadMessagesFromIndexedDB('g');const trimmed=await api.clearOldMessagesFromIndexedDB('g',0);const after=await api.loadMessagesFromIndexedDB('g');const cleared=await api.clearAllIndexedDBForUser(user);return{saved,trimmed,cleared,before:before.length,hasDraft:before.some((row:{id:string})=>row.id==='failed'),after:after.map((row:{id:string})=>row.id)};
  });
  expect(result).toEqual({saved:true,trimmed:true,cleared:true,before:1001,hasDraft:true,after:['failed']});
});
