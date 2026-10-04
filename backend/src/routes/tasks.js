import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { acceptTaskResult, createTask, deleteTask, listTasks, runTask, updateTask, resolveUnknownTaskRun } from '../services/tasks.js';

const router = express.Router();
router.get('/tasks', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await listTasks(req.userId));
}));
router.post('/tasks', asyncHandler(async (req, res) => {
  res.status(201).json(await createTask(req.userId, req.body));
}));
router.patch('/tasks/:taskId', asyncHandler(async (req, res) => {
  res.json(await updateTask(req.userId, req.params.taskId, req.body));
}));
router.delete('/tasks/:taskId', asyncHandler(async (req, res) => {
  await deleteTask(req.userId, req.params.taskId); res.status(204).end();
}));
router.post('/tasks/:taskId/run', asyncHandler(async (req, res) => {
  res.json(await runTask(req.userId, req.params.taskId));
}));
router.post('/tasks/:taskId/accept', asyncHandler(async (req, res) => {
  res.json(await acceptTaskResult(req.userId, req.params.taskId, req.body?.run_id));
}));
router.post('/tasks/:taskId/resolve-unknown', asyncHandler(async (req, res) => {
  res.json(await resolveUnknownTaskRun(req.userId, req.params.taskId, req.body?.decision));
}));
export default router;
