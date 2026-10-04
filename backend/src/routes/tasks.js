import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/errorHandler.js';
import { acceptTaskResult, createTask, deleteTask, listTasks, runTask, updateTask, resolveUnknownTaskRun, taskRunInput } from '../services/tasks.js';

const router = express.Router();
function withRequestId(req) {
  const header = req.get('Idempotency-Key');
  const body = req.body || {};
  if (header && body.client_request_id && header.toLowerCase() !== String(body.client_request_id).toLowerCase()) {
    throw Object.assign(new Error('请求头与正文的请求标识不一致'), { status: 400 });
  }
  return header ? { ...body, client_request_id: header } : body;
}
router.use('/tasks', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // Bind delayed client work to the account that created it. Authentication,
  // never this header, remains the authority for which account is accessed.
  const expectedUser = req.get('X-Expected-User-Id');
  if (expectedUser !== undefined && expectedUser !== req.userId) {
    return res.status(409).json({ success: false, code: 'ACCOUNT_CHANGED', error: '账号已切换，请在当前账号重新打开任务' });
  }
  next();
});
router.get('/tasks', asyncHandler(async (req, res) => {
  res.json(await listTasks(req.userId));
}));
router.post('/tasks', asyncHandler(async (req, res) => {
  res.status(201).json(await createTask(req.userId, withRequestId(req)));
}));
router.patch('/tasks/:taskId', asyncHandler(async (req, res) => {
  res.json(await updateTask(req.userId, req.params.taskId, req.body));
}));
router.delete('/tasks/:taskId', asyncHandler(async (req, res) => {
  await deleteTask(req.userId, req.params.taskId); res.status(204).end();
}));
router.post('/tasks/:taskId/run', asyncHandler(async (req, res) => {
  res.json(await runTask(req.userId, req.params.taskId, taskRunInput.parse(withRequestId(req))));
}));
router.post('/tasks/:taskId/accept', asyncHandler(async (req, res) => {
  const { run_id } = z.object({ run_id: z.string().uuid() }).strict().parse(req.body);
  res.json(await acceptTaskResult(req.userId, req.params.taskId, run_id));
}));
router.post('/tasks/:taskId/resolve-unknown', asyncHandler(async (req, res) => {
  const { decision, run_id } = z.object({
    decision: z.enum(['allow_retry', 'abandon']), run_id: z.string().uuid()
  }).strict().parse(req.body);
  res.json(await resolveUnknownTaskRun(req.userId, req.params.taskId, decision, run_id));
}));
export default router;
