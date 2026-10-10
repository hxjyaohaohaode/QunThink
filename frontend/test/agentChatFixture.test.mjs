import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentFixtureEnvironment, inspectAgentRequest, AGENT_PARTIAL, AGENT_COMPLETE, startAgentChatFixture } from '../scripts/agent-chat-fixture.mjs';
const model = 'agent-fixture-12345678-1234-4234-8234-123456789abc';
test('Agent browser fixture rejects arbitrary models and malformed bodies', () => {
  for (const body of [null, {}, { model: 'real-model', messages: [] }, { model, messages: null }]) assert.throws(() => inspectAgentRequest(body), /Only synthetic/);
});
test('only the latest explicit synthetic request holds the stream; prior history cannot hold the next message', () => {
  const prior = { role: 'user', content: 'AGENT-E2E-STOP' };
  assert.deepEqual(inspectAgentRequest({ model, messages: [prior], stream: true }), { stream: true, hold: true, content: AGENT_PARTIAL });
  assert.deepEqual(inspectAgentRequest({ model, messages: [prior, { role: 'assistant', content: AGENT_PARTIAL }, { role: 'user', content: 'AGENT-E2E-CONTINUE' }], stream: true }), { stream: true, hold: false, content: AGENT_COMPLETE });
  const creation = inspectAgentRequest({ model, messages: [prior], stream: false });
  assert.equal(creation.hold, false); assert.ok(JSON.parse(creation.content).system_prompt.length >= 30);
});
test('fixture refuses to open a listener outside the isolated test environment', async () => {
  const mode = process.env.NODE_ENV, auth = process.env.AUTH_MODE;
  try {
    process.env.NODE_ENV = 'production'; process.env.AUTH_MODE = 'session';
    await assert.rejects(startAgentChatFixture(), /isolated test backend/);
  } finally {
    if (mode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = mode;
    if (auth === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = auth;
  }
});

test('test launcher only preserves named runtime variables and replaces dotenv, keys, and database paths', () => {
  const env = buildAgentFixtureEnvironment({ PATH: '/synthetic/bin', HOME: '/synthetic/home', CI: 'true', GITHUB_RUN_ID: 'synthetic-run',
    OPENAI_API_KEY: 'must-not-inherit', ALIYUN_SECRET_KEY: 'must-not-inherit', ENCRYPTION_KEY: 'must-not-inherit',
    DATABASE_URL: 'must-not-inherit', MONGODB_URI: 'must-not-inherit', DATA_DIR: '/must-not-inherit', AUTH_DB_PATH: '/must-not-inherit',
    DOTENV_CONFIG_PATH: '/must-not-inherit', DOTENV_CONFIG_OVERRIDE: 'true', NODE_OPTIONS: '--require=/must-not-inherit',
    HTTP_PROXY: 'must-not-inherit', QUNTHINK_SHARED_PROVIDER_KEYS: '1' }, '/tmp/synthetic-fixture', '/tmp/synthetic-fixture/empty.env', 'synthetic-new-key');
  assert.equal(env.PATH, '/synthetic/bin'); assert.equal(env.CI, 'true'); assert.equal(env.GITHUB_RUN_ID, 'synthetic-run');
  assert.equal(env.DOTENV_CONFIG_PATH, '/tmp/synthetic-fixture/empty.env');
  assert.equal(env.ENCRYPTION_KEY, 'synthetic-new-key'); assert.equal(env.DATA_DIR, '/tmp/synthetic-fixture');
  assert.equal(env.AUTH_DB_PATH, '/tmp/synthetic-fixture/auth.json'); assert.equal(env.MONGODB_URI, '');
  assert.equal(env.NODE_ENV, 'test'); assert.equal(env.AUTH_MODE, 'session'); assert.equal(env.QUNTHINK_SHARED_PROVIDER_KEYS, '0');
  for (const key of ['OPENAI_API_KEY', 'ALIYUN_SECRET_KEY', 'DATABASE_URL', 'DOTENV_CONFIG_OVERRIDE', 'NODE_OPTIONS', 'HTTP_PROXY']) assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes('must-not-inherit'));
});
