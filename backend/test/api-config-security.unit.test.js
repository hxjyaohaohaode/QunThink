import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const {
  decryptStoredApiKey,
  encryptApiKeyForStorage,
  toPublicApiConfigs
} = await import('../src/utils/apiConfigSecurity.js');
const { assertSafeExternalUrl, isBlockedAddress } = await import('../src/utils/safeExternalUrl.js');

test('API keys are encrypted at rest and never included in public config', () => {
  const secret = 'sk-sensitive-test-key';
  const stored = encryptApiKeyForStorage(secret);
  assert.equal(stored.apiKeyEncrypted, true);
  assert.notEqual(stored.apiKey, secret);
  assert.equal(decryptStoredApiKey(stored), secret);

  const publicConfig = toPublicApiConfigs({ deepseek: { ...stored, baseUrl: 'https://api.example.com/v1' } });
  assert.equal(publicConfig.deepseek.apiKey, '');
  assert.equal(publicConfig.deepseek.apiKeyConfigured, true);
  assert.equal(JSON.stringify(publicConfig).includes(secret), false);
});

test('legacy plaintext keys remain readable for controlled migration', () => {
  assert.equal(decryptStoredApiKey({ apiKey: 'legacy-key' }), 'legacy-key');
});

test('SSRF guard blocks local and reserved address ranges', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  await assert.rejects(() => assertSafeExternalUrl('http://127.0.0.1:3000/v1'), /不允许/);
  await assert.rejects(() => assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'), /不允许/);
});
