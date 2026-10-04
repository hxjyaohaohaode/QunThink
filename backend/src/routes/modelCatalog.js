import express from 'express';
import axios from 'axios';
import sharp from 'sharp';
import { asyncHandler } from '../middleware/errorHandler.js';
import { readCatalog, saveCatalog, resolveModel, resolveProviderConnection, recordCapabilityProbe } from '../services/ai/catalog.js';
import { requestCompletion, providerHeaders, describeProviderError } from '../services/ai/transport.js';
import { getSafeAiRequestOptions } from '../utils/safeExternalUrl.js';
import { isPcmWav } from '../services/ai/audioValidation.js';
import { loadCustomPersonas } from '../services/scheduler/index.js';

const router = express.Router();
async function probeVision(config) {
  // A text-only endpoint can guess once. Two contrasting images must produce
  // different, matching observations before this connection handles images.
  const samples = Math.random() < 0.5 ? ['red', 'blue'] : ['blue', 'red'];
  for (const color of samples) {
    const png = await sharp({ create: {
      width: 24, height: 24, channels: 3,
      background: color === 'red' ? { r: 255, g: 0, b: 0 } : { r: 0, g: 0, b: 255 }
    } }).png().toBuffer();
    const answer = await requestCompletion(config, [{ role: 'user', content: [
      { type: 'text', text: '请识别这张纯色图片的主色。只回答红色或蓝色；无法识别时回答无法识别。' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
    ] }], { maxTokens: 32, timeout: 20000 });
    const red = /红色|\bred\b/i.test(answer);
    const blue = /蓝色|\bblue\b/i.test(answer);
    if ((color === 'red' && (!red || blue)) ||
        (color === 'blue' && (!blue || red))) {
      throw Object.assign(new Error('图片理解测试未能正确识别两张不同的色块'), { status: 422 });
    }
  }
}
async function probeTts(config) {
  if (config.protocol !== 'openai') throw Object.assign(new Error('当前语音探测仅支持 OpenAI 兼容协议'), { status: 400 });
  const endpoint = config.ttsMode === 'chat-audio' ? config.endpoint : `${config.baseUrl}/audio/speech`;
  const safe = await getSafeAiRequestOptions(endpoint);
  if (config.ttsMode === 'chat-audio') {
    const response = await axios.post(endpoint, {
      model: config.model, modalities: ['text', 'audio'], audio: { voice: config.ttsVoice || 'mimo_default', format: 'wav' },
      messages: [{ role: 'user', content: '请把“你好”转换成短语音。' }], stream: false
    }, { ...safe, headers: providerHeaders(config), timeout: 20000, maxContentLength: 1024 * 1024 });
    const audio = response.data?.choices?.[0]?.message?.audio?.data;
    if (typeof audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio) ||
        Buffer.from(audio, 'base64').toString('base64') !== audio || !isPcmWav(Buffer.from(audio, 'base64'))) {
      throw new Error('语音测试未收到有效音频');
    }
    return;
  }
  const response = await axios.post(endpoint, {
    model: config.model, input: '你好', voice: config.ttsVoice || 'alloy', response_format: 'wav'
  }, { ...safe, headers: providerHeaders(config), responseType: 'arraybuffer', timeout: 20000, maxContentLength: 1024 * 1024 });
  if (!/^(audio\/|application\/octet-stream)/i.test(response.headers?.['content-type'] || '') ||
      !isPcmWav(response.data)) throw new Error('语音测试未收到有效 WAV 音频');
}
router.get('/model-catalog', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await readCatalog(req.userId));
}));
router.put('/model-catalog', asyncHandler(async (req, res) => {
  try {
    const catalog = await saveCatalog(req.userId, req.body);
    await loadCustomPersonas(req.userId);
    res.json(catalog);
  } catch (error) {
    if (error.issues) return res.status(400).json({ error: error.issues.map(i => i.message).join('；') });
    throw error;
  }
}));
router.post('/model-catalog/test', asyncHandler(async (req, res) => {
  const capability = req.body?.capability || 'chat';
  if (!['chat', 'vision', 'tts'].includes(capability)) return res.status(400).json({ error: '当前只支持测试对话、图片理解或语音合成能力' });
  const config = await resolveModel(req.userId, req.body?.modelId, capability, { allowUnverified: true });
  const expectedFingerprint = config.capabilityFingerprint;
  const started = Date.now();
  try {
    if (capability === 'tts') await probeTts(config);
    else if (capability === 'vision') await probeVision(config);
    else await requestCompletion(config, [{ role: 'user', content: '请回复 OK' }], { maxTokens: 32, timeout: 20000 });
  } catch (error) {
    try {
      await recordCapabilityProbe(req.userId, req.body.modelId, capability, { verified: false, expectedFingerprint, expectedRevision: config.catalogRevision });
    } catch { /* A concurrent catalog edit already invalidated this probe. */ }
    return res.status(502).json({ healthy: false, error: describeProviderError(error) });
  }
  await recordCapabilityProbe(req.userId, req.body.modelId, capability, {
    verified: true, responseTime: Date.now() - started, expectedFingerprint, expectedRevision: config.catalogRevision
  });
  res.json({ healthy: true, capability, model: config.model, responseTime: Date.now() - started });
}));
router.post('/model-catalog/discover', asyncHandler(async (req, res) => {
  // Reuse the exact credential resolution and URL policy used by generation.
  const config = await resolveProviderConnection(req.userId, req.body.providerId);
  const endpoint = `${config.baseUrl}/models`;
  try {
    const safe = await getSafeAiRequestOptions(endpoint);
    const response = await axios.get(endpoint, { ...safe, headers: providerHeaders(config), timeout: 15000, maxContentLength: 2 * 1024 * 1024 });
    const data = response.data?.data;
    if (!Array.isArray(data)) throw new Error('invalid model list');
    const models = [...new Set(data.map(m => m.id).filter(id => typeof id === 'string' && id.length <= 200))].sort().slice(0, 500);
    res.json({ models });
  } catch (error) {
    res.status(502).json({ error: `${describeProviderError(error)}。如果服务商不支持模型列表，可手动填写模型 ID。` });
  }
}));
export default router;
