import { expect, test, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Each test still gets an independent real account. Respect the real auth
// limiter when a larger suite shares its test server; never disable it in CI.
export async function registerSyntheticAccount(context: BrowserContext, options: { phone?: string; nickname?: string } = {}) {
  const csrf = await (await context.request.get('/api/csrf-token')).json();
  const data = { username: `qa_${randomUUID().replaceAll('-', '')}`, password: 'Synthetic-Browser-Only-2026', nickname: options.nickname || '体验测试', ...(options.phone ? { phone: options.phone } : {}) };
  let response = await context.request.post('/api/auth/register', { headers: { 'x-csrf-token': csrf.csrfToken }, data });
  if (response.status() === 429) {
    const seconds = Number(response.headers()['retry-after']);
    expect(Number.isInteger(seconds) && seconds > 0 && seconds <= 60).toBe(true);
    const waitMs = seconds * 1000 + 150;
    test.setTimeout(test.info().timeout + waitMs + 2000);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    // 429 is a known pre-admission rejection. Never retry network/lost-ACK
    // registration automatically, and keep this exact synthetic intent.
    response = await context.request.post('/api/auth/register', { headers: { 'x-csrf-token': csrf.csrfToken }, data });
  }
  expect(response.status()).toBe(201);
  return (await response.json()).user;
}
