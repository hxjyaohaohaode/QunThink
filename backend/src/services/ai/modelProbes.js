import { createHash } from 'node:crypto';
import axios from 'axios';
import sharp from 'sharp';
import { z } from 'zod';
import { getUserDb, withWriteLock, beginUserDbWriteBarrier } from '../../models/db.js';
import { catalogError, getCatalogData, resolveModelSnapshot } from './catalog.js';
import { requestCompletion, providerHeaders } from './transport.js';
import { getSafeAiRequestOptions } from '../../utils/safeExternalUrl.js';
import { isPcmWav } from './audioValidation.js';

// No eviction: forgetting an ID or an unknown effect would reopen paid dispatch.
// A full ledger needs an audited migration/reconciliation, never an automatic reset.
export const MODEL_PROBE_LIMITS = Object.freeze({ effects: 2000, identities: 10000, perMinute: 10, perDay: 100, running: 2, deadlineMs: 60000 });
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const requestSchema = z.object({
  clientRequestId: uuid,
  modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  capability: z.enum(['chat', 'vision', 'tts']).default('chat'),
  expectedRevision: z.number().int().nonnegative().optional()
});
const reasons = {
  PROBE_UNKNOWN: '测试请求可能已执行或计费，但结果无法确认；请先核对服务商记录，不要重新发起测试',
  PROBE_FAILED: '服务商已返回，但本次能力测试未通过；该能力仍未验证',
  PROBE_REJECTED: '服务商拒绝了测试请求，请检查凭据、模型、参数或额度；该能力仍未验证',
  PROBE_NOT_SENT: '测试在发送前停止，该能力仍未验证',
  PROBE_STALE: '模型配置已变化，本次测试不能验证当前配置',
  PROBE_CONFIG_CHANGED: '配置版本已改变，本请求未发出新的测试调用；请刷新配置后重新确认',
  PROBE_STORAGE_UNCERTAIN: '测试记录暂时无法可靠保存或读取；请查询原请求，不要重新发起测试'
};
const effectSchema = z.object({
  id: uuid, requests: z.array(z.object({
    id: uuid, expectedRevision: z.number().int().nonnegative().optional()
  }).strict()).min(1).max(MODEL_PROBE_LIMITS.identities),
  modelId: requestSchema.shape.modelId, capability: z.enum(['chat', 'vision', 'tts']),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  status: z.enum(['running', 'succeeded', 'failed', 'unknown']),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), deadlineAt: z.number().int().nonnegative(),
  dispatches: z.number().int().min(0).max(2), receipts: z.number().int().min(0).max(2),
  responseTime: z.number().int().nonnegative().optional(),
  code: z.enum(Object.keys(reasons)).optional()
}).strict();
const ledgerSchema = z.object({ version: z.literal(1), effects: z.array(effectSchema).max(MODEL_PROBE_LIMITS.effects) }).strict();

function storageError() {
  return Object.assign(catalogError(reasons.PROBE_STORAGE_UNCERTAIN, 503), {
    code: 'PROBE_STORAGE_UNCERTAIN', statusCode: 503, isOperational: true
  });
}
function probeError(code, status) { return Object.assign(catalogError(reasons[code], status), { code }); }

export function parseModelProbeRequest(body, header) {
  // An explicit bad/mismatching key must not silently fall back to another key.
  const headerId = header === undefined ? undefined : uuid.parse(header);
  const bodyId = body?.clientRequestId === undefined ? undefined : uuid.parse(body.clientRequestId);
  if (headerId && bodyId && headerId !== bodyId) throw catalogError('请求头和请求体的测试请求号不一致', 400);
  return requestSchema.parse({ ...body, clientRequestId: headerId || bodyId });
}

function ledger(data) {
  if (data.modelProbeLedger === undefined) return { version: 1, effects: [] };
  const parsed = ledgerSchema.safeParse(data.modelProbeLedger);
  if (!parsed.success) throw storageError();
  const effects = parsed.data.effects;
  const identities = effects.flatMap(effect => effect.requests.map(request => request.id));
  if (identities.length > MODEL_PROBE_LIMITS.identities || new Set(identities).size !== identities.length ||
      effects.some(effect => !effect.requests.some(request => request.id === effect.id) || effect.receipts > effect.dispatches)) throw storageError();
  return parsed.data;
}
function configuration(data, effect) {
  const catalog = getCatalogData(data);
  const model = catalog.models.find(model => model.id === effect.modelId);
  const provider = catalog.providers.find(provider => provider.id === model?.providerId);
  let matches = false;
  try {
    // Also check current connection readiness (e.g. keyRequired was enabled),
    // not just whether old credentials still produce the same fingerprint.
    matches = resolveModelSnapshot(data, effect.modelId, effect.capability, { allowUnverified: true })
      .capabilityFingerprint === effect.fingerprint;
  } catch (error) {
    if (![400, 404, 409].includes(error.status)) throw error;
  }
  return { matches, revisionMatches: matches && catalog.revision === effect.revision, provider };
}
function checkFor(data, effect) { return data.modelCapabilityChecks?.[effect.modelId]?.[effect.capability]; }
function ownsCheck(data, effect) {
  const check = checkFor(data, effect);
  return check?.probeRequestId === effect.id && check.fingerprint === effect.fingerprint;
}
function publicEffect(data, effect, replayed = false) {
  const current = configuration(data, effect);
  const check = checkFor(data, effect);
  const stale = !current.matches || effect.code === 'PROBE_STALE' ||
    (effect.status === 'succeeded' && (!ownsCheck(data, effect) || check?.status !== 'verified'));
  return {
    requestId: effect.id, modelId: effect.modelId, capability: effect.capability, status: effect.status,
    healthy: effect.status === 'succeeded' && !stale && check?.status === 'verified' && ownsCheck(data, effect),
    stale, possibleCharge: effect.dispatches > 0, replayed,
    ...(effect.responseTime === undefined ? {} : { responseTime: effect.responseTime }),
    ...(effect.code ? { code: effect.code, error: reasons[effect.code] } : {})
  };
}
async function persist(db, before) {
  const releaseReaders = beginUserDbWriteBarrier(db);
  try { await db.write(); }
  catch {
    // A failed write may have committed without acknowledgement. Do not let
    // mutated cached success or an unpersisted claim authorize another effect.
    db.data = before;
    db.invalidateReadCache?.();
    // Retain the shared DB instance: callers already queued on the account
    // lock may hold it. Cache eviction would strand them with a stale snapshot.
    // Invalidate ordinary readers too: the restored snapshot may contain an
    // older verified check while an unacknowledged claim revoked it on disk.
    throw storageError();
  } finally { releaseReaders(); }
}
async function locked(userId, fn) {
  return withWriteLock(userId, async () => {
    let db;
    try { db = await getUserDb(userId); await db.read({ force: true }); }
    catch { throw storageError(); }
    return fn(db);
  });
}
function expire(data, effects) {
  let changed = false;
  for (const effect of effects) {
    if (effect.status !== 'running' || effect.deadlineAt > Date.now()) continue;
    effect.status = effect.dispatches ? 'unknown' : 'failed';
    effect.code = effect.dispatches ? 'PROBE_UNKNOWN' : 'PROBE_NOT_SENT';
    effect.updatedAt = Date.now();
    if (ownsCheck(data, effect)) Object.assign(checkFor(data, effect), { status: 'unknown', evidence: null });
    changed = true;
  }
  return changed;
}

async function claim(userId, input) {
  return locked(userId, async db => {
    const before = structuredClone(db.data), state = ledger(db.data);
    const expired = expire(db.data, state.effects);
    const prior = state.effects.find(effect => effect.requests.some(request => request.id === input.clientRequestId));
    if (prior) {
      const binding = prior.requests.find(request => request.id === input.clientRequestId);
      if (prior.modelId !== input.modelId || prior.capability !== input.capability ||
          binding.expectedRevision !== input.expectedRevision) {
        throw catalogError('测试请求号已用于不同模型、能力或配置版本条件', 409);
      }
      if (expired) { db.data.modelProbeLedger = state; await persist(db, before); }
      return { response: publicEffect(db.data, prior, true) };
    }
    if (input.expectedRevision !== undefined && getCatalogData(db.data).revision !== input.expectedRevision) {
      // Rejected before admission or any provider request. Existing IDs were
      // resolved above, so an admitted but uncertain effect cannot be hidden.
      return { response: { requestId: input.clientRequestId, modelId: input.modelId, capability: input.capability,
        status: 'failed', healthy: false, stale: true, possibleCharge: false, replayed: false,
        code: 'PROBE_CONFIG_CHANGED', error: reasons.PROBE_CONFIG_CHANGED } };
    }
    const config = resolveModelSnapshot(db.data, input.modelId, input.capability, { allowUnverified: true });
    const inputHash = createHash('sha256').update(JSON.stringify([
      'synthetic-capability-probe-v1', input.modelId, input.capability, config.capabilityFingerprint, config.temperature
    ])).digest('hex');
    const unresolved = state.effects.find(effect => effect.inputHash === inputHash && ['running', 'unknown'].includes(effect.status));
    if (state.effects.reduce((total, effect) => total + effect.requests.length, 0) >= MODEL_PROBE_LIMITS.identities) {
      throw catalogError('测试请求记录已达安全容量，请联系管理员核验；不会清除旧请求号后重新调用', 429);
    }
    if (unresolved) {
      // Remember aliases as well: a delayed retry of this fresh UUID after
      // completion must still replay, not become a second paid intent.
      unresolved.requests.push({ id: input.clientRequestId, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) });
      db.data.modelProbeLedger = state;
      await persist(db, before);
      return { response: publicEffect(db.data, unresolved, true) };
    }
    const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
    if (state.effects.length >= MODEL_PROBE_LIMITS.effects ||
        state.effects.filter(effect => effect.createdAt >= now - 60000).length >= MODEL_PROBE_LIMITS.perMinute ||
        state.effects.filter(effect => new Date(effect.createdAt).toISOString().slice(0, 10) === day).length >= MODEL_PROBE_LIMITS.perDay ||
        state.effects.filter(effect => effect.status === 'running').length >= MODEL_PROBE_LIMITS.running) {
      throw catalogError('已达到安全测试次数、并发或记录容量限制，请先核验已有请求', 429);
    }
    const effect = {
      id: input.clientRequestId, requests: [{ id: input.clientRequestId, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) }], modelId: input.modelId, capability: input.capability,
      fingerprint: config.capabilityFingerprint, inputHash, revision: config.catalogRevision,
      status: 'running', createdAt: now, updatedAt: now, deadlineAt: now + MODEL_PROBE_LIMITS.deadlineMs,
      dispatches: 0, receipts: 0
    };
    if (!configuration(db.data, effect).revisionMatches) throw probeError('PROBE_STALE', 409);
    state.effects.push(effect); db.data.modelProbeLedger = state;
    db.data.modelCapabilityChecks ||= {};
    db.data.modelCapabilityChecks[effect.modelId] ||= {};
    // Previous verification is suspended before any new paid probe, so failed
    // probes and crash recovery cannot leave an old success looking current.
    db.data.modelCapabilityChecks[effect.modelId][effect.capability] = {
      status: 'unknown', fingerprint: effect.fingerprint, probeRequestId: effect.id,
      checkedAt: new Date(now).toISOString(), evidence: null
    };
    await persist(db, before);
    return { effect, config };
  });
}

export async function getModelProbe(userId, requestId) {
  requestId = uuid.parse(requestId);
  return locked(userId, async db => {
    const before = structuredClone(db.data), state = ledger(db.data);
    const changed = expire(db.data, state.effects);
    const effect = state.effects.find(effect => effect.requests.some(request => request.id === requestId));
    if (changed) { db.data.modelProbeLedger = state; await persist(db, before); }
    if (!effect) throw catalogError('测试请求不存在', 404);
    return publicEffect(db.data, effect);
  });
}

async function dispatch(userId, effect, progress, signal, send) {
  return locked(userId, async db => {
    const before = structuredClone(db.data), state = ledger(db.data);
    const current = state.effects.find(item => item.id === effect.id);
    if (!current || current.status !== 'running' || signal.aborted || Date.now() >= current.deadlineAt) {
      throw probeError('PROBE_UNKNOWN', 409);
    }
    if (!configuration(db.data, effect).revisionMatches || !ownsCheck(db.data, effect)) throw probeError('PROBE_STALE', 409);
    if (current.dispatches >= (effect.capability === 'vision' ? 2 : 1)) throw probeError('PROBE_UNKNOWN', 409);
    current.dispatches++; current.receipts = progress.receipts; current.updatedAt = Date.now();
    db.data.modelProbeLedger = state;
    // The durable intent must precede axios. No CAS/write retry may resend it.
    await persist(db, before);
    progress.dispatches = current.dispatches;
    return { responsePromise: send() };
  });
}

async function complete(userId, effect, progress, result) {
  return locked(userId, async db => {
    const before = structuredClone(db.data), state = ledger(db.data);
    const current = state.effects.find(item => item.id === effect.id);
    if (!current) throw storageError();
    // Once recovery declared the outcome unknown, late responses cannot turn
    // it into success or allow automatic retry. No provider receipt API exists.
    if (current.status !== 'running') return publicEffect(db.data, current);
    const same = configuration(db.data, effect);
    const late = Date.now() >= current.deadlineAt;
    current.status = late ? (current.dispatches ? 'unknown' : 'failed') : result.status;
    current.code = late ? (current.dispatches ? 'PROBE_UNKNOWN' : 'PROBE_NOT_SENT') : result.code;
    if (current.status === 'succeeded' && (!same.revisionMatches || !ownsCheck(db.data, effect))) {
      current.status = 'failed'; current.code = 'PROBE_STALE';
    }
    if (current.code === undefined) delete current.code;
    current.receipts = progress.receipts; current.updatedAt = Date.now();
    current.responseTime = Math.max(0, current.updatedAt - current.createdAt);
    if (same.matches && ownsCheck(db.data, effect)) {
      const verified = current.status === 'succeeded';
      Object.assign(checkFor(db.data, effect), {
        status: verified ? 'verified' : 'unknown', checkedAt: new Date(current.updatedAt).toISOString(),
        evidence: verified ? { protocol: same.provider.protocol, responseTime: current.responseTime } : null
      });
    }
    db.data.modelProbeLedger = state;
    await persist(db, before);
    return publicEffect(db.data, current);
  });
}

async function probeTts(config, options, progress) {
  if (config.protocol !== 'openai') throw probeError('PROBE_NOT_SENT', 400);
  const chatAudio = config.ttsMode === 'chat-audio';
  const endpoint = chatAudio ? config.endpoint : `${config.baseUrl}/audio/speech`;
  const safe = await getSafeAiRequestOptions(endpoint);
  const body = chatAudio ? {
    model: config.model, modalities: ['text', 'audio'], audio: { voice: config.ttsVoice || 'mimo_default', format: 'wav' },
    messages: [{ role: 'user', content: '请把“你好”转换成短语音。' }], stream: false
  } : { model: config.model, input: '你好', voice: config.ttsVoice || 'alloy', response_format: 'wav' };
  const { responsePromise } = await options.dispatchGate(() => axios.post(endpoint, body, {
    ...safe, headers: providerHeaders(config), timeout: 20000, signal: options.signal,
    ...(!chatAudio ? { responseType: 'arraybuffer' } : {}), maxContentLength: 1024 * 1024
  }));
  const response = await responsePromise;
  progress.receipts++;
  if (chatAudio) {
    const audio = response.data?.choices?.[0]?.message?.audio?.data;
    if (typeof audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) ||
        Buffer.from(audio, 'base64').toString('base64') !== audio || !isPcmWav(Buffer.from(audio, 'base64'))) throw probeError('PROBE_FAILED', 502);
  } else if (!/^(audio\/|application\/octet-stream)/i.test(response.headers?.['content-type'] || '') ||
      !isPcmWav(response.data)) throw probeError('PROBE_FAILED', 502);
}

async function probeVision(config, options) {
  const samples = Math.random() < 0.5 ? ['red', 'blue'] : ['blue', 'red'];
  for (const color of samples) {
    const png = await sharp({ create: { width: 24, height: 24, channels: 3,
      background: color === 'red' ? { r: 255, g: 0, b: 0 } : { r: 0, g: 0, b: 255 }
    } }).png().toBuffer();
    const answer = await requestCompletion(config, [{ role: 'user', content: [
      { type: 'text', text: '请识别这张纯色图片的主色。只回答红色或蓝色；无法识别时回答无法识别。' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
    ] }], options);
    const red = /红色|\bred\b/i.test(answer), blue = /蓝色|\bblue\b/i.test(answer);
    if ((color === 'red' && (!red || blue)) || (color === 'blue' && (!blue || red))) throw probeError('PROBE_FAILED', 502);
  }
}

export async function runModelProbe(userId, input) {
  const claimed = await claim(userId, input);
  if (claimed.response) return claimed.response;
  const { effect, config } = claimed;
  const progress = { dispatches: 0, receipts: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, effect.deadlineAt - Date.now()));
  timer.unref?.();
  const options = {
    maxTokens: 32, timeout: 20000, signal: controller.signal,
    dispatchGate: send => dispatch(userId, effect, progress, controller.signal, send),
    onUsage: () => { progress.receipts++; }
  };
  let result = { status: 'succeeded' };
  try {
    if (input.capability === 'tts') await probeTts(config, options, progress);
    else if (input.capability === 'vision') await probeVision(config, options);
    else await requestCompletion(config, [{ role: 'user', content: '请回复 OK' }], options);
  } catch (error) {
    // Timeouts/disconnects/5xx/408 and malformed responses may conceal a paid
    // success. A received 4xx rejection (except timeout) is a known failure.
    const rejected = error?.response?.status >= 400 && error.response.status < 500 && error.response.status !== 408;
    const unknown = progress.dispatches > progress.receipts && !rejected;
    result = { status: unknown ? 'unknown' : 'failed', code: unknown ? 'PROBE_UNKNOWN'
      : error.code === 'PROBE_STALE' ? 'PROBE_STALE'
        : rejected ? 'PROBE_REJECTED' : progress.dispatches ? 'PROBE_FAILED' : 'PROBE_NOT_SENT' };
  } finally { clearTimeout(timer); }
  try { return await complete(userId, effect, progress, result); }
  catch {
    // Do not dispatch again, and do not claim failed/succeeded without a durable
    // receipt. Fresh status reads can recover a commit whose ACK was lost.
    return { requestId: effect.id, modelId: effect.modelId, capability: effect.capability,
      status: 'unknown', healthy: false, stale: false, possibleCharge: progress.dispatches > 0,
      replayed: false, code: 'PROBE_STORAGE_UNCERTAIN', error: reasons.PROBE_STORAGE_UNCERTAIN };
  }
}

export function modelProbeHttpStatus(effect) {
  if (effect.status === 'running' || effect.status === 'unknown') return 202;
  if (effect.status === 'failed') return ['PROBE_STALE', 'PROBE_CONFIG_CHANGED'].includes(effect.code) ? 409 : 502;
  return 200;
}
