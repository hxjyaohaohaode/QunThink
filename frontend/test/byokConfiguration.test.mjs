import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source=path=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');

test('deployment templates and active setup guides never advertise platform model keys',()=>{
  for(const path of ['backend/.env.example','render.yaml','docker-compose.yml','README.md','CONFIGURATION_GUIDE.md']){
    assert.doesNotMatch(source(path),/\b(?:DEEPSEEK_API_KEY|GLM_API_KEY|MIMO_API_KEY|QWEN_API_KEY|QUNTHINK_SHARED_PROVIDER_KEYS|AI_HEALTH_PROBES)\b/,path);
  }
});

test('the shared provider contract has no server-key source and display metadata is not a model catalog',()=>{
  assert.match(source('shared/models.ts'),/keySource\?: 'user' \| 'none'/);
  assert.doesNotMatch(source('frontend/src/components/Layout/ModelCenter.tsx'),/keySource\s*===\s*['"]environment['"]/);
  const metadata=source('frontend/src/types/index.ts');
  assert.doesNotMatch(metadata,/export const AI_LIST\b/);
  assert.match(metadata,/export const AI_NAMES/);
  assert.match(metadata,/export const AI_COLORS/);
  assert.match(metadata,/export const AI_AVATAR_LETTERS/);
});


test('manual smoke refuses implicit preset setup before sending any request',()=>{
  const script=fileURLToPath(new URL('../../scripts/api-smoke.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',env:{...process.env,QUNTHINK_SMOKE_FIXTURE:''},timeout:5000});
  assert.equal(result.status,2);
  assert.match(result.stderr,/No requests were sent/);
  const smoke=source('scripts/api-smoke.mjs');
  assert.doesNotMatch(smoke,/ai_members:\s*\[\s*['"](?:deepseek|qwen_flash)/);
  assert.doesNotMatch(smoke,/req\('PUT', '\/api\/user\/(?:apiconfig|model-catalog)'/);
  assert.doesNotMatch(source('frontend/src/services/api.ts'),/testUserApiConfig|user\/apiconfig\/test/);
});
