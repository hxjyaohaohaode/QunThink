import express from 'express';
import axios from 'axios';
import { asyncHandler } from '../middleware/errorHandler.js';
import { readCatalog, saveCatalog, resolveProviderConnection } from '../services/ai/catalog.js';
import { providerHeaders, describeProviderError } from '../services/ai/transport.js';
import { getSafeAiRequestOptions } from '../utils/safeExternalUrl.js';
import { getModelProbe, parseModelProbeRequest, runModelProbe, modelProbeHttpStatus } from '../services/ai/modelProbes.js';
import { loadCustomPersonas } from '../services/scheduler/index.js';

const router = express.Router();
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
  res.set('Cache-Control', 'no-store');
  const input = parseModelProbeRequest(req.body, req.get('Idempotency-Key'));
  // A disconnected browser stops waiting, not the bounded authorized probe.
  // Its canonical request remains queryable; nothing automatically resends it.
  const effect = await runModelProbe(req.userId, input);
  res.status(modelProbeHttpStatus(effect)).json(effect);
}));
router.get('/model-catalog/tests/:requestId', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await getModelProbe(req.userId, req.params.requestId));
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
