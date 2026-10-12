import { isSessionTokenResponse } from './session-token-retry.mjs';
import { submitAuthWithSingleRateLimitRetry } from './auth-submit-retry.mjs';

// Metadata E2E only. The production bootstrap and its rate limits are unchanged.
export function isSessionUserResponse(response, origin) {
  try {
    const url = new URL(response.url());
    return url.origin === new URL(origin).origin && url.pathname === '/api/auth/me' && response.request().method() === 'GET';
  } catch { return false; }
}
export function createSessionBootstrapRecovery({ origin, remainingBudgetMs, onRateLimited, retry, now, wait }) {
  let recovered = false;
  return async (response, assertCurrent = () => {}) => {
    assertCurrent();
    if (!isSessionTokenResponse(response, origin()) && !isSessionUserResponse(response, origin())) throw new Error('Bootstrap recovery requires the real same-origin GET token or me response');
    if (response.status() !== 429) throw new Error('Only an observed bootstrap 429 authorizes recovery');
    if (recovered) throw new Error('A second bootstrap 429 requires triage; no further retry');
    recovered = true; // Reserve before the first await, once per explicit navigation epoch.
    let first = true;
    const result = await submitAuthWithSingleRateLimitRetry(async () => {
      assertCurrent();
      if (first) { first = false; return response; }
      const next = await retry();
      if (!isSessionTokenResponse(next, origin())) throw new Error('The retry must observe its actual same-origin token read');
      return next;
    }, { remainingBudgetMs, now, wait, onRateLimited: async value => { assertCurrent(); await onRateLimited(value); assertCurrent(); } });
    if (result.status() !== 200) throw new Error('Bootstrap retry token failed; no further retry');
    // The navigator independently requires the current /me 200 and real UI.
    return result;
  };
}

export function createScopedBootstrapNavigator({ page, origin, recover, createRecovery }) {
  let active = false, failed = false;
  return async ({ action, waitForState, waitForDestination }) => {
    if (active) throw new Error('Concurrent bootstrap navigation requires triage');
    if (failed) throw new Error('A prior bootstrap navigation failed; no new recovery epoch');
    active = true;
    let succeeded = false;
    const requests = new Map(); let token = null, user = null, sequence = 0;
    const onRequest = request => {
      const candidate = { url: () => request.url(), request: () => request };
      if (isSessionTokenResponse(candidate, origin())) {
        token = { sequence: ++sequence, response: null, finished: false, failed: false }; user = null;
        requests.set(request, token);
      } else if (token && isSessionUserResponse(candidate, origin())) {
        user = { tokenSequence: token.sequence, response: null, finished: false, failed: false };
        requests.set(request, user);
      }
    };
    const onResponse = response => { const observed = requests.get(response.request()); if (observed) observed.response = response; };
    const onFinished = request => { const observed = requests.get(request); if (observed) observed.finished = true; };
    const onFailed = request => { const observed = requests.get(request); if (observed) { observed.failed = true; observed.finished = true; } };
    const currentUser = () => user?.tokenSequence === token?.sequence ? user : null;
    const classify = ({ destination, recovery }) => {
      const me = currentUser();
      if (token?.failed || me?.failed) return 'failed';
      if (!token?.finished || !token.response) return 'waiting';
      if (token.response.status() !== 200) return recovery ? 'recovery' : 'waiting';
      if (!me?.finished || !me.response) return 'waiting';
      if (me.response.status() === 200 && destination) return 'destination';
      return me.response.status() !== 200 && recovery ? 'recovery' : 'waiting';
    };
    const knownState = async () => {
      const state = await waitForState({ classify });
      if (token?.failed || currentUser()?.failed) throw new Error('The current bootstrap request failed; no blind retry');
      if (state === 'destination' && (!token?.finished || token.response?.status() !== 200 || !currentUser()?.finished || currentUser().response?.status() !== 200)) throw new Error('Bootstrap destination requires current successful token and me reads');
      return state;
    };
    try {
      // Only an explicit navigation after a completed successful epoch gets a
      // fresh one-retry allowance. Failed/unknown epochs cannot reset by reload.
      const recoverEpoch = createRecovery ? createRecovery() : recover;
      page.on('request', onRequest); page.on('response', onResponse); page.on('requestfinished', onFinished); page.on('requestfailed', onFailed);
      await action();
      const state = await knownState();
      if (state === 'destination') { succeeded = true; return; }
      if (state !== 'recovery') throw new Error('Bootstrap navigation did not reach a known visible state');
      const response = token?.response?.status() === 200 ? currentUser()?.response : token?.response;
      if (!response || response.status() !== 429) throw new Error('Visible recovery lacks a current bootstrap 429');
      const observedToken = token, observedUser = currentUser();
      const assertCurrent = () => {
        const currentResponse = token?.response?.status() === 200 ? currentUser()?.response : token?.response;
        if (token !== observedToken || currentUser() !== observedUser || token?.failed || currentUser()?.failed || currentResponse !== response || currentResponse?.status() !== 429) throw new Error('Bootstrap changed during recovery; stale 429 cannot authorize a retry');
      };
      assertCurrent();
      await recoverEpoch(response, assertCurrent);
      if (await knownState() !== 'destination') throw new Error('Bootstrap recovery did not reach current successful token and me reads');
      const completedToken = token, completedUser = currentUser();
      await waitForDestination();
      if (token !== completedToken || currentUser() !== completedUser || token?.failed || currentUser()?.failed || !token?.finished || !currentUser()?.finished || token.response?.status() !== 200 || currentUser()?.response?.status() !== 200) throw new Error('The current bootstrap changed during the final UI check; no successful epoch');
      succeeded = true;
    } finally {
      page.off('request', onRequest); page.off('response', onResponse); page.off('requestfinished', onFinished); page.off('requestfailed', onFailed);
      requests.clear(); token = null; user = null; active = false; failed = !succeeded;
    }
  };
}
