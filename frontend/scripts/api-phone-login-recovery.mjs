import { assertExpectedLoginUser } from './phone-login-recovery.mjs';
import { sessionRetryAt } from './q1-navigation.mjs';

// E2E API precondition only. A successful call permits the next explicit account
// transition; a failed/uncertain call cannot mint another retry in this context.
const operations = new WeakMap();
class ApiLoginError extends Error {}
const fail = message => { throw new ApiLoginError(message); };
function retryTime(header, observedAt) {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  // Date.parse also accepts non-HTTP strings such as "1.5". Admit only integer
  // delta-seconds or canonical IMF-fixdate, including its correct weekday.
  if (!/^\d+$/.test(value) && (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) || new Date(Date.parse(value)).toUTCString() !== value)) return null;
  return sessionRetryAt(value, observedAt);
}
function sessionSnapshot(cookies) {
  const sessions = cookies.filter(cookie => cookie.name === 'session_token');
  if (sessions.length !== 1 || !sessions[0].value) fail('API phone login requires one current session cookie');
  // Include all returned cookie attributes; never hash, attach or log secrets.
  return JSON.stringify(Object.entries(sessions[0]).sort(([a], [b]) => a.localeCompare(b)));
}

export async function apiPhoneLogin({ page, context, deadline, intent, capture = async () => {}, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const previous = operations.get(context);
  if (previous?.active) { previous.invalid = true; fail('Concurrent API phone login changed the active operation'); }
  if (previous?.failed) fail('A previously failed API phone login cannot start another operation');
  const operation = { active: true, failed: true, invalid: false }; operations.set(context, operation);
  const original = { ...intent }, data = Object.freeze({ phone: intent.phone, password: intent.password });
  const url = page.url(), origin = new URL(url).origin, frame = page.mainFrame();
  const loginUrl = origin + '/api/auth/login-phone', csrfUrl = origin + '/api/csrf-token';
  let attempt = 0, status = null, actor, accepted = false;
  const invalidate = () => { operation.invalid = true; };
  const navigation = changedFrame => { if (changedFrame === frame) invalidate(); };
  const authRequest = request => {
    try { const target = new URL(request.url()); if (target.origin === origin && target.pathname.startsWith('/api/auth/') && request.method() !== 'GET') invalidate(); }
    catch { invalidate(); }
  };
  const current = () => {
    const remaining = deadline - now() - 5000;
    if (!Number.isFinite(remaining) || remaining <= 0) fail('API phone login exceeds the original test budget');
    if (operation.invalid || operations.get(context) !== operation || page.context() !== context || page.isClosed() || page.mainFrame() !== frame || page.url() !== url ||
        Object.keys(original).length !== Object.keys(intent).length || Object.keys(original).some(key => original[key] !== intent[key])) fail('API phone login intent, actor or page changed');
    return remaining;
  };
  const readActor = async () => {
    current(); const cookies = await context.cookies(loginUrl); current();
    return sessionSnapshot(cookies);
  };
  const evidence = phase => capture({ phase, method: 'POST', path: '/api/auth/login-phone', attempt, status, deadline, remainingBudgetMs: deadline - now() });
  try {
    page.on('close', invalidate); page.on('framenavigated', navigation);
    context.on('close', invalidate); context.on('request', authRequest);
    if (![original.phone, original.password, original.expectedUserId, original.currentUserId].every(value => typeof value === 'string' && value.length)) fail('API phone login requires an explicit original and target identity');
    actor = await readActor(); current();
    const csrfResponse = await context.request.get(csrfUrl, { timeout: current(), maxRetries: 0, maxRedirects: 0 }); current();
    if (csrfResponse.url() !== csrfUrl) fail('API phone login received an unrelated CSRF response');
    if (csrfResponse.status() !== 200) fail('API phone login CSRF read did not return 200');
    const csrf = await csrfResponse.json(); current();
    if (typeof csrf?.csrfToken !== 'string' || !csrf.csrfToken) fail('API phone login requires a CSRF token');
    const headers = Object.freeze({ 'x-csrf-token': csrf.csrfToken });
    const submit = async () => {
      // This must be the last await before POST. Recheck synchronous intent and
      // budget after it; never hide another await in a generic submit callback.
      const cookies = await context.cookies(loginUrl);
      const timeout = current();
      if (sessionSnapshot(cookies) !== actor) fail('API phone login actor changed');
      attempt++;
      return context.request.post(loginUrl, { headers, data, timeout, maxRetries: 0, maxRedirects: 0 });
    };
    let response = await submit(); current(); status = response.status();
    if (response.url() !== loginUrl) fail('API phone login received an unrelated response');
    if (status === 429) {
      const retryAt = retryTime(response.headers()['retry-after'], now());
      if (retryAt === null) fail('API recovery requires a bounded server Retry-After');
      const delay = () => {
        const ms = Math.max(0, retryAt - now()) + 100;
        if (ms >= current()) fail('API phone retry exceeds the original test budget');
        return ms;
      };
      delay();
      if (await readActor() !== actor) fail('API phone login actor changed'); current();
      await evidence('rate-limited'); current();
      await wait(delay()); current();
      if (now() < retryAt + 100) fail('API phone login server wait did not finish');
      response = await submit(); current(); status = response.status();
      if (response.url() !== loginUrl) fail('API phone login received an unrelated response');
      if (status === 429) fail('Second API phone login 429; no further retry');
    }
    if (status !== 200) fail('API phone login did not return 200; no blind retry');
    // A200 has already admitted the login. Body/account failure is terminal,
    // never a reason to submit again or to compare against the old cookie.
    const acceptedActor = await readActor(); current();
    try { await assertExpectedLoginUser(response, original.expectedUserId); }
    catch { fail('API phone login returned a different user or unreadable body'); }
    current();
    if (await readActor() !== acceptedActor) fail('API phone login accepted actor changed'); current();
    await evidence('accepted'); current();
    if (await readActor() !== acceptedActor) fail('API phone login accepted actor changed'); current();
    accepted = true;
  } catch (error) {
    // Tool/network errors may contain credentials or response material.
    throw error instanceof ApiLoginError ? error : new ApiLoginError('API phone login failed with an unknown outcome; no further retry');
  } finally {
    page.off('close', invalidate); page.off('framenavigated', navigation);
    context.off('close', invalidate); context.off('request', authRequest);
    operation.active = false; operation.failed = !accepted;
    actor = undefined;
  }
}
