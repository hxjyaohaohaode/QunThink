import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import { getDataDir, withWriteLock } from '../models/db.js';
import { validateBody, ttsSchema } from '../validators/index.js';
import { getAIConfig, getUserApiConfigForModel, normalizeBaseUrl } from '../services/ai/index.js';
import { getSafeExternalRequestOptions } from '../utils/safeExternalUrl.js';
import { getKey } from '../utils/keyManager.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const MIMO_API_BASE_URL = (process.env.MIMO_API_BASE_URL || process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1').replace(/\/$/, '');
const AUDIO_MIME_TYPES = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4'
};

const TTS_VOICES = [
  { id: 'mimo_default', name: '默认音色', desc: 'MiMo 默认音色', gender: 'female', tone: 'default' },
  { id: 'default_zh', name: '中文女声', desc: 'MiMo 中文女声', gender: 'female', tone: 'zh' },
  { id: 'default_en', name: '英文女声', desc: 'MiMo 英文女声', gender: 'female', tone: 'en' }
];

const TTS_TONES = [
  { id: 'normal', name: '正常', desc: '标准语调和语速', speed: 1.0, pitch: 1.0, emotion: 'neutral' },
  { id: 'slow_gentle', name: '缓慢温柔', desc: '语速较慢，语调温柔', speed: 0.8, pitch: 0.9, emotion: 'gentle' },
  { id: 'fast_excited', name: '快速兴奋', desc: '语速较快，充满活力', speed: 1.2, pitch: 1.1, emotion: 'excited' },
  { id: 'calm', name: '平静舒缓', desc: '语速均匀，语调平稳', speed: 0.9, pitch: 1.0, emotion: 'calm' },
  { id: 'emotional', name: '情感丰富', desc: '语调变化大，情感充沛', speed: 1.0, pitch: 1.2, emotion: 'emotional' }
];

const TTS_DAILY_QUOTA = 50;
const TTS_AUDIO_TOKEN_TTL_MS = 10 * 60 * 1000;
const ORPHAN_TTS_TTL_MS = 24 * 60 * 60 * 1000;

const ttsDailyUsage = new Map();
let ttsAudioTokenSecret = null;

function consumeTtsDailyQuota(userId) {
  const today = new Date().toISOString().slice(0, 10);
  let usage = ttsDailyUsage.get(userId);
  if (!usage || usage.date !== today) {
    usage = { date: today, count: 0 };
    ttsDailyUsage.set(userId, usage);
  }
  if (usage.count >= TTS_DAILY_QUOTA) {
    return false;
  }
  usage.count += 1;
  return true;
}

function getTtsAudioTokenSecret() {
  if (ttsAudioTokenSecret) {
    return ttsAudioTokenSecret;
  }
  try {
    const key = getKey();
    if (key && key.length >= 32) {
      ttsAudioTokenSecret = key;
      return ttsAudioTokenSecret;
    }
  } catch (error) {
    console.warn('[TTS] 读取音频令牌签名密钥失败，回退到派生密钥:', error?.message);
  }
  console.warn('[TTS] keyManager 未初始化，使用 DATA_DIR 派生的静态密钥签署音频访问令牌');
  ttsAudioTokenSecret = crypto.createHash('sha256').update(`tts-audio-token:${getDataDir()}`).digest();
  return ttsAudioTokenSecret;
}

function signTtsAudioToken(filename, expiresAt = Date.now() + TTS_AUDIO_TOKEN_TTL_MS) {
  const signature = crypto.createHmac('sha256', getTtsAudioTokenSecret())
    .update(`${filename}.${expiresAt}`)
    .digest('base64url');
  return `${expiresAt}.${signature}`;
}

function verifyTtsAudioToken(filename, token) {
  if (typeof token !== 'string' || token.length === 0) {
    return false;
  }
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0) {
    return false;
  }
  const expiresAt = Number(token.slice(0, separatorIndex));
  const signature = token.slice(separatorIndex + 1);
  if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) {
    return false;
  }
  const expected = crypto.createHmac('sha256', getTtsAudioTokenSecret())
    .update(`${filename}.${expiresAt}`)
    .digest('base64url');
  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (givenBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(givenBuffer, expectedBuffer);
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
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: '文本内容不能为空' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: '文本内容不能超过5000字符' });
  }
  if (!consumeTtsDailyQuota(req.userId)) {
    return res.status(429).json({ error: '今日语音合成次数已达上限，请明天再试' });
  }
  const speechText = sanitizeTtsText(text);

  if (!speechText) {
    return res.status(400).json({ error: '文本内容不能为空' });
  }

  const voiceConfig = TTS_VOICES.find(entry => entry.id === voice) || TTS_VOICES[0];
  const toneConfig = TTS_TONES.find(entry => entry.id === tone) || TTS_TONES[0];
  const audioId = `tts_${messageId || Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const audioResult = await callMiMoTTS(speechText, voiceConfig.id, toneConfig, req.userId);

  if (!audioResult?.buffer?.length) {
    throw new Error('未收到有效的音频数据');
  }

  const audioFormat = normalizeAudioFormat(audioResult.format);
  const audioFilename = `${audioId}.${audioFormat}`;
  const audioPath = path.join(ttsDir, audioFilename);
  await fs.writeFile(audioPath, audioResult.buffer);

  if (!messageId) {
    scheduleOrphanTtsCleanup(audioPath);
  }

  const duration = estimateDuration(speechText, toneConfig.speed);
  const audioUrl = buildAudioUrl(audioId, audioFormat);
  const ttsMetadata = {
    id: audioId,
    audioUrl,
    duration,
    voiceId: voiceConfig.id,
    toneId: toneConfig.id,
    createdAt: new Date().toISOString(),
    transcript: speechText,
    format: audioFormat,
    provider: audioResult.provider || 'mimo-v2.5-tts'
  };

  if (messageId) {
    await persistTtsMetadata(req, messageId, ttsMetadata);
  }

  res.json({
    success: true,
    audio_id: audioId,
    audio_url: audioUrl,
    duration,
    voice: voiceConfig,
    tone: toneConfig,
    transcript: speechText,
    format: audioFormat,
    audio_token: signTtsAudioToken(audioFilename)
  });
}));

router.get('/messages/:messageId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const message = db.data.messages.find(entry => entry.id === req.params.messageId);
  if (!message?.metadata?.tts) {
    return res.status(404).json({ error: '未找到语音数据' });
  }

  return res.json({
    success: true,
    audio: message.metadata.tts
  });
}));

router.delete('/messages/:messageId', asyncHandler(async (req, res) => {
  const db = await req.getUserDb();
  await db.read();

  const message = db.data.messages.find(entry => entry.id === req.params.messageId);
  if (!message) {
    return res.status(404).json({ error: '消息不存在' });
  }

  const ttsMetadata = message.metadata?.tts;
  if (!ttsMetadata?.audioUrl) {
    return res.status(404).json({ error: '该消息没有可删除的语音' });
  }

  const filename = path.basename(ttsMetadata.audioUrl);
  const audioPath = path.join(ttsDir, filename);
  try {
    await fs.unlink(audioPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const nextMetadata = { ...(message.metadata || {}) };
  delete nextMetadata.tts;
  message.metadata = nextMetadata;

  await withWriteLock(req.userId, async () => {
    await db.write();
  });

  return res.json({ success: true });
}));

async function callMiMoTTS(text, voice, toneConfig, userId) {
  const ttsConfig = getAIConfig('mimo_tts');
  const userConfig = userId ? await getUserApiConfigForModel(userId, 'mimo_tts') : null;
  const apiKey = userConfig?.apiKey || ttsConfig?.apiKey || process.env.MIMO_API_KEY;
  const baseUrl = userConfig?.baseUrl
    ? normalizeBaseUrl(userConfig.baseUrl)
    : (ttsConfig?.endpoint || `${MIMO_API_BASE_URL}/chat/completions`).replace(/\/chat\/completions$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  // 对环境变量和用户自定义端点统一执行 SSRF/重定向防护。
  // 不能只保护用户配置：MIMO_BASE_URL 也属于可部署时注入的网络边界。
  const externalRequestOptions = await getSafeExternalRequestOptions(endpoint);

  if (!apiKey) {
    throw new Error('未配置 MIMO_API_KEY，无法调用 MiMo TTS');
  }

  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const chatResponse = await axios.post(
        endpoint,
        {
          model: 'mimo-v2.5-tts',
          modalities: ['text', 'audio'],
          audio: {
            voice: voice,
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
          directChoiceAudio.format || directChoiceAudio.mime_type || 'wav'
        );
        if (directAudio) {
          return directAudio;
        }
      }

      const completionAudio = extractAudioPayload(chatResponse.data, chatResponse.headers);
      if (completionAudio) {
        return completionAudio;
      }

      const fallbackText = chatResponse.data?.choices?.[0]?.message?.content;
      if (typeof fallbackText === 'string' && fallbackText.trim()) {
        throw new Error(`API返回了文本而非音频: ${fallbackText.substring(0, 100)}`);
      }

      throw new Error('MiMo API 响应中未找到可播放的音频数据');
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.message?.includes('timeout'))) {
        console.log(`[TTS] 重试 ${attempt + 1}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function buildTonePrompt(toneConfig) {
  const toneMap = {
    slow_gentle: '请将下一条 assistant 消息用更慢、更温柔的语气转成语音。',
    fast_excited: '请将下一条 assistant 消息用更快、更有活力的语气转成语音。',
    calm: '请将下一条 assistant 消息用平静舒缓的语气转成语音。',
    emotional: '请将下一条 assistant 消息用更丰富的情感和更明显的抑扬顿挫转成语音。'
  };

  return toneMap[toneConfig.id] || '请将下一条 assistant 消息自然、清晰地转成语音。';
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

function buildAudioResult(base64Data, format, provider = 'mimo-v2.5-tts') {
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
        provider: 'mimo-v2.5-tts'
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
        provider: 'mimo-v2.5-tts'
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

async function persistTtsMetadata(req, messageId, ttsMetadata) {
  const db = await req.getUserDb();
  let found = false;
  await withWriteLock(req.userId, async () => {
    // 读、改、写必须处于同一锁内，避免并发AI回复覆盖TTS元数据。
    await db.read();
    const message = db.data.messages.find(entry => entry.id === messageId);
    if (!message) return;
    found = true;
    message.metadata = {
      ...(message.metadata || {}),
      tts: ttsMetadata
    };
    await db.write();
  });

  if (!found) {
    console.warn(`[TTS] 未找到关联消息，跳过元数据持久化: ${messageId}`);
    return false;
  }
  return true;
}

router.get('/audio/:filename', asyncHandler(async (req, res) => {
  const filename = path.basename(req.params.filename).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!filename) {
    return res.status(400).json({ error: '无效的文件名' });
  }

  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const tokenValid = token ? verifyTtsAudioToken(filename, token) : false;
  if (!tokenValid && !req.userId) {
    return res.status(401).json({ error: '未登录', requiresAuth: true });
  }

  const audioPath = path.join(ttsDir, filename);
  const resolvedPath = path.resolve(audioPath);
  if (!resolvedPath.startsWith(path.resolve(ttsDir))) {
    return res.status(403).json({ error: '禁止访问' });
  }

  let fileExists = false;
  try {
    await fs.access(audioPath);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (!fileExists) {
    return res.status(404).json({ error: '音频文件不存在' });
  }

  let stat;
  try {
    stat = await fs.stat(audioPath);
  } catch {
    return res.status(500).json({ error: '无法读取文件信息' });
  }

  if (!stat.isFile()) {
    return res.status(404).json({ error: '音频文件不存在' });
  }

  const fileSize = stat.size;
  const rangeHeader = req.headers.range;
  const contentType = getMimeType(path.extname(filename).slice(1));

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');

  const streamAudio = (streamOptions, statusCode, extraHeaders) => {
    for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
      res.setHeader(headerName, headerValue);
    }
    res.status(statusCode);
    const audioStream = createReadStream(audioPath, streamOptions);
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
