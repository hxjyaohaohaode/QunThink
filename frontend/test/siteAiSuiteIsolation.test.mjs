import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSiteAiFixtureEnvironment } from '../scripts/site-ai-fixture.mjs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
test('site suite retains real limits but isolates ports, data, credentials and provider access', () => {
  const env = buildSiteAiFixtureEnvironment({ PATH: '/fixture/bin', SERVER_AI_ENABLED: 'true', SERVER_AI_API_KEY: 'must-not-inherit', SUPABASE_DB_URL: 'must-not-inherit', DATA_DIR: 'must-not-inherit', AI_ALLOWED_LOCAL_ORIGINS: 'must-not-inherit' }, '/tmp/site-only', '/tmp/site-only/empty.env', 'synthetic-key');
  assert.equal(env.PORT, '3222'); assert.equal(env.CORS_ORIGINS, 'http://127.0.0.1:3220');
  assert.equal(env.DATA_DIR, '/tmp/site-only'); assert.equal(env.AUTH_DB_PATH, '/tmp/site-only/auth.json');
  assert.equal(env.MEMORY_DELETION_DIR, '/tmp/site-only/memory-deletions');
  assert.equal(env.DOTENV_CONFIG_PATH, '/tmp/site-only/empty.env');
  assert.equal(env.AUTH_MODE, 'session'); assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.SERVER_AI_ENABLED, 'false'); assert.equal(env.SERVER_AI_API_KEY, undefined);
  assert.equal(env.AI_ALLOWED_LOCAL_ORIGINS, ''); assert.equal(env.SUPABASE_DB_URL, '');
  assert.ok(!JSON.stringify(env).includes('must-not-inherit'));
  assert.ok(!Object.keys(env).some(key => /RATE_LIMIT|BYPASS/i.test(key)));
});
test('new suite remains mandatory for both core matrix jobs with separate evidence paths', () => {
  const core = read('../playwright.config.ts'), site = read('../playwright.site-basic.config.ts'), workflow = read('../../.github/workflows/ci.yml');
  assert.match(core, /testIgnore:.*\*\*\/site-basic-ai\.spec\.ts/);
  assert.match(site, /testMatch: 'site-basic-ai\.spec\.ts'/); assert.match(site, /retries: 0/);
  assert.equal((site.match(/reuseExistingServer: false/g) || []).length, 2);
  assert.match(site, /test-results\/site-basic/); assert.match(site, /playwright-report\/site-basic/);
  assert.match(site, /desktop-chromium/); assert.match(site, /mobile-reduced-motion/);
  const step = workflow.split('      - name: Site AI isolated desktop/mobile consent and failure flows')[1]?.split('      - name:')[0];
  assert.ok(step); assert.match(step, /!cancelled\(\) && matrix\.suite == 'core'/);
  assert.match(step, /playwright\.site-basic\.config\.ts --project=\$\{\{ matrix\.project \}\}/);
  assert.doesNotMatch(step, /continue-on-error|\|\| true/);
  assert.match(workflow, /archive \.ci-evidence frontend\/playwright-report frontend\/test-results/);
});
