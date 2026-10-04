import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody } from '../src/services/ai/transport.js';

const model = { model: 'unlisted-future-model', protocol: 'openai', tokenParameter: 'max_tokens',
  contextWindow: 2048, maxTokens: 256, temperature: null };

test('required system rules and current request are never cut to fit a smaller model', () => {
  const rules = '必须保留原稿'.repeat(800);
  assert.throws(() => buildRequestBody(model, [
    { role: 'system', content: rules }, { role: 'user', content: '现在执行' }
  ]), error => error.code === 'REQUIRED_CONTEXT_OVERFLOW');
  const current = '新的纠正'.repeat(900);
  assert.throws(() => buildRequestBody(model, [
    { role: 'system', content: '不得泄露私人资料' }, { role: 'user', content: current }
  ]), error => error.code === 'REQUIRED_CONTEXT_OVERFLOW');
});

test('older conversation is omitted as whole messages and the omission is measurable', () => {
  let audit;
  const messages = [
    { role: 'system', content: '始终遵守当前用户范围' },
    { role: 'user', content: '旧话题 '.repeat(800) },
    { role: 'assistant', content: '旧回答 '.repeat(600) },
    { role: 'user', content: '新问题及最新纠正' }
  ];
  const body = buildRequestBody(model, messages, { onContextAudit: value => { audit = value; } });
  assert.deepEqual(body.messages.map(message => message.content), [messages[0].content, messages[3].content]);
  assert.equal(audit.omitted, 2);
  assert.ok(audit.estimatedBytes <= audit.byteAllowance);
});

test('multimodal payload survives budget compilation without partial base64 slicing', () => {
  const dataUrl = `data:image/png;base64,${'a'.repeat(50000)}`;
  const body = buildRequestBody({ ...model, contextWindow: 65536 }, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }
  ]);
  assert.equal(body.messages[0].content[0].image_url.url, dataUrl);
  assert.throws(() => buildRequestBody({ ...model, contextWindow: 8192 }, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }
  ]), error => error.code === 'REQUIRED_CONTEXT_OVERFLOW');
});
