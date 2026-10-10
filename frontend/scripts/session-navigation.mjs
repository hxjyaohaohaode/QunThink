import { isSessionTokenResponse } from './session-token-retry.mjs';

// App.tsx cancels the older StrictMode effect before its success/error guards.
// Its request can finish late, so choose the newest request by start order,
// never by response-arrival order. An active request must settle before the
// destination can pass, then its actual UI must be stable on two observations.
export function createSettledSessionObserver() {
  let priorDestinationSequence = null;
  return ({ latest, destination, recovery }) => {
    const prior = priorDestinationSequence; priorDestinationSequence = null;
    if (latest?.failed) return 'failed';
    if (!latest) return recovery ? 'recovery' : 'waiting';
    if (!latest.finished || !latest.response) return 'waiting';
    if (destination && latest.response.status() === 200) {
      priorDestinationSequence = latest.sequence;
      return prior === latest.sequence ? 'destination' : 'waiting';
    }
    if (recovery && latest.response.status() !== 200) return 'recovery';
    return 'waiting';
  };
}

export function createScopedSessionNavigator({ page, origin, recover }) {
  let active = false;
  return async ({ action, waitForState, waitForDestination }) => {
    if (active) throw new Error('Concurrent session navigation requires triage');
    active = true;
    const requests = new Map(); let latest = null, sequence = 0;
    const settle = createSettledSessionObserver();
    const onRequest = request => {
      if (isSessionTokenResponse({ url: () => request.url(), request: () => request }, origin())) {
        latest = { sequence: ++sequence, response: null, finished: false, failed: false };
        requests.set(request, latest);
      }
    };
    const onResponse = response => {
      const observed = requests.get(response.request());
      if (observed && isSessionTokenResponse(response, origin())) observed.response = response;
    };
    const onFinished = request => { const observed = requests.get(request); if (observed) observed.finished = true; };
    const onFailed = request => { const observed = requests.get(request); if (observed) { observed.failed = true; observed.finished = true; } };
    const observation = { classify: visible => settle({ latest, ...visible }) };
    const knownState = async () => {
      const state = await waitForState(observation);
      if (latest?.failed) throw new Error('The current session token request failed; no blind retry');
      if (latest && !latest.finished) throw new Error('The current session token request is still pending');
      if (state === 'destination' && latest?.response?.status() !== 200) throw new Error('A visible destination lacks a completed current successful token response');
      return state;
    };
    try {
      page.on('request', onRequest); page.on('response', onResponse);
      page.on('requestfinished', onFinished); page.on('requestfailed', onFailed);
      await action();
      const state = await knownState();
      if (state === 'destination') {
        if (latest?.response?.status() !== 200) throw new Error('A visible destination lacks a completed current successful token response');
        return;
      }
      if (state !== 'recovery') throw new Error('Session navigation did not reach a known visible state');
      const response = latest?.response;
      if (!response || response.status() !== 429) throw new Error(`Visible session recovery lacks a current token 429 (latest: ${response?.status() ?? 'none'})`);
      await recover(response);
      if (await knownState() !== 'destination') throw new Error('Session recovery did not reach the final visible destination');
      await waitForDestination();
    } finally {
      page.off('request', onRequest); page.off('response', onResponse);
      page.off('requestfinished', onFinished); page.off('requestfailed', onFailed);
      requests.clear(); latest = null; active = false;
    }
  };
}

// Observe the response caused by the actual retry click. Late responses from
// requests started before this click cannot satisfy it. The timer is a bounded
// failure deadline, not a sleep or an extension of the test's original budget.
export async function observeSessionTokenAttempt({ page, origin, action, timeout, schedule = setTimeout, cancel = clearTimeout }) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Session attempt exceeds the original test budget');
  const requests = new Set(); let resolveResponse, rejectResponse, timer;
  const responsePromise = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const onRequest = request => {
    if (isSessionTokenResponse({ url: () => request.url(), request: () => request }, origin())) requests.add(request);
  };
  const onResponse = response => {
    if (requests.has(response.request()) && isSessionTokenResponse(response, origin())) resolveResponse(response);
  };
  const onFailed = request => { if (requests.has(request)) rejectResponse(new Error('Session retry request failed; no additional retry')); };
  try {
    page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailed);
    timer = schedule(() => rejectResponse(new Error('Session attempt exceeded the original test budget')), timeout);
    const [response] = await Promise.all([responsePromise, action(timeout)]);
    return response;
  } finally {
    cancel(timer); page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailed);
    requests.clear();
  }
}
