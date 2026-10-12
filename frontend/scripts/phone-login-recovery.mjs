import { sessionRetryAt } from './q1-navigation.mjs';

// Test-only, deliberately separate from API login and navigation recovery.
export async function assertExpectedLoginUser(response, expectedUserId) {
  if (response.status() !== 200) throw new Error('Phone login did not return 200; no blind retry');
  if (!expectedUserId || (await response.json())?.user?.id !== expectedUserId) throw new Error('Phone login returned a different user');
}

export function createPhoneLoginRecovery({ page, deadline, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let active = false, failed = false;
  return async ({ phone, password, expectedUserId, prepare, poll, capture, workspace }) => {
    if (active || failed) throw new Error('Concurrent or previously failed phone login cannot start another operation');
    active = true;
    const origin = new URL(page.url()).origin, frame = page.mainFrame();
    let invalid = false, succeeded = false, armed = false, retried = false, form;
    let login = null, bootstrap = null, model = null, phase = 'prepare';
    const requests = new Map(), pendingAuthChecks = new Set();
    let closed = false;
    const budget = () => {
      const remaining = deadline - now() - 5000;
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Phone login exceeds the original test budget');
      return remaining;
    };
    const current = () => {
      const timeout = budget();
      if (invalid || new URL(page.url()).origin !== origin) throw new Error('Phone login operation changed; stale evidence cannot authorize a click or success');
      return timeout;
    };
    const path = request => { try { const url = new URL(request.url()); return url.origin === origin ? url.pathname + url.search : ''; } catch { return ''; } };
    const onRequest = request => {
      const url = path(request);
      if (url.startsWith('/api/auth/')) {
        let body; try { body = request.postDataJSON(); } catch { /* Never log input. */ }
        if (!armed || url !== '/api/auth/login-phone' || request.method() !== 'POST' || request.frame() !== frame ||
            body?.phone !== phone || body?.password !== password || Object.keys(body).sort().join(',') !== 'password,phone') { invalid = true; return; }
        armed = false;
        login = { request, response: null, finished: false, failed: false }; bootstrap = null; model = null;
        requests.set(request, login);
      } else if (url === '/api/bootstrap' || url === '/api/user/model-catalog') {
        const isBootstrap = url === '/api/bootstrap';
        if (!login?.response || login.response.status() !== 200 || request.method() !== 'GET' || request.frame() !== frame ||
            request.headers()['x-expected-user-id'] !== expectedUserId || (isBootstrap && bootstrap)) { invalid = true; return; }
        const observed = { request, response: null, finished: false, failed: false, kind: isBootstrap ? 'bootstrap' : 'model' };
        if (isBootstrap) bootstrap = observed; else model = observed;
        requests.set(request, observed);
      }
    };
    const onResponse = response => {
      const observed = requests.get(response.request());
      if (observed) {
        if (observed.response && observed.response !== response) invalid = true;
        observed.response = response;
        if (observed.kind === 'model' && response.status() === 401) invalid = true;
        if (observed.kind === 'model' && response.status() === 409) {
          // The production interceptor invalidates auth for this structured code,
          // even though modelsStore.fetch itself resolves ordinary read errors.
          const check = {}; pendingAuthChecks.add(check);
          Promise.resolve().then(() => response.json()).then(body => {
            if (!closed && body?.code === 'ACCOUNT_CHANGED') invalid = true;
          }, () => { if (!closed) invalid = true; }).finally(() => pendingAuthChecks.delete(check));
        }
      }
    };
    const onFinished = request => { const observed = requests.get(request); if (observed) observed.finished = true; };
    const onFailed = request => { const observed = requests.get(request); if (observed) { observed.failed = true; observed.finished = true; if (observed.kind !== 'model') invalid = true; } };
    const onNavigation = navigated => { if (navigated === frame) invalid = true; };
    const listeners = { request: onRequest, response: onResponse, requestfinished: onFinished, requestfailed: onFailed, framenavigated: onNavigation, close: () => { invalid = true; } };
    const snapshot = () => ({ phase, retried, deadline, remainingBudgetMs: deadline - now(), loginStatus: login?.response?.status() ?? null,
      bootstrapStatus: bootstrap?.response?.status() ?? null, modelStatus: model?.response?.status() ?? null, expectedUserId });
    const checkForm = async rateLimited => {
      current();
      const state = await form.read(); current();
      if (!state.unchanged || !state.visible || !state.enabled || rateLimited && !state.rateLimited) throw new Error('Original phone login form changed or is not ready');
    };
    const settled = async read => { await poll(() => { current(); return read(); }, Math.min(5000, budget())); current(); };
    const settleAuthentication = async () => {
      await settled(() => pendingAuthChecks.size === 0);
      // A new 409 during the last polling await is unknown, never success.
      current();
      if (pendingAuthChecks.size) throw new Error('Phone login authentication response is still pending');
    };
    const click = async previous => {
      await checkForm(!!previous);
      // The adapter calls this only after its final browser-side form read,
      // immediately before the native click. Requests during that read are stale.
      const beginClick = () => {
        current();
        if (previous && (login !== previous || login.response !== previous.authorizingResponse || login.failed || !login.finished || login.response.status() !== 429)) throw new Error('Phone login 429 is no longer current');
        armed = true; login = null;
        return budget();
      };
      await form.click(budget(), beginClick, current); current();
      await settled(() => !!login?.finished && !!login.response);
      if (armed || login === previous) throw new Error('Click did not start its own phone login request');
    };
    try {
      for (const [event, listener] of Object.entries(listeners)) page.on(event, listener);
      form = await prepare(budget); current();
      phase = 'submit'; await click(null);
      if (login.response.status() === 429) {
        retried = true; // Reserve the sole additional click before any recovery await.
        phase = 'rate-limited';
        const rejected = login; rejected.authorizingResponse = rejected.response;
        const retryAt = sessionRetryAt(rejected.response.headers()['retry-after'], now());
        if (retryAt === null) throw new Error('Phone recovery requires a bounded server Retry-After');
        const waitMs = () => {
          const remaining = Math.max(0, retryAt - now()) + 100;
          if (remaining + 5000 >= deadline - now()) throw new Error('Phone retry exceeds the original test budget');
          return remaining;
        };
        waitMs();
        await settled(async () => { const state = await form.read(); current(); if (!state.unchanged) throw new Error('Original phone login form changed'); return state.visible && state.enabled && state.rateLimited; });
        await checkForm(true); await capture(snapshot()); current(); await checkForm(true);
        await wait(waitMs()); current();
        phase = 'retry'; await click(rejected);
        if (login.response.status() === 429) throw new Error('Second phone login 429; no further retry');
      }
      phase = 'initialize';
      const accepted = login;
      await assertExpectedLoginUser(accepted.response, expectedUserId); current();
      if (login !== accepted) throw new Error('Phone login was superseded during its body read');
      await settled(() => !!bootstrap?.finished && !!bootstrap.response);
      const initialized = bootstrap;
      if (initialized.failed || initialized.response.status() !== 200 || (await initialized.response.json())?.user?.id !== expectedUserId) throw new Error('Phone login bootstrap did not confirm the expected user');
      current();
      if (bootstrap !== initialized) throw new Error('Phone login bootstrap was superseded');
      // Catalog reads are diagnostic only: ordinary failures/repeated reads must
      // not invent an extra success gate beyond the actual product workspace.
      await workspace(Math.min(5000, budget())); current(); await settleAuthentication();
      if (login !== accepted || bootstrap !== initialized) throw new Error('Phone login identity changed during the final workspace check');
      phase = 'workspace'; await capture(snapshot()); current(); await settleAuthentication();
      await form.dispose(); form = null; current(); await settleAuthentication();
      // No await after these terminal checks: even the drain Promise can be
      // followed by a newly invalidating response before this continuation.
      current();
      if (pendingAuthChecks.size) throw new Error('Phone login authentication response is still pending');
      succeeded = true;
    } catch (error) {
      phase = 'failed';
      try { await capture(snapshot()); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally {
      try { if (form) await form.dispose(); } catch { /* The operation has already failed. */ }
      for (const [event, listener] of Object.entries(listeners)) page.off(event, listener);
      closed = true; requests.clear(); pendingAuthChecks.clear(); active = false; failed = !succeeded;
    }
  };
}
