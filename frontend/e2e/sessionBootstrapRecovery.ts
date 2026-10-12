import { expect, type Page, type TestInfo, type Locator } from '@playwright/test';
import { createScopedBootstrapNavigator, createSessionBootstrapRecovery } from '../scripts/session-bootstrap-recovery.mjs';
import { observeSessionTokenAttempt, readVisibleSessionState } from '../scripts/session-navigation.mjs';

type Recovery = { deadline: number; navigate: ReturnType<typeof createScopedBootstrapNavigator> };
const recoveries = new WeakMap<Page, Recovery>();
const testDeadlines = new WeakMap<TestInfo, number>();

// Opted in by metadata E2E only. Capture once; no deadline extension or repeated
// bootstrap recovery across reloads. Production auth behavior stays untouched.
export function beginSessionBootstrapRecovery(page: Page, info: TestInfo) {
  if (recoveries.has(page)) return;
  const deadline = testDeadlines.get(info) ?? Date.now() + info.timeout;
  testDeadlines.set(info, deadline);
  const retry = page.getByRole('button', { name: '重试连接', exact: true });
  const recover = createSessionBootstrapRecovery({
    origin: () => page.url(), remainingBudgetMs: () => deadline - Date.now(),
    onRateLimited: async (response: { url: () => string; status: () => number; headers: () => Record<string, string> }) => {
      await expect(retry).toBeVisible();
      await info.attach('bootstrap-rate-limit.json', { body: JSON.stringify({ path: new URL(response.url()).pathname, status: response.status(), retryAfter: response.headers()['retry-after'], remainingBudgetMs: deadline - Date.now() }), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('bootstrap-rate-limited-before-retry.png'), fullPage: true });
    },
    retry: () => observeSessionTokenAttempt({ page, origin: () => page.url(), timeout: deadline - Date.now() - 5000, action: (timeout: number) => retry.click({ timeout }) }),
  });
  recoveries.set(page, { deadline, navigate: createScopedBootstrapNavigator({ page, origin: () => page.url(), recover }) });
}
export async function navigateWithSessionBootstrapRecovery(page: Page, action: (timeout: number) => Promise<unknown>, destination: Locator = page.getByTestId('workspace')) {
  const recovery = recoveries.get(page);
  if (!recovery) throw new Error('Bootstrap recovery must capture the original budget before navigation');
  const budget = () => { const remaining = recovery.deadline - Date.now() - 5000; if (remaining <= 0) throw new Error('Bootstrap navigation exceeds the original test budget'); return remaining; };
  const retry = page.getByRole('button', { name: '重试连接', exact: true });
  await recovery.navigate({
    action: () => action(budget()),
    waitForState: async (observation: { classify: (visible: { destination: boolean; recovery: boolean }) => string }) => {
      let state = 'waiting';
      await expect.poll(async () => { state = observation.classify(await readVisibleSessionState(destination, retry)); return state; }, { timeout: Math.min(5000, budget()) }).not.toBe('waiting');
      return state;
    },
    waitForDestination: () => expect(destination).toBeVisible({ timeout: Math.min(5000, budget()) }),
  });
}
