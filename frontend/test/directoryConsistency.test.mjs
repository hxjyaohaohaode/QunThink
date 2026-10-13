import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
globalThis.__directoryTest = { user: 'alice', generation: 1, cache: null, api: {} };
const bundle = await build({ stdin: { resolveDir: root, contents: `export {useGroupsStore as groups} from './src/stores/groupsStore';export {useAgentsStore as agents} from './src/stores/agentsStore';` }, bundle: true, write: false, format: 'esm', platform: 'browser', plugins: [{ name: 'boundaries', setup(build) {
  build.onResolve({ filter: /(?:services\/api|utils\/cacheUtils)$/ }, ({ path }) => ({ path: path.endsWith('api') ? 'api' : 'cache', namespace: 'mock' }));
  build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({ contents: path === 'api'
    ? `export const getAuthGeneration=()=>globalThis.__directoryTest.generation;export const api=new Proxy({},{get:(_,name)=>(...args)=>globalThis.__directoryTest.api[name](...args)});`
    : `export const getCacheUserId=()=>globalThis.__directoryTest.user;export const loadGroupsCache=()=>null;export const saveGroupsCache=data=>{globalThis.__directoryTest.cache=data};export const removeCache=()=>{};export const loadMessagesCacheAsync=async()=>null;export const saveMessagesCache=()=>{};`, loader: 'js' }));
} }] });
const { groups, agents } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const fixture = globalThis.__directoryTest;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
beforeEach(() => {
  fixture.generation++; fixture.user = 'alice'; fixture.api = {}; fixture.cache = null;
  groups.setState({ groups: [], currentGroup: null, loading: false, initialized: false, error: null });
  agents.setState({ agents: [], currentAgent: null, loading: false, error: null, creatingAgent: false });
});

test('server removals and empty fields replace stale group previews and settings', async () => {
  const old = { id: 'g', name: 'A', announcement: 'deleted', last_message: 'private text', avatar_url: 'old.png' };
  groups.setState({ groups: [old, { id: 'removed' }], currentGroup: old });
  const updated = { ...old, announcement: '', last_message: null, avatar_url: '' };
  fixture.api.getGroups = async () => [updated]; await groups.getState().fetchGroups();
  assert.deepEqual(groups.getState().groups, [updated]); assert.deepEqual(groups.getState().currentGroup, updated); assert.deepEqual(fixture.cache, [updated]);
});

for (const [store, fetch, apiName, field, upsert] of [[groups, 'fetchGroups', 'getGroups', 'groups', 'upsertGroup'], [agents, 'fetchAgents', 'getAgents', 'agents', 'upsertAgent']]) {
  test(`${field}: an earlier directory response cannot undo an acknowledged mutation`, async () => {
    const read = deferred(); fixture.api[apiName] = () => read.promise;
    const pending = store.getState()[fetch]();
    store.getState()[upsert]({ id: 'new', name: 'saved' }); read.resolve([]); await pending;
    assert.equal(store.getState()[field][0].id, 'new'); assert.equal(store.getState().loading, false);
  });
  test(`${field}: old account response and errors cannot overwrite the new account`, async () => {
    const old = deferred(); fixture.api[apiName] = () => old.promise;
    const pending = store.getState()[fetch](); fixture.user = 'bob'; fixture.generation++;
    store.setState({ [field]: [{ id: 'bob' }], loading: false, error: null }); old.reject(new Error('alice only')); await pending;
    assert.deepEqual(store.getState()[field], [{ id: 'bob' }]); assert.equal(store.getState().error, null);
  });
}

test('forced refresh reads a just-created space even inside the normal freshness window', async () => {
  let calls = 0; fixture.api.getGroups = async () => { calls++; return [{ id: String(calls) }]; };
  await groups.getState().fetchGroups(); await groups.getState().fetchGroups(); assert.equal(calls, 1);
  await groups.getState().fetchGroups(false, true); assert.equal(calls, 2); assert.equal(groups.getState().groups[0].id, '2');
});
