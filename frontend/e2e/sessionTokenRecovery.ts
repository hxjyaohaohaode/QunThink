import { expect, type Page, type TestInfo } from '@playwright/test';
import { createSessionTokenRecovery, isSessionTokenResponse } from '../scripts/session-token-retry.mjs';

type Recovery = { deadline: number; recover: ReturnType<typeof createSessionTokenRecovery> };
const recoveries = new WeakMap<Page, Recovery>();

// Capture once before registration: its pre-existing fixture may extend its own
// timer, but that must never extend the budget for session recovery.
export function beginSessionTokenRecovery(page: Page, info: TestInfo) {
  const deadline = Date.now() + info.timeout;
  const retry = page.getByRole('button', { name: '重试连接', exact: true });
  const recover = createSessionTokenRecovery({
    origin: () => page.url(), remainingBudgetMs: () => deadline - Date.now(),
    onRateLimited: async (response: { status: () => number; headers: () => Record<string, string> }) => {
      await expect(retry).toBeVisible();
      await info.attach('session-token-rate-limit.json', { body: JSON.stringify({ path: '/api/auth/token', status: response.status(), retryAfter: response.headers()['retry-after'], remainingBudgetMs: deadline - Date.now() }), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('session-token-rate-limited-before-retry.png'), fullPage: true });
    },
    retry: () => observeTokenResponse(page, deadline, timeout => retry.click({ timeout })),
  });
  recoveries.set(page, { deadline, recover });
}

async function observeTokenResponse(page: Page, deadline: number, action: (timeout: number) => Promise<unknown>) {
  const timeout = deadline - Date.now() - 5000;
  if (timeout <= 0) throw new Error('Session observation exceeds the original test budget');
  const [response] = await Promise.all([
    page.waitForResponse(response => isSessionTokenResponse(response, page.url()), { timeout }),
    action(timeout),
  ]);
  return response;
}

export async function navigateWithSessionTokenRecovery(page: Page, action: (timeout: number) => Promise<unknown>) {
  const recovery = recoveries.get(page);
  if (!recovery) throw new Error('Session recovery must capture the original test budget before navigation');
  await recovery.recover(await observeTokenResponse(page, recovery.deadline, action));
}
