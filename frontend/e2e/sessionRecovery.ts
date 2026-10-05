import { expect, type Page, type Locator } from '@playwright/test';
import { sessionRetryAt } from '../scripts/q1-navigation.mjs';
type Observation = { path: string; status: number; retryAfter: string; observedAt: number; retryAt: number | null };
type Evidence = { record: (stage: string, data?: Record<string, any>) => void | Promise<void>; shot: (name: string, target?: Locator, clickable?: boolean) => Promise<void> };
const sessionLimits = new WeakMap<Page, Observation>();
export function observeSessionLimits(page: Page) {
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== new URL(page.url()).origin || response.request().method() !== 'GET' || !url.pathname.startsWith('/api/auth/') || response.status() !== 429) return;
    const observedAt = Date.now(), retryAfter = response.headers()['retry-after'] || '';
    sessionLimits.set(page, { path: url.pathname, status: 429, retryAfter, observedAt, retryAt: sessionRetryAt(retryAfter, observedAt) });
  });
}
export function clearSessionLimit(page: Page) { sessionLimits.delete(page); }
export async function retryVisibleRateLimitedSession(page: Page, evidence: Evidence) {
  const retry = page.getByRole('button', { name: '重试连接', exact: true }), limit = sessionLimits.get(page);
  await expect(retry).toBeVisible();
  await evidence.record('session-recovery-screen', { observedResponse: limit || null });
  await evidence.shot('session-rate-limit-before-wait', retry);
  if (!limit || limit.retryAt === null) throw new Error('Session recovery requires triage: no bounded server Retry-After observation');
  sessionLimits.delete(page);
  const waitStarted = Date.now();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, limit.retryAt! - Date.now()) + 100));
  await evidence.record('session-rate-limit-wait-completed', { ...limit, waitStarted, waitFinished: Date.now(), meaning: 'Actual server-directed waiting, not an unchanged no-wait success or an acceptable speed claim' });
  await evidence.shot('session-rate-limit-before-real-retry', retry, true);
  await retry.click(); await expect(retry).not.toBeVisible();
}
export async function waitForAuthenticatedDestination(page: Page, destination: Locator, evidence: Evidence) {
  const retry = page.getByRole('button', { name: '重试连接', exact: true });
  for (let step = 0; step < 4; step++) {
    let state = 'waiting';
    await expect.poll(async () => {
      state = await destination.isVisible() ? 'destination' : await retry.isVisible() ? 'rate-limited-retry' : 'waiting';
      return state;
    }, { timeout: 20000, intervals: [100, 250, 500] }).not.toBe('waiting');
    if (state === 'destination') { clearSessionLimit(page); return; }
    await retryVisibleRateLimitedSession(page, evidence);
  }
  throw new Error('Session recovery did not reach the visible destination; preserve the original evidence for triage');
}
