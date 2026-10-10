import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityFingerprint, getCatalogData, publicCatalog, resolveModelSnapshot, defaultModelIdSnapshot } from '../src/services/ai/catalog.js';
import { retireImplicitPresetMembers } from '../src/config/legacyModels.js';
import { syntheticModel, syntheticProvider } from './helpers/syntheticCatalog.js';

const defaults = { chat: null, vision: null, tts: null };
const savedCatalog = (provider = syntheticProvider(), model = syntheticModel()) => ({
  revision: 7, providers: [provider], models: [model], defaults: { ...defaults }
});

test('new accounts have no presets even with every retired server-key switch set', () => {
  const names = ['DEEPSEEK_API_KEY', 'GLM_API_KEY', 'MIMO_API_KEY', 'QWEN_API_KEY', 'MIMO_BASE_URL', 'QUNTHINK_SHARED_PROVIDER_KEYS'];
  const old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'synthetic-server-key';
    process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '1';
    process.env.MIMO_BASE_URL = 'https://server-only.example/v1';
    assert.deepEqual(getCatalogData({}), { revision: 0, providers: [], models: [], defaults });
    assert.deepEqual(publicCatalog({}).models, []);
    assert.throws(() => resolveModelSnapshot({}, 'deepseek'), error => error.status === 404);
    assert.throws(() => defaultModelIdSnapshot({}), error => error.status === 409);
    const provider = syntheticProvider({ id: 'deepseek', apiKey: '' });
    const data = { modelCatalog: savedCatalog(provider, syntheticModel({ providerId: 'deepseek' })) };
    const fingerprint = capabilityFingerprint(data.modelCatalog.models[0], provider, data);
    assert.equal(publicCatalog(data).providers[0].keySource, 'none');
    assert.equal(publicCatalog(data).providers[0].ready, false);
    assert.throws(() => resolveModelSnapshot(data, 'test_model'), error => error.status === 409);
    process.env.DEEPSEEK_API_KEY = 'different-server-key';
    assert.equal(capabilityFingerprint(data.modelCatalog.models[0], provider, data), fingerprint);
  } finally {
    for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name];
  }
});

test('explicit user catalogs preserve models, credentials, defaults and existing verification', () => {
  const provider = syntheticProvider({ id: 'deepseek' });
  const model = syntheticModel({ id: 'deepseek', providerId: 'deepseek' });
  const modelCatalog = savedCatalog(provider, model);
  modelCatalog.defaults.chat = model.id;
  const data = { modelCatalog };
  const original = structuredClone(data);
  const fingerprint = capabilityFingerprint(model, provider, data);
  data.modelCapabilityChecks = { [model.id]: { chat: { status: 'verified', fingerprint } } };
  assert.equal(getCatalogData(data), modelCatalog);
  assert.deepEqual(data.modelCatalog, original.modelCatalog);
  assert.equal(publicCatalog(data).providers[0].keySource, 'user');
  assert.deepEqual(publicCatalog(data).models[0].verifiedCapabilities, ['chat']);
  assert.equal(resolveModelSnapshot(data, model.id, 'chat').apiKey, 'synthetic-user-owned-key');
  assert.equal(defaultModelIdSnapshot(data), model.id);
  assert.equal(JSON.stringify(publicCatalog(data)).includes('synthetic-user-owned-key'), false);
  provider.apiKey = 'synthetic-rotated-user-key';
  assert.notEqual(capabilityFingerprint(model, provider, data), fingerprint);
  assert.deepEqual(publicCatalog(data).models[0].verifiedCapabilities, []);
});

test('legacy user connections survive without auto-adding models and explicit overrides survive', () => {
  const data = { aiApiConfigs: {
    deepseek: { apiKey: 'synthetic-legacy-user-key', baseUrl: '' },
    zhipu: { apiKey: '', baseUrl: '' }, mimo: { apiKey: '', baseUrl: 'https://personal.example/v1' }
  } };
  const original = structuredClone(data);
  assert.deepEqual(getCatalogData(data).providers.map(p => p.id), ['deepseek', 'mimo']);
  assert.deepEqual(getCatalogData(data).models, []);
  assert.equal(publicCatalog(data).providers[0].keySource, 'user');
  assert.deepEqual(data, original);
  data.aiModels = { deepseek: { model: 'my-explicit-model' } };
  assert.equal(getCatalogData(data).models.length, 1);
  assert.equal(getCatalogData(data).models[0].model, 'my-explicit-model');
  assert.equal(resolveModelSnapshot(data, 'deepseek').apiKey, 'synthetic-legacy-user-key');
});

test('retiring implicit seeded memberships preserves history, user groups and user-created agents', () => {
  const data = {
    groups: [
      { id: 'group-presidential', type: 'preset', ai_members: ['deepseek', 'glm_air', 'mine'] },
      { id: 'my-group', type: 'custom', ai_members: ['deepseek'] }
    ],
    agents: [{ id: 'agent', model_roles: [{ modelId: 'deepseek' }] }],
    messages: [{ sender_id: 'deepseek', content: 'old history' }],
    tasks: [{ model_id: 'deepseek' }], customPersonas: { deepseek: { name: 'My old assistant' } }
  };
  const original = structuredClone(data);
  assert.equal(retireImplicitPresetMembers(data), true);
  assert.deepEqual(data.groups[0].ai_members, ['mine']);
  assert.deepEqual(data.groups[0].retired_ai_members, ['deepseek', 'glm_air']);
  for (const key of ['agents', 'messages', 'tasks', 'customPersonas']) assert.deepEqual(data[key], original[key]);
  assert.deepEqual(data.groups[1], original.groups[1]);
  assert.equal(retireImplicitPresetMembers(data), false);
  const owned = structuredClone(original);
  owned.modelCatalog = { models: [{ id: 'deepseek' }, { id: 'glm_air' }] };
  assert.equal(retireImplicitPresetMembers(owned), false);
});
