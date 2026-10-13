import { test, expect, type Page } from '@playwright/test';

// Only native Playwright establishes actual browser IndexedDB + WebCrypto
// cross-document durability. DOM/synthetic-storage tests are separate evidence.
async function fixture(page: Page, group?: string) {
  await page.goto('/e2e/f07-recovery.html' + (group ? '?group=' + encodeURIComponent(group) : ''));
  await expect(page.locator('textarea')).toBeEnabled();
}
const draft = '真实浏览器合成草稿：刷新仍使用同一账号';
const unknown = {
  id: 'temp_00000000-0000-4000-8000-000000000017', tempId: 'temp_00000000-0000-4000-8000-000000000017', group_id: 'f07-room',
  sender_type: 'user', sender_id: 'f07-synthetic-alice', content: 'synthetic unknown send intent', content_type: 'text', created_at: '2026-10-13T00:00:00Z',
  status: 'failed', reply_to: ['reply-original'], attachments: [{ id: 'file-original', name: 'synthetic.txt', type: 'text/plain', size: 12, url: '/synthetic-file' }], metadata: { send_unknown: true },
};

test('F07 native actual controls: same-owner cold refresh restores draft plus exact unknown UUID/reply/attachment intent without POST', async ({ page }) => {
  await fixture(page);
  await page.locator('textarea').fill(draft);
  await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  const receipt = await page.evaluate(row => (window as any).__f07.saveOutbox([row]), unknown);
  expect(receipt).toEqual({ durable: true });
  await page.reload(); await expect(page.locator('textarea')).toHaveValue(draft);
  await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  const restored = await page.evaluate(() => (window as any).__f07.loadOutbox());
  expect(restored.find((row: { id: string }) => row.id === unknown.id)).toMatchObject(unknown);
  expect(await page.evaluate(() => (window as any).__f07.requests.filter((r: { method: string }) => r.method === 'post'))).toEqual([]);
  await page.evaluate(() => (window as any).__f07.scope('f07-synthetic-bob'));
  await expect(page.locator('textarea')).toHaveValue(''); expect(await page.evaluate(() => (window as any).__f07.loadOutbox())).toEqual([]);
  await page.evaluate(() => (window as any).__f07.scope('f07-synthetic-alice')); await expect(page.locator('textarea')).toHaveValue(draft);
});

for (const failure of ['indexedDB', 'WebCrypto', 'localStorage'] as const) {
  test(`F07 native actual composer: ${failure} failure preserves text and exposes copy without a false recovery claim`, async ({ page }) => {
    await page.addInitScript(kind => {
      if (kind === 'indexedDB') indexedDB.open = () => { throw new DOMException('Synthetic blocked storage', 'UnknownError'); };
      if (kind === 'WebCrypto') Object.defineProperty(crypto, 'subtle', { get: () => undefined, configurable: true });
      if (kind === 'localStorage') {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) { if (key.startsWith('app_cache_')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this, key, value); };
      }
    }, failure);
    await fixture(page); await page.locator('textarea').fill(`保留当前草稿 ${failure}`);
    await expect(page.getByTestId('composer-durability')).toContainText('刷新前请复制');
    await expect(page.getByTestId('composer-durability')).not.toContainText('刷新可恢复');
    await expect(page.getByRole('button', { name: '复制未保存内容', exact: true })).toBeVisible();
    await expect(page.locator('textarea')).toHaveValue(`保留当前草稿 ${failure}`);
    expect(await page.evaluate(() => (window as any).__f07.loadDraft())).toBe(`保留当前草稿 ${failure}`);
  });
}

test('F07 native actual full list: protocol upgrade remains visible while transport says connected and rebuild never resends', async ({ page }) => {
  await fixture(page); await page.locator('textarea').fill(draft); await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  await page.evaluate(() => { (window as any).__f07.mode('upgrade'); (window as any).__f07.scope('f07-upgrade-owner'); });
  await expect(page.getByTestId('message-recovery')).toContainText('消息分页协议已更新');
  await expect(page.getByRole('button', { name: '重新读取历史', exact: true })).toBeVisible();
  await page.locator('textarea').fill('升级前仍在编辑的草稿');
  await page.getByRole('button', { name: '重新读取历史', exact: true }).click();
  await expect(page.locator('textarea')).toHaveValue('升级前仍在编辑的草稿');
  expect(await page.evaluate(() => (window as any).__f07.requests.filter((r: { method: string }) => r.method === 'post'))).toEqual([]);
});

test('F07 native actual composer: delayed owner-A decrypt cannot populate the owner-B or returning-A control', async ({ page }) => {
  await fixture(page); await page.locator('textarea').fill('owner A original'); await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  await page.evaluate(() => (window as any).__f07.scope('f07-synthetic-bob'));
  await expect(page.locator('textarea')).toHaveValue('');
  await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  await page.evaluate(() => {
    const f = (window as any).__f07;
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    (window as any).__f07release = null;
    let held = false;
    crypto.subtle.decrypt = (...args: Parameters<SubtleCrypto['decrypt']>) => {
      if (held) return original(...args);
      held = true;
      return new Promise((resolve, reject) => {
      (window as any).__f07release = () => { crypto.subtle.decrypt = original; original(...args).then(resolve, reject); };
      });
    };
    f.scope('f07-synthetic-alice');
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__f07release)).toBe('function');
  await page.evaluate(() => (window as any).__f07.scope('f07-synthetic-bob'));
  await expect(page.locator('textarea')).toBeEnabled(); await page.locator('textarea').fill('owner B current');
  await page.evaluate(() => (window as any).__f07release());
  await expect(page.locator('textarea')).toHaveValue('owner B current');
  await page.evaluate(() => (window as any).__f07.scope('f07-synthetic-alice'));
  await expect(page.locator('textarea')).toHaveValue('owner A original');
});

test('F07 native actual composer: cold-key readback failure keeps new text in memory and preserves the previous ciphertext', async ({ page }) => {
  await fixture(page); await page.locator('textarea').fill('persisted old text'); await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  const previous = await page.evaluate(() => localStorage.getItem('app_cache_f07-synthetic-alice_message_draft_f07-synthetic-alice_f07-room'));
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (this.name === 'ai-chat-crypto' && args[1] === 'readonly') throw new DOMException('Synthetic key readback failure', 'UnknownError');
      return original.apply(this, args);
    };
  });
  await page.locator('textarea').fill('new unverified text');
  await expect(page.getByTestId('composer-durability')).toContainText('刷新前请复制');
  await expect(page.getByTestId('composer-durability')).not.toContainText('刷新可恢复');
  await expect(page.locator('textarea')).toHaveValue('new unverified text');
  expect(await page.evaluate(() => (window as any).__f07.loadDraft())).toBe('new unverified text');
  expect(await page.evaluate(() => localStorage.getItem('app_cache_f07-synthetic-alice_message_draft_f07-synthetic-alice_f07-room'))).toBe(previous);
});

test('F07 native actual composer: an unreadable old draft cannot autosave an empty replacement or create a replacement key', async ({ page }) => {
  const raw = 'enc_v1_' + JSON.stringify({ iv: Array(12).fill(0), data: [1, 2, 3] });
  await page.addInitScript(ciphertext => {
    localStorage.setItem('app_cache_f07-synthetic-alice_message_draft_f07-synthetic-alice_f07-room', ciphertext);
    (window as any).__f07keyWrites = 0;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.transaction.db.name === 'ai-chat-crypto') (window as any).__f07keyWrites++;
      return original.apply(this, args);
    };
  }, raw);
  await fixture(page); await page.locator('textarea').fill('current text remains copyable');
  await expect(page.getByTestId('composer-durability')).toContainText('刷新前请复制');
  await expect(page.getByTestId('composer-durability')).not.toContainText('刷新可恢复');
  expect(await page.evaluate(() => (window as any).__f07keyWrites)).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('app_cache_f07-synthetic-alice_message_draft_f07-synthetic-alice_f07-room'))).toBe(raw);
  await expect(page.getByRole('button', { name: '复制未保存内容', exact: true })).toBeVisible();
});


async function nativeKeyFingerprint(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('ai-chat-crypto', 1);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const bytes = await new Promise<number[]>((resolve, reject) => {
        const tx = db.transaction('encryption_keys', 'readonly'); const store = tx.objectStore('encryption_keys');
        const master = store.get('master_key'), wrapping = store.get('wrapping_key_material');
        tx.oncomplete = () => resolve([...new Uint8Array(master.result), ...new Uint8Array(wrapping.result)]);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } finally { db.close(); }
  });
}

test('F07 native two tabs: delayed first key creation uses the other tab’s committed key and both drafts cold-refresh', async ({ page, context }) => {
  await page.addInitScript(() => {
    const original = crypto.subtle.generateKey.bind(crypto.subtle);
    let first = true;
    (window as any).__f07releaseFirstKey = null;
    crypto.subtle.generateKey = ((...args: Parameters<SubtleCrypto['generateKey']>) => {
      if (!first) return original(...args);
      first = false;
      return new Promise((resolve, reject) => {
        original(...args).then(key => { (window as any).__f07releaseFirstKey = () => resolve(key); }, reject);
      });
    }) as SubtleCrypto['generateKey'];
  });
  await fixture(page, 'tab-a'); await expect.poll(() => page.evaluate(() => typeof (window as any).__f07releaseFirstKey)).toBe('function');
  const other = await context.newPage(); await fixture(other, 'tab-b');
  await other.locator('textarea').fill('tab B original durable text'); await expect(other.getByTestId('composer-durability')).toContainText('刷新可恢复');
  const establishedKey = await nativeKeyFingerprint(other);
  await page.locator('textarea').fill('tab A original durable text'); await page.evaluate(() => (window as any).__f07releaseFirstKey());
  await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  // The init script only pauses generateKey. Existing keys must be loaded, so
  // neither reload should generate a replacement key or need another release.
  await other.reload(); await expect(other.locator('textarea')).toHaveValue('tab B original durable text');
  await page.reload(); await expect(page.locator('textarea')).toHaveValue('tab A original durable text');
  await expect(page.getByTestId('composer-durability')).toContainText('刷新可恢复');
  await expect(other.getByTestId('composer-durability')).toContainText('刷新可恢复');
  expect(await nativeKeyFingerprint(page)).toBe(establishedKey);
  expect(await nativeKeyFingerprint(other)).toBe(establishedKey);
  await other.close();
});
