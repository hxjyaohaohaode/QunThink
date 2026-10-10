import { expect, type Page, type TestInfo, type Locator } from '@playwright/test';
import { createSessionTokenRecovery } from '../scripts/session-token-retry.mjs';
import { createScopedSessionNavigator, observeSessionTokenAttempt } from '../scripts/session-navigation.mjs';

type Recovery = { deadline: number; navigate: ReturnType<typeof createScopedSessionNavigator> };
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
  recoveries.set(page, { deadline, navigate: createScopedSessionNavigator({ page, origin: () => page.url(), recover }) });
}

async function observeTokenResponse(page: Page, deadline: number, action: (timeout: number) => Promise<unknown>) {
  const timeout = deadline - Date.now() - 5000;
  if (timeout <= 0) throw new Error('Session observation exceeds the original test budget');
  return observeSessionTokenAttempt({ page, origin: () => page.url(), action, timeout });
}

export async function navigateWithSessionTokenRecovery(page: Page, action: (timeout: number) => Promise<unknown>, destination: Locator = page.getByTestId('workspace')) {
  const recovery = recoveries.get(page);
  if (!recovery) throw new Error('Session recovery must capture the original test budget before navigation');
  const budget = () => {
    const remaining = recovery.deadline - Date.now() - 5000;
    if (remaining <= 0) throw new Error('Session navigation exceeds the original test budget');
    return remaining;
  };
  const retry = page.getByRole('button', { name: '重试连接', exact: true });
  await recovery.navigate({
    action: () => action(budget()),
    waitForState: async (observation: { classify: (visible: { destination: boolean; recovery: boolean }) => string }) => {
      let state = 'waiting';
      await expect.poll(async () => {
        state = observation.classify({ destination: await destination.isVisible(), recovery: await retry.isVisible() });
        return state;
      }, { timeout: Math.min(5000, budget()) }).not.toBe('waiting');
      return state;
    },
    waitForDestination: () => expect(destination).toBeVisible({ timeout: Math.min(5000, budget()) }),
  });
}
