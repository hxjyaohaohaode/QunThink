import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteBasicChat, siteAiConfig } from '../src/services/ai/siteBasicChat.js';
const env = { SERVER_AI_ENABLED: 'true', SERVER_AI_API_KEY: 'synthetic-site-key', SERVER_AI_BASE_URL: 'https://api.deepseek.com', SERVER_AI_MODEL: 'deepseek-fixture' };
function setup(overrides = {}) {
  const calls = []; let reservations = 0;
  const service = createSiteBasicChat({ env: () => env, safeOptions: async () => ({ maxRedirects: 0, proxy: false }), reserve: async () => { reservations++; }, post: async (...args) => { calls.push(args); return { data: { choices: [{ message: { content: 'real intercepted response' } }] } }; }, ...overrides });
  return { service, calls, reservations: () => reservations };
}
const input = { prompt: '本次文本', consent: true, consentToken: siteAiConfig(env).consentToken };
test('disabled, incomplete and insecure configurations never activate', () => {
  assert.equal(siteAiConfig({}), null);
  for (const key of Object.keys(env)) assert.equal(siteAiConfig({ ...env, [key]: '' }), null);
  for (const url of ['http://public.example/v1', 'https://user:pass@public.example/v1', 'https://api.deepseek.com?q=secret', 'https://public.example/#token']) assert.equal(siteAiConfig({ ...env, SERVER_AI_BASE_URL: url }), null);
});
test('status validates destination and contains no key or URL path', async () => {
  const { service } = setup(); const status = await service.status();
  assert.equal(status.available, true); assert.equal(status.providerOrigin, 'https://api.deepseek.com');
  assert.ok(!JSON.stringify(status).includes(env.SERVER_AI_API_KEY)); assert.ok(!JSON.stringify(status).includes('/v1'));
  assert.deepEqual(await setup({ safeOptions: async () => { throw new Error('private destination'); } }).service.status(), { available: false });
});
test('only explicitly consented current single prompt dispatches', async () => {
  const { service, calls, reservations } = setup();
  for (const invalid of [{ ...input, consent: false }, { ...input, consentToken: 'stale' }, { ...input, prompt: '' }, { ...input, prompt: 'a'.repeat(4001) }, { ...input, model: 'override' }, { ...input, messages: [] }, { ...input, endpoint: 'http://127.0.0.1' }]) await assert.rejects(service.chat(invalid));
  assert.equal(calls.length, 0); assert.equal(reservations(), 0);
  const result = await service.chat(input); assert.equal(result.generatedByAI, true); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { model: env.SERVER_AI_MODEL, messages: [{ role: 'user', content: input.prompt }], stream: false, max_tokens: 1024, thinking: { type: 'disabled' } });
  assert.equal(calls[0][2].maxRedirects, 0); assert.equal(calls[0][2].proxy, false); assert.equal(calls[0][2].timeout, 20000);
});
test('unsafe DNS or exhausted shared budget fail before send', async () => {
  for (const options of [{ safeOptions: async () => { throw new Error('blocked'); } }, { reserve: async () => { throw Object.assign(new Error('limit'), { status: 429 }); } }]) {
    const { service, calls } = setup(options); await assert.rejects(service.chat(input)); assert.equal(calls.length, 0);
  }
});
test('total concurrent requests bounded and failed calls never retried or refunded', async () => {
  const resolvers = []; const { service, reservations } = setup({ post: () => new Promise(resolve => resolvers.push(resolve)) });
  const a = service.chat(input); const b = service.chat(input); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.chat(input), { status: 429 }); assert.equal(reservations(), 2);
  for (const resolve of resolvers) resolve({ data: {} });
  await Promise.all([assert.rejects(a, { status: 502 }), assert.rejects(b, { status: 502 })]);
  assert.equal(reservations(), 2);
});
test('upstream errors and echoed credentials never reach response', async () => {
  const failure = setup({ post: async () => { throw Object.assign(new Error(env.SERVER_AI_API_KEY), { response: { data: env.SERVER_AI_API_KEY } }); } });
  await assert.rejects(failure.service.chat(input), error => error.status === 502 && !error.message.includes(env.SERVER_AI_API_KEY));
  const echo = setup({ post: async () => ({ data: { choices: [{ message: { content: env.SERVER_AI_API_KEY } }] } }) });
  assert.equal((await echo.service.chat(input)).content, '[redacted]');
});
test('disabled feature and aborted request do not dispatch', async () => {
  const disabled = setup({ env: () => ({}) }); await assert.rejects(disabled.service.chat(input), { status: 503 }); assert.equal(disabled.calls.length, 0);
  const active = setup(); const controller = new AbortController(); controller.abort(); await assert.rejects(active.service.chat(input, { signal: controller.signal })); assert.equal(active.calls.length, 0); assert.equal(active.reservations(), 0);
});

test('status coalesces concurrent DNS checks', async () => {
  let count = 0; let release;
  const { service } = setup({ safeOptions: () => { count++; return new Promise(resolve => { release = resolve; }); } });
  const pending = Array.from({ length: 20 }, () => service.status());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1); release({});
  assert.ok((await Promise.all(pending)).every(result => result.available));
  await service.status(); assert.equal(count, 1);
});

test('site configuration permits only verified domestic provider bases and own model families', () => {
  for (const [base, model] of [['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-fixture'], ['https://api.deepseek.com', 'deepseek-fixture'], ['https://api.xiaomimimo.com/v1', 'mimo-fixture']]) assert.ok(siteAiConfig({ ...env, SERVER_AI_BASE_URL: base, SERVER_AI_MODEL: model }));
  for (const [base, model] of [['https://api.deepseek.com.attacker.example', 'deepseek-fixture'], ['https://api.deepseek.com/redirect', 'deepseek-fixture'], ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen-fixture'], ['https://api.deepseek.com', 'foreign-model'], ['https://api.xiaomimimo.com/v1', 'qwen-fixture']]) assert.equal(siteAiConfig({ ...env, SERVER_AI_BASE_URL: base, SERVER_AI_MODEL: model }), null);
});

test('provider-specific non-thinking and output bounds are exact', async () => {
  for (const [base, model, expected] of [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-fixture', { max_completion_tokens: 1024, enable_thinking: false }],
    ['https://api.xiaomimimo.com/v1', 'mimo-fixture', { max_completion_tokens: 1024, thinking: { type: 'disabled' } }],
    ['https://api.deepseek.com', 'deepseek-fixture', { max_tokens: 1024, thinking: { type: 'disabled' } }]
  ]) {
    const configuration = { ...env, SERVER_AI_BASE_URL: base, SERVER_AI_MODEL: model };
    const { service, calls } = setup({ env: () => configuration });
    await service.chat({ ...input, consentToken: siteAiConfig(configuration).consentToken });
    assert.deepEqual(calls[0][1], { model, messages: [{ role: 'user', content: input.prompt }], stream: false, ...expected });
  }
});
