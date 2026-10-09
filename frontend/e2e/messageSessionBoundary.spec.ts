import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route('**/__message-session-fixture.html', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Message session regression fixture</title>',
  }));
  await page.goto('/__message-session-fixture.html');
}

// Real application modules, Axios interceptors and browser-native IndexedDB.
// Only HTTP/WebSocket IO is synthetic: no credentials or provider requests.
test('native cache continuation cannot start old-account HTTP work after a session switch', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const modules = ['/src/stores/messagesStore.ts', '/src/services/api.ts', '/src/utils/cacheUtils.ts', '/src/utils/indexedDB.ts'];
    const [messages, api, cache, db] = await Promise.all(modules.map(path => import(/* @vite-ignore */ path)));
    const alice = `message-a-${crypto.randomUUID()}`, bob = `message-b-${crypto.randomUUID()}`;
    const row = (id: string) => ({ id, group_id: 'same-group', sender_type: 'user', content: id, created_at: '2026-10-04T00:00:00Z' });
    const requests: { account: string; path: string }[] = [];
    api.axiosInstance.defaults.adapter = async (config: { headers: { get: (name: string) => string }; url: string }) => {
      requests.push({ account: config.headers.get('X-Expected-User-Id'), path: config.url });
      return { config, status: 200, statusText: 'OK', headers: {}, data: { messages: [row('bob-server')], hasMore: false } };
    };
    const switchTo = (user: string) => {
      cache.setCacheUserId(user); api.confirmAuthIdentity(user); db.setIndexedDBUserId(user);
      messages.resetMessagesModuleState(); messages.useMessagesStore.setState({ messages: {}, pagination: {}, sending: {}, loading: false, error: null });
    };
    try {
      switchTo(alice); await db.saveMessagesToIndexedDB([row('alice-cache')]);
      const oldRead = messages.useMessagesStore.getState().fetchMessages('same-group');
      switchTo(bob);
      await oldRead;
      const afterOld = { requests: requests.length, rows: Object.keys(messages.useMessagesStore.getState().messages).length };
      await messages.useMessagesStore.getState().fetchMessages('same-group');
      return { afterOld, requests, expected: bob, ids: messages.useMessagesStore.getState().messages['same-group'].map((item: { id: string }) => item.id) };
    } finally {
      messages.resetMessagesModuleState();
      await db.clearAllIndexedDBForUser(alice); await db.clearAllIndexedDBForUser(bob);
      db.setIndexedDBUserId(null); cache.setCacheUserId(null); api.confirmAuthIdentity(null);
    }
  });
  expect(result.afterOld).toEqual({ requests: 0, rows: 0 });
  expect(result.requests).toEqual([{ account: result.expected, path: '/groups/same-group/messages' }]);
  expect(result.ids).toEqual(['bob-server']);
});

test('native recovered draft reconciles through actual socket/store/cache without automatic resend', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const modules = ['/src/stores/messagesStore.ts', '/src/services/api.ts', '/src/utils/cacheUtils.ts', '/src/utils/indexedDB.ts', '/src/services/websocket.ts'];
    const [messages, api, cache, db, ws] = await Promise.all(modules.map(path => import(/* @vite-ignore */ path)));
    const user = `message-ack-${crypto.randomUUID()}`, tempId = crypto.randomUUID();
    const draft = { id: tempId, tempId, group_id: 'same-group', sender_type: 'user', sender_id: user, status: 'sending', content: 'synthetic unconfirmed draft', created_at: '2026-10-04T00:00:00Z' };
    const requests: string[] = [];
    api.axiosInstance.defaults.adapter = async (config: { method: string; url: string }) => {
      requests.push(config.method);
      return { config, status: 200, statusText: 'OK', headers: {}, data: config.url === '/groups' ? [] : config.url === '/personas' ? { personas: {} } : { messages: [], hasMore: false } };
    };
    const sockets: SyntheticSocket[] = [];
    class SyntheticSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0; onopen?: () => void; onmessage?: (event: { data: string }) => void;
      constructor() { sockets.push(this); }
      send() {} close() { this.readyState = 3; }
      open() { this.readyState = 1; this.onopen?.(); }
      message(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    }
    const nativeSocket = window.WebSocket;
    window.WebSocket = SyntheticSocket as unknown as typeof WebSocket;
    const until = async (predicate: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!await predicate()) { if (Date.now() > deadline) throw new Error('Message/cache reconciliation did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); }
    };
    try {
      cache.setCacheUserId(user); api.confirmAuthIdentity(user); db.setIndexedDBUserId(user);
      messages.resetMessagesModuleState(); messages.useMessagesStore.setState({ messages: {}, pagination: {}, sending: {} });
      await db.saveMessagesToIndexedDB([draft]);
      ws.connectWebSocket('same-group'); sockets[0].open();
      await until(() => messages.useMessagesStore.getState().messages['same-group']?.[0]?.status === 'failed');
      const recovered = messages.useMessagesStore.getState().messages['same-group'][0];
      sockets[0].message({ type: 'new_message', ...draft, id: 'server-confirmed', status: undefined, client_message_id: tempId });
      await until(async () => { const rows = await db.loadMessagesFromIndexedDB('same-group'); return rows.length === 1 && rows[0].id === 'server-confirmed'; });
      const rows = messages.useMessagesStore.getState().messages['same-group'];
      return { recovered: { id: recovered.id, unknown: recovered.metadata.send_unknown }, tempId, requests, ids: rows.map((row: { id: string }) => row.id), status: rows[0].status, cached: (await db.loadMessagesFromIndexedDB('same-group')).map((row: { id: string }) => row.id) };
    } finally {
      ws.destroyWebSocket(); window.WebSocket = nativeSocket; messages.resetMessagesModuleState();
      await db.clearAllIndexedDBForUser(user); db.setIndexedDBUserId(null); cache.setCacheUserId(null); api.confirmAuthIdentity(null);
    }
  });
  expect(result.recovered).toEqual({ id: result.tempId, unknown: true });
  expect(result.requests.every(method => method === 'get')).toBe(true);
  expect(result.ids).toEqual(['server-confirmed']); expect(result.cached).toEqual(['server-confirmed']); expect(result.status).toBe('sent');
});

test('native successful cleanup retires old delayed message writes and permits a new edit', async ({ page }) => {
  await fixture(page);
  const result = await page.evaluate(async () => {
    const modules = ['/src/stores/messagesStore.ts', '/src/services/api.ts', '/src/utils/cacheUtils.ts', '/src/utils/indexedDB.ts', '/src/utils/privateCache.ts'];
    const [messages, api, cache, db, cleanup] = await Promise.all(modules.map(path => import(/* @vite-ignore */ path)));
    const user = `message-cleanup-${crypto.randomUUID()}`;
    const row = (id: string) => ({ id, group_id: 'same-group', sender_type: 'user', content: 'synthetic local record', created_at: '2026-10-04T00:00:00Z' });
    cache.setCacheUserId(user); api.confirmAuthIdentity(user); db.setIndexedDBUserId(user);
    messages.resetMessagesModuleState(); messages.useMessagesStore.setState({ messages: {}, pagination: {}, sending: {} });
    try {
      messages.useMessagesStore.getState().addMessage('same-group', row('before-cleanup'));
      await cleanup.clearCurrentUserCache();
      // This delay explicitly crosses the real production two-second debounce.
      await new Promise(resolve => setTimeout(resolve, 2300));
      const afterOldTimer = (await db.loadMessagesFromIndexedDB('same-group')).map((item: { id: string }) => item.id);
      messages.useMessagesStore.getState().addMessage('same-group', row('after-cleanup'));
      const deadline = Date.now() + 5000;
      let saved = false;
      while (!saved && Date.now() < deadline) {
        saved = (await db.loadMessagesFromIndexedDB('same-group')).some((item: { id: string }) => item.id === 'after-cleanup');
        if (!saved) await new Promise(resolve => setTimeout(resolve, 20));
      }
      return { afterOldTimer, newEditSaved: saved, inMemoryPreserved: messages.useMessagesStore.getState().messages['same-group'].some((item: { id: string }) => item.id === 'before-cleanup') };
    } finally {
      messages.resetMessagesModuleState(); await db.clearAllIndexedDBForUser(user);
      db.setIndexedDBUserId(null); cache.setCacheUserId(null); api.confirmAuthIdentity(null);
    }
  });
  expect(result).toEqual({ afterOldTimer: [], newEditSaved: true, inMemoryPreserved: true });
});
