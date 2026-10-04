import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import axios from 'axios';
import { getDataDir, withWriteLock, clearUserDbCache } from '../models/db.js';
import { validateBody, ttsSchema } from '../validators/index.js';
import { defaultModelId, resolveModel } from '../services/ai/catalog.js';
import { getSafeAiRequestOptions } from '../utils/safeExternalUrl.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { hasAudioContainer } from '../services/ai/audioValidation.js';
import { revokeTtsForMessages, drainTtsPendingDeletes } from '../services/ttsDeletion.js';
import { readableSourceMessages } from '../services/memory/persistentMemory.js';

const router = express.Router();
const AUDIO_MIME_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4'
};

const TTS_VOICES = [
  { id: 'mimo_default', name: '模型音色', desc: '使用模型中心配置且已测试的音色', gender: 'unknown', tone: 'default' }
];

const TTS_TONES = [
  { id: 'normal', name: '默认语调', desc: '使用已验证模型的默认语调', speed: 1.0, pitch: 1.0, emotion: 'neutral' }
];

const TTS_DAILY_QUOTA = 50;
const ORPHAN_TTS_TTL_MS = 24 * 60 * 60 * 1000;

function synthesisHash(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

async function readableTtsMessages(userId, db) {
  return (await readableSourceMessages(userId, db)).filter(message =>
    db.data.groups?.some(group => group.id === message.group_id));
}

function hasAccessibleAudio(data, audioUrl, readableMessages) {
  const filename = path.basename(audioUrl || '');
  const record = data.ttsAudioFiles?.find(audio => audio.filename === filename);
  if (!record) return false;
  return record.messageId
    ? readableMessages.some(message => message.id === record.messageId &&
      message.metadata?.tts?.audioUrl === `/api/tts/audio/${filename}`)
    : Number.isSafeInteger(record.createdAt) && Date.now() - record.createdAt < ORPHAN_TTS_TTL_MS;
}

async function claimSynthesis(req, hash, modelId, messageId, sourceSnapshot) {
  const db = await req.getUserDb();
  return withWriteLock(req.userId, async () => {
    await db.read();
    if (messageId) {
      const source = (await readableTtsMessages(req.userId, db)).find(message => message.id === messageId);
      if (!source || !sameSource(source, sourceSnapshot)) return { sourceUnavailable: true };
    }
    db.data.ttsEffects ||= [];
    const prior = db.data.ttsEffects.find(effect => effect.id === req.body.clientRequestId);
    if (prior && prior.requestHash !== hash) return { conflict: true };
    // A new browser session may have lost its UUID. Reuse unresolved work
    // with the same input, even when the caller supplied a fresh UUID.
    const unresolved = prior || [...db.data.ttsEffects].reverse().find(effect =>
      effect.requestHash === hash && ['running', 'unknown'].includes(effect.status));
    if (unresolved) {
      if (unresolved.status === 'running' && Date.now() - unresolved.createdAt > 120000) {
        unresolved.status = 'unknown';
        unresolved.updatedAt = Date.now();
        await db.write();
      }
      return { replay: structuredClone(unresolved) };
    }
    if (!modelId) return { missing: true };
    const day = new Date().toISOString().slice(0, 10);
    if (db.data.ttsEffects.filter(effect => effect.day === day).length >= TTS_DAILY_QUOTA) {
      return { quotaExceeded: true };
    }
    db.data.ttsEffects.push({
      id: req.body.clientRequestId, requestHash: hash, status: 'running',
      modelId, day, createdAt: Date.now(), updatedAt: Date.now(), response: null
    });
    await db.write();
    return { claimed: true };
  });
}

function sameSource(message, snapshot) {
  return snapshot && message.content === snapshot.content &&
    message.group_id === snapshot.groupId &&
    (message.revision || null) === snapshot.revision &&
    (message.edited_at || null) === snapshot.editedAt &&
    (message.metadata?.tts?.audioUrl || null) === snapshot.audioUrl;
}

async function markSynthesisUnknown(req, reason) {
  const db = await req.getUserDb();
  await withWriteLock(req.userId, async () => {
    await db.read();
    const effect = db.data.ttsEffects?.find(item => item.id === req.body.clientRequestId);
    if (!effect) return;
    // A write may commit and then lose its acknowledgement. The caller has
    // already removed the audio file, so an observed success receipt cannot
    // remain visible with a missing artifact.
    if (effect.status === 'succeeded' && effect.response?.audio_url) {
      const audioUrl = effect.response.audio_url;
      const filename = path.basename(audioUrl);
      const record = db.data.ttsAudioFiles?.find(audio => audio.filename === filename);
      if (record?.messageId) {
        const message = db.data.messages?.find(entry => entry.id === record.messageId);
        if (message?.metadata?.tts?.audioUrl === audioUrl) {
          const nextMetadata = { ...message.metadata };
          delete nextMetadata.tts;
          message.metadata = nextMetadata;
        }
      }
      db.data.ttsAudioFiles = (db.data.ttsAudioFiles || []).filter(audio => audio.filename !== filename);
      db.data.ttsPendingDeletes = [...new Set([...(db.data.ttsPendingDeletes || []), filename])];
    }
    effect.status = 'unknown';
    effect.response = null;
    effect.reason = reason;
    effect.updatedAt = Date.now();
    try { await db.write(); }
    catch {
      clearUserDbCache(req.userId);
      throw Object.assign(new Error('语音效果记录写入结果不确定，请刷新后核验'), {
        code: 'TTS_STATE_UNCERTAIN', statusCode: 503, isOperational: true
      });
    }
  });
}

function scheduleOrphanTtsCleanup(audioPath) {
  const timer = setTimeout(() => {
    fs.unlink(audioPath).catch(() => { });
  }, ORPHAN_TTS_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

const ttsDir = path.join(getDataDir(), 'tts');

async function ensureTtsDir() {
  try {
    await fs.access(ttsDir);
  } catch {
    await fs.mkdir(ttsDir, { recursive: true });
  }
}

ensureTtsDir();

router.get('/voices', (req, res) => {
  res.json({ voices: TTS_VOICES, tones: TTS_TONES });
});

router.post('/synthesize', validateBody(ttsSchema), asyncHandler(async (req, res) => {
  const { text, voice, tone, messageId } = req.body;
  let sourceSnapshot = null;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '文本内容不能为空' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: '文本内容不能超过5000字符' });
  }
  const speechText = sanitizeTtsText(text);

  if (!speechText) {
    return res.status(400).json({ error: '文本内容不能为空' });
  }
  if (messageId) {
    const db = await req.getUserDb();
    sourceSnapshot = await withWriteLock(req.userId, async () => {
      await db.read();
      const source = (await readableTtsMessages(req.userId, db)).find(message => message.id === messageId);
      return source ? { content: source.content, groupId: source.group_id,
        revision: source.revision || null, editedAt: source.edited_at || null,
        audioUrl: source.metadata?.tts?.audioUrl || null } : null;
    });
    if (!sourceSnapshot) return res.status(404).json({ error: '关联消息不存在或无权访问' });
  }
  const voiceConfig = voice ? TTS_VOICES.find(entry => entry.id === voice) : TTS_VOICES[0];
  const toneConfig = tone ? TTS_TONES.find(entry => entry.id === tone) : TTS_TONES[0];
  if (!voiceConfig || !toneConfig) return res.status(400).json({ error: '所选音色或语调未通过当前配置验证' });
  const hash = synthesisHash({ speechText, voice: voiceConfig.id, tone: toneConfig.id, messageId: messageId || null });
  let claim = await claimSynthesis(req, hash, null, messageId, sourceSnapshot);
  let modelId;
  let config;
  if (claim.missing) {
    modelId = await defaultModelId(req.userId, 'tts');
    config = await resolveModel(req.userId, modelId, 'tts');
    if (config.protocol !== 'openai') throw Object.assign(new Error('所选服务商协议不支持语音合成'), { status: 400 });
    claim = await claimSynthesis(req, hash, modelId, messageId, sourceSnapshot);
  }
  if (claim.sourceUnavailable) return res.status(410).json({ error: '关联消息已撤回或修订' });
  if (claim.conflict) return res.status(409).json({ error: '幂等键已用于不同的语音请求' });
  if (claim.quotaExceeded) return res.status(429).json({ error: '今日语音合成次数已达上限，请明天再试' });
  if (claim.replay) {
    if (claim.replay.status === 'succeeded') {
      const db = await req.getUserDb();
      const accessible = await withWriteLock(req.userId, async () => {
        await db.read();
        return hasAccessibleAudio(db.data, claim.replay.response?.audio_url,
          await readableTtsMessages(req.userId, db));
      });
      if (!accessible) {
        return res.status(410).json({ error: '该次语音已被删除，不会重复合成' });
      }
      return res.json(claim.replay.response);
    }
    return res.status(202).json({ success: false, status: claim.replay.status,
      requestId: claim.replay.id, possibleCharge: true,
      error: '服务商结果尚未核验；同一请求不会自动再次调用' });
  }
  const audioId = `tts_${messageId || Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  let audioPath = null;
  try {
    const audioResult = await callMiMoTTS(speechText, voiceConfig.id, toneConfig, config);
    if (!audioResult?.buffer?.length) throw new Error('未收到有效的音频数据');
    const audioFormat = normalizeAudioFormat(audioResult.format);
    if (!hasAudioContainer(audioResult.buffer, audioFormat)) {
      throw new Error('语音服务返回了损坏或格式不符的音频');
    }
    const audioFilename = `${audioId}.${audioFormat}`;
    audioPath = path.join(ttsDir, audioFilename);
    await fs.writeFile(audioPath, audioResult.buffer);
    const duration = estimateDuration(speechText, toneConfig.speed);
    const audioUrl = buildAudioUrl(audioId, audioFormat);
    const ttsMetadata = {
      id: audioId, audioUrl, duration, voiceId: voiceConfig.id, toneId: toneConfig.id,
      createdAt: new Date().toISOString(), transcript: speechText,
      format: audioFormat, provider: audioResult.provider || config.providerId
    };
    const response = { success: true, audio_id: audioId, audio_url: audioUrl, duration,
      voice: voiceConfig, tone: toneConfig, transcript: speechText,
      format: audioFormat, requestId: req.body.clientRequestId };
    const attached = await persistTtsMetadata(req, messageId, sourceSnapshot, ttsMetadata, audioFilename, response);
    if (messageId && !attached) throw new Error('SOURCE_CHANGED_DURING_SYNTHESIS');
    if (!messageId) scheduleOrphanTtsCleanup(audioPath);
    return res.json(response);
  } catch (error) {
    if (audioPath) await fs.unlink(audioPath).catch(() => {});
    console.warn('[TTS] 合成结果待核验', {
      requestId: req.body.clientRequestId, modelId,
      failureCode: error?.code || (error?.response?.status ? `HTTP_${error.response.status}` : 'UNCLASSIFIED')
    });
    await markSynthesisUnknown(req, error?.message === 'SOURCE_CHANGED_DURING_SYNTHESIS'
      ? 'SOURCE_CHANGED_DURING_SYNTHESIS' : 'PROVIDER_OR_STORAGE_RESULT_UNCERTAIN');
    return res.status(202).json({ success: false, status: 'unknown', requestId: req.body.clientRequestId,
      possibleCharge: true, error: '语音结果未知或无可用成果，可能已产生服务商费用；请先核验，不要新建请求盲目重试' });
  }
}));

router.get('/effects/:requestId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const result = await withWriteLock(req.userId, async () => {
    await db.read();
    const effect = db.data.ttsEffects?.find(item => item.id === req.params.requestId);
    if (!effect) return null;
    const accessible = effect.status === 'succeeded' && hasAccessibleAudio(db.data,
      effect.response?.audio_url, await readableTtsMessages(req.userId, db));
    return { effect: structuredClone(effect), accessible };
  });
  const effect = result?.effect;
  if (!effect) return res.status(404).json({ error: '合成请求不存在' });
  const accessible = result.accessible;
  const status = effect.status === 'succeeded' && !accessible ? 'deleted' : effect.status;
  res.set('Cache-Control', 'no-store').json({ requestId: effect.id, status,
    modelId: effect.modelId, possibleCharge: true,
    response: accessible ? effect.response : null });
}));

router.get('/messages/:messageId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const audio = await withWriteLock(req.userId, async () => {
    await db.read();
    const message = (await readableTtsMessages(req.userId, db))
      .find(entry => entry.id === req.params.messageId);
    return message?.metadata?.tts ? structuredClone(message.metadata.tts) : null;
  });
  if (!audio) {
    return res.status(404).json({ error: '未找到语音数据' });
  }

  return res.set('Cache-Control', 'no-store').json({
    success: true,
    audio
  });
}));

router.delete('/messages/:messageId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  const outcome = await withWriteLock(req.userId, async () => {
    // Revoke the authoritative ownership before attempting the filesystem
    // effect. A failed unlink leaves an inaccessible file for cleanup.
    await db.read();
    const message = (await readableTtsMessages(req.userId, db))
      .find(entry => entry.id === req.params.messageId);
    if (!message) return { status: 404, error: '消息不存在' };
    const audioUrl = message.metadata?.tts?.audioUrl;
    if (!audioUrl) return { status: 404, error: '该消息没有可删除的语音' };
    const filename = path.basename(audioUrl);
    const registered = db.data.ttsAudioFiles?.some(audio => audio.filename === filename && audio.messageId === message.id);
    const legacy = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(message.id) &&
      filename.startsWith(`tts_${message.id}_`) &&
      /^tts_[\da-f-]{36}_[a-z0-9]{8}\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(filename) &&
      audioUrl === `/api/tts/audio/${filename}`;
    if (!registered && !legacy) return { status: 409, error: '音频归属尚未核验，请勿删除其他文件' };
    const previousMetadata = message.metadata;
    const previousAudio = db.data.ttsAudioFiles;
    const previousPending = db.data.ttsPendingDeletes;
    revokeTtsForMessages(db.data, [message.id]);
    const nextMetadata = { ...(message.metadata || {}) };
    delete nextMetadata.tts;
    message.metadata = nextMetadata;
    try { await db.write(); }
    catch (error) {
      message.metadata = previousMetadata;
      db.data.ttsAudioFiles = previousAudio;
      db.data.ttsPendingDeletes = previousPending;
      throw error;
    }
    return { filename };
  });
  if (!outcome.filename) return res.status(outcome.status).json({ error: outcome.error });
  const pending = await drainTtsPendingDeletes(req.userId);
  return res.json({ success: true, fileDeletionPending: pending > 0 });
}));

async function callMiMoTTS(text, voice, toneConfig, config) {
  const apiKey = config.apiKey;
  const endpoint = config.ttsMode === 'chat-audio' ? config.endpoint : config.baseUrl + '/audio/speech';
  const externalRequestOptions = await getSafeAiRequestOptions(endpoint);
  if (config.ttsMode !== 'chat-audio') {
    const response = await axios.post(endpoint, {
      model: config.model, input: text, voice: voice === 'mimo_default' ? (config.ttsVoice || 'alloy') : voice,
      response_format: 'wav', speed: toneConfig?.speed || 1
    }, { ...externalRequestOptions, headers: { Authorization: 'Bearer ' + apiKey }, responseType: 'arraybuffer', timeout: 90000, maxContentLength: 20 * 1024 * 1024 });
    const type = response.headers['content-type'] || '';
    if (!type.startsWith('audio/') && !type.includes('octet-stream')) throw new Error('语音服务未返回音频');
    return buildAudioResult(Buffer.from(response.data).toString('base64'), 'wav', config.model);
  }

  // A timeout may mean the provider completed and charged for synthesis. Do not
  // retry without a provider-supported idempotency key and reconciliation path.
      const chatResponse = await axios.post(
        endpoint,
        {
          model: config.model,
          modalities: ['text', 'audio'],
          audio: {
            voice: voice === 'mimo_default' ? (config.ttsVoice || 'mimo_default') : voice,
            format: 'wav'
          },
          messages: [
            {
              role: 'user',
              content: buildTonePrompt(toneConfig)
            },
            {
              role: 'assistant',
              content: text
            }
          ],
          stream: false
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, audio/wav, audio/mpeg, audio/ogg, application/octet-stream'
          },
          timeout: 90000,
          ...externalRequestOptions
        }
      );

      const directChoiceAudio = chatResponse.data?.choices?.[0]?.message?.audio;
      if (directChoiceAudio?.data) {
        const directAudio = buildAudioResult(
          directChoiceAudio.data,
          directChoiceAudio.format || directChoiceAudio.mime_type || 'wav',
          config.model
        );
        if (directAudio) {
          return directAudio;
        }
      }

      const completionAudio = extractAudioPayload(chatResponse.data, chatResponse.headers);
      if (completionAudio) {
        return { ...completionAudio, provider: config.model };
      }

      const fallbackText = chatResponse.data?.choices?.[0]?.message?.content;
      if (typeof fallbackText === 'string' && fallbackText.trim()) {
        throw new Error(`API返回了文本而非音频: ${fallbackText.substring(0, 100)}`);
      }

      throw new Error('语音服务响应中未找到可播放的音频数据');
}

function buildTonePrompt() {
  return '请将下一条 assistant 消息自然、清晰地转成语音。';
}

function sanitizeTtsText(input) {
  if (typeof input !== 'string') return '';

  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[#>*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAudioUrl(audioId, format) {
  return `/api/tts/audio/${audioId}.${normalizeAudioFormat(format)}`;
}

function normalizeAudioFormat(format) {
  const normalized = String(format || 'wav')
    .toLowerCase()
    .replace(/^audio\//, '')
    .replace(/^x-/, '')
    .trim();

  if (normalized === 'mpeg') return 'mp3';
  if (normalized === 'mp4') return 'm4a';
  if (normalized in AUDIO_MIME_TYPES) return normalized;
  return 'wav';
}

function getMimeType(format) {
  return AUDIO_MIME_TYPES[normalizeAudioFormat(format)] || AUDIO_MIME_TYPES.wav;
}

function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(entry => Number.isInteger(entry))) {
    return Buffer.from(value);
  }
  return null;
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function looksLikeBase64Audio(raw) {
  if (typeof raw !== 'string') return false;
  const compact = raw.replace(/\s+/g, '');
  return compact.length > 128 && compact.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(compact);
}

function buildAudioResult(base64Data, format, provider = null) {
  if (!looksLikeBase64Audio(base64Data)) {
    return null;
  }

  return {
    buffer: Buffer.from(base64Data, 'base64'),
    format: normalizeAudioFormat(format),
    provider
  };
}

function extractAudioPayload(payload, headers = {}) {
  const contentType = String(headers?.['content-type'] || headers?.['Content-Type'] || '').toLowerCase();
  const rawBuffer = toBuffer(payload);

  if (rawBuffer) {
    if (contentType.startsWith('audio/')) {
      return {
        buffer: rawBuffer,
        format: normalizeAudioFormat(contentType),
        provider: null
      };
    }

    const parsedJson = tryParseJson(rawBuffer.toString('utf8'));
    if (parsedJson) {
      return extractAudioPayload(parsedJson, headers);
    }
  }

  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    const parsedJson = tryParseJson(payload);
    if (parsedJson) {
      return extractAudioPayload(parsedJson, headers);
    }
    return buildAudioResult(payload, 'wav');
  }

  const contentItems = Array.isArray(payload?.choices?.[0]?.message?.content)
    ? payload.choices[0].message.content
    : [];

  const candidates = [
    { data: payload.audio?.data, format: payload.audio?.format || payload.audio?.mime_type },
    { data: payload.output_audio?.data, format: payload.output_audio?.format || payload.output_audio?.mime_type },
    { data: payload.choices?.[0]?.message?.audio?.data, format: payload.choices?.[0]?.message?.audio?.format || payload.choices?.[0]?.message?.audio?.mime_type },
    { data: payload.data?.audio?.data, format: payload.data?.audio?.format || payload.data?.audio?.mime_type },
    { data: payload.data, format: payload.format || payload.mime_type },
    ...contentItems.map(item => ({
      data: item?.audio?.data || item?.data || item?.b64_json,
      format: item?.audio?.format || item?.format || item?.mime_type
    }))
  ];

  for (const candidate of candidates) {
    if (!candidate?.data) {
      continue;
    }

    const binaryBuffer = toBuffer(candidate.data);
    if (binaryBuffer) {
      return {
        buffer: binaryBuffer,
        format: normalizeAudioFormat(candidate.format || contentType || 'wav'),
        provider: null
      };
    }

    const audioResult = buildAudioResult(
      candidate.data?.b64_json || candidate.data?.data || candidate.data,
      candidate.format || contentType || 'wav'
    );
    if (audioResult) {
      return audioResult;
    }
  }

  return null;
}

async function persistTtsMetadata(req, messageId, sourceSnapshot, ttsMetadata, audioFilename, response) {
  const db = await req.getUserDb();
  let found = false;
  await withWriteLock(req.userId, async () => {
    // 读、改、写必须处于同一锁内，避免并发AI回复覆盖TTS元数据。
    await db.read();
    const effect = db.data.ttsEffects?.find(item => item.id === req.body.clientRequestId);
    if (!effect || !['running', 'unknown'].includes(effect.status)) throw new Error('TTS_EFFECT_NOT_ACTIVE');
    const previousEffect = structuredClone(effect);
    const previousAudio = db.data.ttsAudioFiles;
    let message = null;
    let previousMetadata = null;
    if (messageId) {
      message = (await readableTtsMessages(req.userId, db)).find(entry => entry.id === messageId);
      if (!message || !sameSource(message, sourceSnapshot)) return;
      found = true;
      previousMetadata = message.metadata;
      message.metadata = { ...(message.metadata || {}), tts: ttsMetadata };
    }
    db.data.ttsAudioFiles = [...(db.data.ttsAudioFiles || []),
      { filename: audioFilename, messageId: messageId || null, createdAt: Date.now() }];
    effect.status = 'succeeded';
    effect.updatedAt = Date.now();
    effect.response = response;
    try { await db.write(); }
    catch (error) {
      if (message) message.metadata = previousMetadata;
      db.data.ttsAudioFiles = previousAudio;
      Object.assign(effect, previousEffect);
      clearUserDbCache(req.userId);
      throw error;
    }
  });

  return !messageId || found;
}

router.get('/audio/:filename', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9._-]+$/.test(filename) || path.basename(filename) !== filename) {
    return res.status(400).json({ error: '无效的文件名' });
  }
  if (!req.userId || typeof req.getUserDb !== 'function') {
    return res.status(401).json({ error: '未登录', requiresAuth: true });
  }
  const audioPath = path.join(ttsDir, filename);
  const resolvedPath = path.resolve(audioPath);
  if (!resolvedPath.startsWith(path.resolve(ttsDir) + path.sep)) {
    return res.status(403).json({ error: '禁止访问' });
  }
  const db = await req.getUserDb();
  const authorizedFile = await withWriteLock(req.userId, async () => {
    await db.read();
    const readableMessages = await readableTtsMessages(req.userId, db);
    let record = db.data.ttsAudioFiles?.find(audio => audio.filename === filename);
    if (!record) {
      // Earlier versions stored only message metadata. Recover ownership only
      // from a still-readable source with an exact server-issued filename.
      const legacyMessage = readableMessages.find(message =>
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(message.id) &&
        filename.startsWith(`tts_${message.id}_`) &&
        /^tts_[\da-f-]{36}_[a-z0-9]{8}\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(filename) &&
        message.metadata?.tts?.audioUrl === `/api/tts/audio/${filename}`);
      if (!legacyMessage) return false;
      record = { filename, messageId: legacyMessage.id, createdAt: Date.now() };
      db.data.ttsAudioFiles ||= [];
      db.data.ttsAudioFiles.push(record);
      try { await db.write(); }
      catch (error) {
        db.data.ttsAudioFiles = db.data.ttsAudioFiles.filter(audio => audio !== record);
        throw error;
      }
    }
    if (!hasAccessibleAudio(db.data, `/api/tts/audio/${filename}`, readableMessages)) return null;
    // Open while the account lock still protects the source check. A later
    // source revocation cannot make a new request open this file.
    try {
      const handle = await fs.open(audioPath, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          await handle.close();
          return null;
        }
        return { handle, stat };
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  });
  if (!authorizedFile) {
    return res.status(404).json({ error: '音频文件不存在或无权访问' });
  }
  const { handle } = authorizedFile;
  const fileSize = authorizedFile.stat.size;
  const rangeHeader = req.headers.range;
  const contentType = getMimeType(path.extname(filename).slice(1));

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, no-store');

  const streamAudio = (streamOptions, statusCode, extraHeaders) => {
    for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
      res.setHeader(headerName, headerValue);
    }
    res.status(statusCode);
    const audioStream = handle.createReadStream(streamOptions);
    res.on('close', () => audioStream.destroy());
    audioStream.on('error', (streamError) => {
      console.error('TTS音频流读取失败:', streamError?.message);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.status(500).json({ error: '音频文件读取失败' });
      }
    });
    audioStream.pipe(res);
  };

  const rangeMatch = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;

  if (rangeHeader && rangeMatch) {
    const [, rawStart, rawEnd] = rangeMatch;
    let start = null;
    let end = null;

    if (rawStart === '' && rawEnd !== '') {
      const suffixLength = Number.parseInt(rawEnd, 10);
      if (suffixLength > 0 && fileSize > 0) {
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
      }
    } else if (rawStart !== '') {
      start = Number.parseInt(rawStart, 10);
      end = rawEnd === '' ? fileSize - 1 : Number.parseInt(rawEnd, 10);
      if (Number.isSafeInteger(end) && end > fileSize - 1) {
        end = fileSize - 1;
      }
    }

    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start > end || start >= fileSize
    ) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      await handle.close();
      return res.status(416).json({ error: '请求的音频范围不满足' });
    }

    const chunksize = end - start + 1;
    streamAudio({ start, end }, 206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(chunksize)
    });
    return;
  }

  streamAudio(undefined, 200, {
    'Content-Length': String(fileSize)
  });
}));

function estimateDuration(text, speed) {
  const charCount = text.length;
  const seconds = Math.max(2, Math.ceil(charCount / 5));
  return Math.round(seconds / Math.max(speed || 1, 0.5));
}

export default router;
