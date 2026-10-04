import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const calls = [];
globalThis.__goalApiTest = {
  get: async (path) => { calls.push({ method: 'GET', path }); return { data: { goals: [], executionAvailable: false } }; },
  post: async (path, body, config) => { calls.push({ method: 'POST', path, body, config }); return { data: { goalId: 'goal-1', executionAvailable: false } }; },
};
const bundled = await build({
  entryPoints: [resolve(frontendRoot, 'src/services/personalGoals.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [{
    name: 'mock-http-boundary',
    setup(build) {
      build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'mock-http-boundary' }));
      build.onLoad({ filter: /.*/, namespace: 'mock-http-boundary' }, () => ({
        contents: 'export const axiosInstance = globalThis.__goalApiTest;', loader: 'js',
      }));
    },
  }],
});
const service = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('goal form rejects missing acceptance and keeps each check distinct', () => {
  assert.throws(() => service.buildPersonalGoalInput('完成交付', '', '   '), /验收条件/);
  const input = service.buildPersonalGoalInput(' 完成交付 ', '不可覆盖原文件\n保留中文', '文件可打开\n验收人已确认');
  assert.equal(input.outcome, '完成交付');
  assert.deepEqual(input.constraints, ['不可覆盖原文件', '保留中文']);
  assert.deepEqual(input.checks, [
    { key: 'check-1', description: '文件可打开', required: true },
    { key: 'check-2', description: '验收人已确认', required: true },
  ]);
  assert.equal(input.budgetLimitMicros, '0');
});

test('uncertain retries reuse the same key and changed content cannot silently reuse it', () => {
  const body = service.buildPersonalGoalInput('目标', '', '检查结果');
  const first = service.retainSubmissionKey(null, body, () => 'stable-key');
  assert.equal(service.retainSubmissionKey(first, { ...body }, () => 'new-key').key, 'stable-key');
  assert.throws(() => service.retainSubmissionKey(first, { ...body, outcome: '另一个目标' }, () => 'new-key'), /核对/);
});

test('goal and run mutations send exact paths, body and idempotency key', async () => {
  const body = service.buildPersonalGoalInput('结果', '', '验收');
  await service.personalGoalsApi.create(body, 'goal-key');
  await service.personalGoalsApi.createRun('goal:with/slash', service.buildPersonalRunInput('核对资料\n提交证据'), 'run-key');
  await service.personalGoalsApi.transitionRun('goal:with/slash', 'run:1', 'pause', 'pause-key');
  await service.personalGoalsApi.complete('goal:with/slash', 'run:1', 'complete-key');
  assert.deepEqual(calls.map(call => [call.method, call.path, call.config?.headers?.['Idempotency-Key']]), [
    ['POST', '/goals', 'goal-key'],
    ['POST', '/goals/goal%3Awith%2Fslash/runs', 'run-key'],
    ['POST', '/goals/goal%3Awith%2Fslash/runs/run%3A1/pause', 'pause-key'],
    ['POST', '/goals/goal%3Awith%2Fslash/complete', 'complete-key'],
  ]);
  assert.deepEqual(calls[2].body, {});
  assert.deepEqual(calls[3].body, { runId: 'run:1' });
});
