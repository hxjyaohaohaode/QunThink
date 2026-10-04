import axios from 'axios';
import { StringDecoder } from 'node:string_decoder';
import { getSafeAiRequestOptions } from '../../utils/safeExternalUrl.js';
import { compileContextMessages } from './contextCompiler.js';

export function providerHeaders(config) {
  return {
    'Content-Type': 'application/json',
    ...(config.protocol === 'anthropic'
      ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
      : config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
  };
}

function contextError() {
  return Object.assign(new Error('当前模型无法容纳必需的规则或输入，请缩小资料范围或选择更大上下文模型'), {
    status: 422, code: 'REQUIRED_CONTEXT_OVERFLOW'
  });
}

export function buildRequestBody(config, messages, { stream = false, maxTokens, onContextAudit, readableSources } = {}) {
  const outputLimit = Math.min(maxTokens || config.maxTokens || 4096, config.maxTokens || 4096);
  const budget = (config.contextWindow || 32000) - outputLimit - 512;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw contextError();
  const { system, conversation } = compileContextMessages(messages, {
    budget, readableSources, onContextAudit
  });
  const body = { model: config.model, messages: [...system, ...conversation], stream };
  body[config.protocol === 'anthropic' ? 'max_tokens' : config.tokenParameter || 'max_tokens'] = outputLimit;
  if (config.temperature !== null && config.temperature !== undefined) body.temperature = Math.min(config.temperature, config.protocol === 'anthropic' ? 1 : 2);
  if (config.protocol === 'anthropic') {
    body.system = system.map(m => m.content).join('\n\n');
    body.messages = conversation.map(m => ({ ...m, content: Array.isArray(m.content) ? m.content.map(part => {
      if (part.type !== 'image_url') return part;
      const url = part.image_url?.url || '';
      const match = url.match(/^data:([^;]+);base64,(.+)$/s);
      return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
    }) : m.content }));
  }
  return body;
}

export function responseText(data, protocol = 'openai') {
  const content = protocol === 'anthropic' ? data?.content : data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text || '').join('') : '';
}

export function responseUsage(data, protocol = 'openai') {
  const usage = data?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = protocol === 'anthropic' ? usage.input_tokens : usage.prompt_tokens;
  const outputTokens = protocol === 'anthropic' ? usage.output_tokens : usage.completion_tokens;
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const reportedTotal = usage.total_tokens;
  const summedTokens = inputTokens + outputTokens;
  if (!Number.isSafeInteger(summedTokens)) return null;
  const totalTokens = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
    ? reportedTotal : summedTokens;
  return { inputTokens, outputTokens, totalTokens, source: 'provider_response' };
}

export function describeProviderError(error) {
  if (error?.status && !error.response) return error.message;
  const status = error?.response?.status;
  if (status === 401 || status === 403) return '服务商拒绝了凭据，请检查 API Key 和访问权限';
  if (status === 404) return '服务地址或模型 ID 不存在，请在模型中心核对';
  if (status === 429) return '服务商限流或额度不足，请稍后再试';
  if (status === 400 || status === 422) return '模型不接受当前参数，请检查模型 ID、输出上限和协议';
  if (status >= 500) return `模型服务暂时不可用（${status}）`;
  if (error?.code === 'ENOTFOUND') return '模型服务域名无法解析';
  if (error?.code === 'ECONNREFUSED') return '无法连接模型服务，请检查服务是否启动';
  if (error?.code === 'ERR_CANCELED' || error?.name === 'AbortError') return '请求已取消或超时';
  return '模型请求失败，请检查服务地址和网络后重试';
}

export async function requestCompletion(config, messages, options = {}) {
  const body = buildRequestBody(config, messages, options);
  const safe = await getSafeAiRequestOptions(config.endpoint);
  const send = async () => {
    if (options.beforeDispatch && !(await options.beforeDispatch())) {
      throw Object.assign(new Error('模型输入来源已撤销'), { status: 409 });
    }
    return axios.post(config.endpoint, body, {
      ...safe, headers: providerHeaders(config), timeout: options.timeout || 60000,
      signal: options.signal, maxContentLength: 4 * 1024 * 1024
    });
  };
  // The caller may bind source validation and the beginning of the external
  // request to the same account lock. Return a non-thenable envelope so the
  // lock need not remain held until the provider finishes responding.
  const dispatched = options.dispatchGate
    ? await options.dispatchGate(send) : { responsePromise: send() };
  const response = await dispatched.responsePromise;
  const content = responseText(response.data, config.protocol);
  options.onUsage?.(responseUsage(response.data, config.protocol));
  if (!content.trim()) throw new Error('模型返回空内容');
  return content;
}

// Exported independently so fragmented UTF-8, SSE boundaries and error events
// can be verified without paid requests or a provider account.
export async function consumeSSE(readable, protocol, onChunk = () => {}, onUsage = () => {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', fullContent = '', ended = false;
  let anthropicInputTokens = null;
  const processEvent = event => {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') { ended = true; return; }
    const parsed = JSON.parse(data);
    if (parsed.error || parsed.type === 'error') throw new Error('模型服务在生成过程中返回错误');
    if (protocol === 'anthropic') {
      const initial = parsed.type === 'message_start' ? parsed.message?.usage : null;
      if (Number.isSafeInteger(initial?.input_tokens) && initial.input_tokens >= 0) anthropicInputTokens = initial.input_tokens;
      const partial = parsed.usage || initial;
      const usage = responseUsage({ usage: { input_tokens: partial?.input_tokens ?? anthropicInputTokens, output_tokens: partial?.output_tokens } }, protocol);
      if (usage) onUsage(usage);
    } else {
      const usage = responseUsage(parsed, protocol);
      if (usage) onUsage(usage);
    }
    if (parsed.type === 'message_stop' || parsed.choices?.[0]?.finish_reason) ended = true;
    const content = protocol === 'anthropic'
      ? (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' ? parsed.delta.text : '')
      : parsed.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content) {
      fullContent += content;
      if (fullContent.length > 2 * 1024 * 1024) throw new Error('模型回复超出大小限制');
      onChunk(content);
    }
  };
  try {
    for await (const chunk of readable) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (buffer.length > 2 * 1024 * 1024) throw new Error('模型流数据超出大小限制');
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const event of events) processEvent(event);
    }
    buffer += decoder.end();
    if (buffer.trim()) processEvent(buffer);
    if (!fullContent.trim()) throw new Error('模型返回空内容');
    if (!ended) throw new Error('模型连接提前中断');
    return fullContent;
  } catch (error) {
    error.partialContent = fullContent;
    throw error;
  }
}

export async function requestCompletionStream(config, messages, options = {}) {
  const body = buildRequestBody(config, messages, { ...options, stream: true });
  const safe = await getSafeAiRequestOptions(config.endpoint);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), options.timeout || 120000);
  // Measures actual content, not merely a provider heartbeat or headers.
  const firstTimer = setTimeout(() => controller.abort(), options.firstTokenTimeout || 45000);
  try {
    // Callers with revocable source data recheck after URL resolution and all
    // other async preparation, immediately before initiating the HTTP effect.
    if (options.beforeDispatch && !(await options.beforeDispatch())) {
      throw Object.assign(new Error('模型输入来源已撤销'), { status: 409 });
    }
    if (controller.signal.aborted) {
      throw Object.assign(new Error('模型调用已取消'), { status: 409 });
    }
    const response = await axios.post(config.endpoint, body, {
      ...safe, headers: providerHeaders(config), responseType: 'stream', signal: controller.signal,
      timeout: options.timeout || 120000
    });
    return await consumeSSE(response.data, config.protocol, chunk => {
      clearTimeout(firstTimer); options.onChunk?.(chunk);
    }, usage => options.onUsage?.(usage));
  } finally {
    clearTimeout(totalTimer); clearTimeout(firstTimer);
    options.signal?.removeEventListener('abort', abort);
  }
}
