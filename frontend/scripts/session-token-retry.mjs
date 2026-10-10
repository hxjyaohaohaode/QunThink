import { submitAuthWithSingleRateLimitRetry } from './auth-submit-retry.mjs';

// Match only the real bootstrap read for this page, never registrations,
// lookalike URLs, other auth reads, or a third-party response.
export function isSessionTokenResponse(response, origin) {
  try {
    const url = new URL(response.url());
    return url.origin === new URL(origin).origin && url.pathname === '/api/auth/token' && response.request().method() === 'GET';
  } catch { return false; }
}

// A page belongs to one test. At most one server-directed recovery is allowed
// across its initial navigation and reloads, inside that test's original budget.
export function createSessionTokenRecovery({ origin, remainingBudgetMs, onRateLimited, retry, now, wait }) {
  let recovered = false;
  return async response => {
    if (!isSessionTokenResponse(response, origin())) throw new Error('Session recovery requires the real same-origin GET /api/auth/token response');
    if (response.status() === 429) {
      if (recovered) throw new Error('A second session 429 requires triage; no further retry');
      // Reserve synchronously before the helper's first await. Concurrent
      // observations must not both reach the visible recovery click.
      recovered = true;
    }
    let first = true;
    const result = await submitAuthWithSingleRateLimitRetry(async () => {
      if (first) { first = false; return response; }
      const next = await retry();
      if (!isSessionTokenResponse(next, origin())) throw new Error('Session retry returned an unrelated response');
      return next;
    }, {
      remainingBudgetMs, now, wait,
      onRateLimited,
    });
    if (result.status() !== 200) throw new Error(`Session bootstrap failed with HTTP ${result.status()}; no further retry`);
    return result;
  };
}
