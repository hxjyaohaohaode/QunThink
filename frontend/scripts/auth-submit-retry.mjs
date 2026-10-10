import { sessionRetryAt } from './q1-navigation.mjs';

// E2E-only: a confirmed 429 means the auth action was not admitted. Permit one
// explicit retry after the server's bounded wait, within the original test
// deadline. All other responses and uncertain network outcomes stay unchanged.
export async function submitAuthWithSingleRateLimitRetry(submit, {
  remainingBudgetMs, onRateLimited,
  now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
}) {
  const response = await submit();
  if (response.status() !== 429) return response;
  const observedAt = now();
  const retryAt = sessionRetryAt(response.headers()['retry-after'], observedAt);
  if (retryAt === null) throw new Error('Auth recovery requires a bounded server Retry-After');
  const waitWithinBudget = () => {
    const waitMs = Math.max(0, retryAt - now()) + 100;
    const remaining = remainingBudgetMs();
    // Preserve five seconds for the original destination/account assertions.
    if (!Number.isFinite(remaining) || waitMs + 5000 > remaining) {
      throw new Error('Server-directed auth retry exceeds the original test budget');
    }
    return waitMs;
  };
  waitWithinBudget();
  await onRateLimited(response);
  await wait(waitWithinBudget());
  return submit();
}
