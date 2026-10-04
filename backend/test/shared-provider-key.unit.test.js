import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityFingerprint, getCatalogData, publicCatalog } from '../src/services/ai/catalog.js';

test('server provider credentials require an operator opt-in and never follow a changed endpoint', () => {
  const keyBefore = process.env.DEEPSEEK_API_KEY;
  const sharingBefore = process.env.QUNTHINK_SHARED_PROVIDER_KEYS;
  try {
    process.env.DEEPSEEK_API_KEY = 'server-owned-test-secret';
    delete process.env.QUNTHINK_SHARED_PROVIDER_KEYS;
    const disabled = publicCatalog({}).providers.find(provider => provider.id === 'deepseek');
    assert.equal(disabled.keySource, 'none');
    assert.equal(disabled.ready, false);

    process.env.QUNTHINK_SHARED_PROVIDER_KEYS = '1';
    const enabled = publicCatalog({}).providers.find(provider => provider.id === 'deepseek');
    assert.equal(enabled.keySource, 'environment');
    assert.equal(enabled.ready, true);

    const catalog = getCatalogData({});
    const model = catalog.models.find(item => item.id === 'deepseek');
    const provider = catalog.providers.find(item => item.id === model.providerId);
    const oldFingerprint = capabilityFingerprint(model, provider);
    const checked = { modelCatalog: catalog, modelCapabilityChecks: {
      deepseek: { chat: { status: 'verified', fingerprint: oldFingerprint } }
    } };
    assert.deepEqual(publicCatalog(checked).models.find(item => item.id === 'deepseek').verifiedCapabilities, ['chat']);
    process.env.DEEPSEEK_API_KEY = 'rotated-server-owned-test-secret';
    assert.deepEqual(publicCatalog(checked).models.find(item => item.id === 'deepseek').verifiedCapabilities, []);
    assert.notEqual(capabilityFingerprint(model, provider), oldFingerprint);

    delete process.env.QUNTHINK_SHARED_PROVIDER_KEYS;
    const userConnection = { aiApiConfigs: { deepseek: { apiKey: 'user-key-before' } } };
    const userFingerprint = capabilityFingerprint(model, provider, userConnection);
    assert.notEqual(userFingerprint, capabilityFingerprint(model, provider, {
      aiApiConfigs: { deepseek: { apiKey: 'user-key-after' } }
    }));

    const custom = getCatalogData({});
    const deepseek = custom.providers.find(provider => provider.id === 'deepseek');
    deepseek.baseUrl = 'https://different-provider.example/v1';
    assert.equal(publicCatalog({ modelCatalog: custom }).providers
      .find(provider => provider.id === 'deepseek').keySource, 'none');
    deepseek.baseUrl = 'https://api.deepseek.com';
    deepseek.keyCleared = true;
    assert.equal(publicCatalog({ modelCatalog: custom }).providers
      .find(provider => provider.id === 'deepseek').keySource, 'none');
  } finally {
    if (keyBefore === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = keyBefore;
    if (sharingBefore === undefined) delete process.env.QUNTHINK_SHARED_PROVIDER_KEYS;
    else process.env.QUNTHINK_SHARED_PROVIDER_KEYS = sharingBefore;
  }
});
