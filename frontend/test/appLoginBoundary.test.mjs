import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const root = resolve(import.meta.dirname, '..');
const browserWindow = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browserWindow, document: browserWindow.document,
  localStorage: browserWindow.localStorage });
after(() => browserWindow.close());
const app = await readFile(resolve(root, 'src/App.tsx'), 'utf8');
function extract(startText, endText, rename) {
  const start = app.indexOf(startText), end = app.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, `Production boundary found: ${startText}`);
  return rename(app.slice(start, end));
}
// Keep production callback/orchestration code intact. Render-only App wiring is
// replaced, while modelsStore.fetch and Axios's entire interceptor chain are real.
const login = extract('const handleLoginSuccess = useCallback(async () => {', '\n  }, []);',
  source => source.replace('const handleLoginSuccess = useCallback(async () => {', 'export async function handleLoginSuccess() {') + '\n}');
const initialize = extract('function assertCurrentAuthGeneration(', '\nasync function handleLogout(',
  source => source.replace('async function initializeUserData(', 'export async function initializeUserData('));
const bootstrap = extract('const bootstrapSession = async () => {', '\n    };\n\n    bootstrapSession();',
  source => source.replace('const bootstrapSession = async () => {', 'export async function bootstrapSession() {') + '\n}');
globalThis.__loginBoundary = { user: null, authenticated: false, phase: 'auth', persisted: [] };
const bundled = await build({
  stdin: { resolveDir: root, loader: 'ts', contents: `
    import { api, axiosInstance, confirmAuthIdentity, getAuthGeneration } from './src/services/api';
    import { useModelsStore } from './src/stores/modelsStore';
    export { axiosInstance, confirmAuthIdentity, useModelsStore };
    const state = () => globalThis.__loginBoundary;
    const AUTH_MODE = 'session', cancelled = false;
    const dataInitializedRef = { current: false }, splashCompletedRef = { current: false };
    const hydrateBootstrapData = user => { state().user = user; confirmAuthIdentity(user); };
    const persistSessionInfo = user => state().persisted.push(user);
    const getCacheUserId = () => state().user, getPersistedSessionInfo = () => null;
    const getDevUserId = () => 'synthetic-dev';
    const setIsAuthenticated = value => { state().authenticated = value; };
    const setAppPhase = value => { state().phase = value; };
    const setSessionCheckError = value => { state().sessionError = value; };
    const isAuthFailure = error => [401, 403].includes(error?.status ?? error?.response?.status) || error?.code === 'ACCOUNT_CHANGED';
    const useGroupsStore = { getState: () => ({ fetchGroups: async () => {} }) };
    const useProfileStore = { getState: () => ({ fetchProfile: async () => {} }) };
    const usePersonasStore = { getState: () => ({ fetchPersonas: async () => {} }) };
    ${initialize}\n${bootstrap}\n${login}
  ` },
  bundle: true, format: 'esm', platform: 'browser', write: false,
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_AUTH_MODE': '"session"' },
  plugins: [{ name: 'login-boundary-fixtures', setup(buildTool) {
    buildTool.onResolve({ filter: /utils\/cacheUtils$/ }, () => ({ path: 'cache', namespace: 'fixture' }));
    buildTool.onResolve({ filter: /\.\/runtimeConfig$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    buildTool.onResolve({ filter: /\.\/personasStore$/ }, () => ({ path: 'personas', namespace: 'fixture' }));
    buildTool.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents: {
      cache: 'export const getCacheUserId = () => globalThis.__loginBoundary.user;',
      runtime: "export const getApiBaseUrl = () => '/api'; export const getApiBaseUrlCandidates = () => ['/api']; export const rememberBackendOrigin = () => {};",
      personas: 'export const usePersonasStore = { getState: () => ({ fetchPersonas: async () => {} }) };',
    }[path] }));
  } }],
});
const { handleLoginSuccess, initializeUserData, bootstrapSession, axiosInstance, confirmAuthIdentity, useModelsStore } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const response = (config, data) => ({ config, data, status: 200, statusText: 'OK', headers: {} });
const catalog = { providers: [], models: [], defaults: {}, revision: 1 };
const flush = () => new Promise(resolveWait => setTimeout(resolveWait, 0));
function replaceSession(user) {
  confirmAuthIdentity(null); useModelsStore.getState().cleanup();
  globalThis.__loginBoundary.user = user;
  if (user) confirmAuthIdentity(user);
  globalThis.__loginBoundary.authenticated = !!user;
  globalThis.__loginBoundary.phase = user ? 'app' : 'auth';
}
beforeEach(() => {
  confirmAuthIdentity(null); useModelsStore.getState().cleanup();
  globalThis.__loginBoundary = { user: null, authenticated: false, phase: 'auth', persisted: [] };
  document.cookie = 'XSRF-TOKEN=synthetic-csrf';
});
function delayModels() {
  let finish;
  axiosInstance.defaults.adapter = config => {
    if (config.url === '/auth/token') return Promise.resolve(response(config, { enabled: true, valid: true }));
    if (config.url === '/auth/me' || config.url === '/bootstrap') return Promise.resolve(response(config, { user: { id: 'synthetic-alice' } }));
    assert.equal(config.url, '/user/model-catalog');
    return new Promise(resolveModel => { finish = () => resolveModel(response(config, catalog)); });
  };
  return async () => {
    for (let attempt = 0; attempt < 20 && !finish; attempt++) await flush();
    assert.ok(finish, 'Model fetch reached real transport'); return finish;
  };
}

test('login completion cannot resurrect an account logged out while its model fetch was pending', async () => {
  const waitModel = delayModels(), pending = handleLoginSuccess(), finish = await waitModel();
  replaceSession(null); finish(); await pending;
  assert.equal(globalThis.__loginBoundary.authenticated, false);
  assert.equal(globalThis.__loginBoundary.phase, 'auth'); assert.deepEqual(globalThis.__loginBoundary.persisted, []);
});

test('an older login callback cannot change or persist over a replacement account', async () => {
  const waitModel = delayModels(), pending = handleLoginSuccess(), finish = await waitModel();
  replaceSession('synthetic-bob'); finish(); await pending;
  assert.equal(globalThis.__loginBoundary.user, 'synthetic-bob');
  assert.equal(globalThis.__loginBoundary.authenticated, true); assert.deepEqual(globalThis.__loginBoundary.persisted, []);
});

test('initialization rejects its stale continuation after hydration changed its starting generation', async () => {
  const waitModel = delayModels(), pending = initializeUserData('synthetic-alice'), finish = await waitModel();
  replaceSession(null); finish(); await assert.rejects(pending, error => error.code === 'STALE_ACCOUNT_RESPONSE');
});

test('initial session bootstrap cannot restore auth or persist its old user after logout', async () => {
  const waitModel = delayModels(), pending = bootstrapSession(), finish = await waitModel();
  replaceSession(null); finish(); await pending;
  assert.equal(globalThis.__loginBoundary.authenticated, false);
  assert.equal(globalThis.__loginBoundary.phase, 'auth'); assert.deepEqual(globalThis.__loginBoundary.persisted, []);
});

test('stale bootstrap failure cannot overwrite the state of a newer successful login', async () => {
  let fail;
  axiosInstance.defaults.adapter = config => new Promise((_resolve, reject) => {
    fail = () => reject(Object.assign(new Error('obsolete failure'), { config, response: { status: 401, data: { error: 'expired' } } }));
  });
  const pending = handleLoginSuccess(); await flush();
  replaceSession('synthetic-bob'); fail(); await pending;
  assert.equal(globalThis.__loginBoundary.authenticated, true); assert.equal(globalThis.__loginBoundary.phase, 'app');
});

test('current login still persists and enters the app after its model fetch completes', async () => {
  const waitModel = delayModels(), pending = handleLoginSuccess(), finish = await waitModel();
  finish(); await pending;
  assert.equal(globalThis.__loginBoundary.authenticated, true); assert.equal(globalThis.__loginBoundary.phase, 'app');
  assert.deepEqual(globalThis.__loginBoundary.persisted, ['synthetic-alice']);
});
