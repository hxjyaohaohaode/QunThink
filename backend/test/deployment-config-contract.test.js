import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { checkDeploymentConfig } from '../scripts/deployment-preflight.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const schema = JSON.parse(fs.readFileSync(new URL('./fixtures/render.schema.json', import.meta.url), 'utf8'));
const blueprint = YAML.parse(fs.readFileSync(path.join(root, 'render.yaml'), 'utf8'));
const freeBlueprint = YAML.parse(fs.readFileSync(path.join(root, 'render.free.yaml'), 'utf8'));

// Targeted service-shape contract derived from the official pinned schema.
// This is not a replacement for complete JSON Schema validation or provider audit.
function shapeErrors(service) {
  const definition = service.runtime === 'static' || service.type === 'static'
    ? schema.definitions.staticService : schema.definitions.serverService;
  const errors = [];
  // Official serverService requires runtime when no shared buildSource is used.
  if (definition.allOf && !('buildSource' in service)) {
    for (const key of definition.allOf[0].then.required) if (!(key in service)) errors.push(`missing ${key}`);
  }
  for (const key of definition.required) if (!(key in service)) errors.push(`missing ${key}`);
  for (const key of Object.keys(service)) if (!(key in definition.properties)) errors.push(`unsupported ${key}`);
  for (const [key, property] of Object.entries(definition.properties)) {
    if ('const' in property && key in service && service[key] !== property.const) errors.push(`invalid ${key}`);
  }
  return errors;
}

test('pinned schema identifies the official source and expected static contract', () => {
  assert.equal(schema.$id, 'https://render.com/schema/render.yaml.json');
  assert.equal(schema.definitions.staticService.properties.type.const, 'web');
  assert.equal(schema.definitions.staticService.properties.runtime.const, 'static');
  assert.equal(schema.definitions.staticService.additionalProperties, false);
});
test('both shipped Render services satisfy the official service-shape contract', () => {
  assert.equal(blueprint.services.length, 2);
  for (const service of blueprint.services) assert.deepEqual(shapeErrors(service), []);
});
test('legacy static type without runtime is rejected', () => {
  const fixture = { ...blueprint.services[1], type: 'static' }; delete fixture.runtime;
  assert.ok(shapeErrors(fixture).includes('missing runtime'));
  assert.ok(shapeErrors(fixture).includes('invalid type'));
});
test('static region is rejected by the pinned schema', () => {
  assert.ok(shapeErrors({ ...blueprint.services[1], runtime: 'static', region: 'singapore' }).includes('unsupported region'));
});
test('deprecated backend env is rejected by the pinned schema', () => {
  const fixture = { ...blueprint.services[0], env: 'node' }; delete fixture.runtime;
  assert.ok(shapeErrors(fixture).includes('missing runtime'));
  assert.ok(shapeErrors(fixture).includes('unsupported env'));
});
test('offline Render and Compose preflights pass for shipped configuration', () => {
  assert.deepEqual(checkDeploymentConfig(root, 'render'), []);
  assert.deepEqual(checkDeploymentConfig(root, 'render-free'), []);
  assert.deepEqual(checkDeploymentConfig(root, 'compose'), []);
});

test('free template contains only a static frontend and preserves the separate paid option', () => {
  assert.equal(freeBlueprint.services.length, 1);
  assert.equal(freeBlueprint.services[0].runtime, 'static');
  assert.deepEqual(shapeErrors(freeBlueprint.services[0]), []);
  assert.ok(!('plan' in freeBlueprint.services[0]));
  assert.ok(!('disk' in freeBlueprint.services[0]));
  assert.ok(!('databases' in freeBlueprint));
  assert.ok(!blueprint.services.some(existing => existing.name === freeBlueprint.services[0].name));
  assert.equal(blueprint.services[0].plan, 'starter');
  assert.equal(blueprint.services[0].disk.mountPath, '/var/data');
});

function freeFixture(mutator) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-free-preflight-'));
  try {
    const config = structuredClone(freeBlueprint);
    mutator(config);
    fs.writeFileSync(path.join(fixtureRoot, 'render.free.yaml'), YAML.stringify(config));
    return checkDeploymentConfig(fixtureRoot, 'render-free');
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
}
const replaceFrontendEnv = (config, key, entry) => {
  config.services[0].envVars = config.services[0].envVars.filter(current => current.key !== key);
  if (entry) config.services[0].envVars.push({ key, ...entry });
};

for (const [label, mutate] of [
  ['free Node backend added', config => { config.services.push({ ...structuredClone(blueprint.services[0]), plan: 'free' }); }],
  ['free Node backend instead of frontend', config => { config.services = [{ ...structuredClone(blueprint.services[0]), plan: 'free' }]; }],
  ['extra paid backend', config => { config.services.push(structuredClone(blueprint.services[0])); }],
  ['persistent disk', config => { config.services[0].disk = { name: 'data', mountPath: '/var/data', sizeGB: 1 }; }],
  ['implicit managed database', config => { config.databases = [{ name: 'expired-after-30-days', plan: 'free' }]; }],
  ['hidden project resources', config => { config.projects = []; }],
  ['hidden environment groups', config => { config.envVarGroups = []; }],
  ['extra static service', config => { config.services.push(structuredClone(config.services[0])); }],
  ['missing static frontend', config => { config.services.pop(); }],
  ['static compute plan', config => { config.services[0].plan = 'free'; }],
  ['automatic service deploy', config => { config.services[0].autoDeployTrigger = 'commit'; }],
  ['frontend-only root directory', config => { config.services[0].rootDir = 'frontend'; }],
  ['backend start command', config => { config.services[0].startCommand = 'cd backend && npm start'; }],
  ['backend health route', config => { config.services[0].healthCheckPath = '/api/health'; }],
  ['missing backend-origin build guard', config => { config.services[0].buildCommand = 'cd frontend && npm ci && npm run build'; }],
  ['wrong publish directory', config => { config.services[0].staticPublishPath = './dist'; }],
  ['backend encryption key', config => replaceFrontendEnv(config, 'ENCRYPTION_KEY', { value: 'PRIVATE_SENTINEL' })],
  ['backend PG URL', config => replaceFrontendEnv(config, 'SUPABASE_DB_URL', { value: 'postgresql://PRIVATE_SENTINEL@example.invalid/db' })],
  ['publicly bundled key', config => replaceFrontendEnv(config, 'VITE_ENCRYPTION_KEY', { sync: false })],
  ['missing backend origin', config => replaceFrontendEnv(config, 'VITE_BACKEND_URL', null)],
  ['invented backend origin', config => replaceFrontendEnv(config, 'VITE_BACKEND_URL', { value: 'https://PRIVATE_SENTINEL.example.invalid' })],
  ['generated backend origin', config => replaceFrontendEnv(config, 'VITE_BACKEND_URL', { generateValue: true })],
  ['mixed origin value and sync', config => replaceFrontendEnv(config, 'VITE_BACKEND_URL', { sync: false, value: 'PRIVATE_SENTINEL' })],
  ['frontend auth drift', config => replaceFrontendEnv(config, 'VITE_AUTH_MODE', { value: 'dev' })],
  ['unpinned Node version', config => replaceFrontendEnv(config, 'NODE_VERSION', null)],
  ['duplicate environment entry', config => config.services[0].envVars.push({ key: 'VITE_AUTH_MODE', value: 'dev' })],
  ['invalid environment entry', config => config.services[0].envVars.push(null)],
  ['inherited environment group', config => config.services[0].envVars.push({ fromGroup: 'unverified' })],
  ['missing environment array', config => { delete config.services[0].envVars; }],
  ['nonarray environment settings', config => { config.services[0].envVars = {}; }],
]) {
  test(`free Render template preflight rejects ${label} without exposing values`, () => {
    const errors = freeFixture(mutate);
    assert.ok(errors.length > 0);
    assert.ok(!errors.join('\n').includes('PRIVATE_SENTINEL'));
  });
}

test('static frontend build requires a backend origin without calling the real npm', { skip: process.platform === 'win32' }, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'render-free-build-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'frontend'));
    const bin = path.join(fixtureRoot, 'bin');
    fs.mkdirSync(bin);
    // A fake npm proves shell short-circuiting without building, loading .env or networking.
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "FAKE_NPM_CALLED\\n"\n', { mode: 0o700 });
    for (const env of [{ PATH: bin }, { PATH: bin, VITE_BACKEND_URL: '' }]) {
      const result = spawnSync('/bin/sh', ['-c', freeBlueprint.services[0].buildCommand], {
        cwd: fixtureRoot, env, encoding: 'utf8'
      });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    const valid = spawnSync('/bin/sh', ['-c', freeBlueprint.services[0].buildCommand], {
      cwd: fixtureRoot, env: { PATH: bin, VITE_BACKEND_URL: 'https://backend.example.invalid' }, encoding: 'utf8'
    });
    assert.equal(valid.status, 0);
    assert.equal(valid.stdout, 'FAKE_NPM_CALLED\nFAKE_NPM_CALLED\n');
    assert.equal(valid.stderr, '');
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
});
test('Compose context contains every frontend Dockerfile local COPY input', () => {
  const config = YAML.parse(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
  const build = config.services.frontend.build;
  const context = path.resolve(root, build.context);
  assert.equal(context, path.resolve(root));
  assert.equal(build.dockerfile, 'frontend/Dockerfile');
  for (const relative of ['frontend/package.json', 'frontend/package-lock.json', 'shared', 'frontend/nginx.conf']) {
    assert.ok(fs.existsSync(path.join(context, relative)), `${relative} must be within the build context`);
  }
});
test('same-origin Nginx API and WebSocket routes stay intact', () => {
  const nginx = fs.readFileSync(path.join(root, 'frontend/nginx.conf'), 'utf8');
  assert.match(nginx, /location \/api\s*\{\s*proxy_pass http:\/\/backend:3002;/);
  assert.match(nginx, /location \/ws\s*\{\s*proxy_pass http:\/\/backend:3002;/);
});
test('unresolved Vercel route fails closed without printing its destination', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-preflight-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'frontend'));
    const marker = 'PRIVATE_SENTINEL';
    fs.writeFileSync(path.join(fixtureRoot, 'frontend/vercel.json'), JSON.stringify({ rewrites: [{ destination: `https://REPLACE_WITH_YOUR_BACKEND_HOST/${marker}` }] }));
    const errors = checkDeploymentConfig(fixtureRoot, 'vercel');
    assert.equal(errors.length, 1);
    assert.ok(!errors.join('').includes(marker));
    fs.writeFileSync(path.join(fixtureRoot, 'frontend/vercel.json'), JSON.stringify({ rewrites: [{ destination: 'https://backend.example.invalid/api/:path*' }] }));
    assert.deepEqual(checkDeploymentConfig(fixtureRoot, 'vercel'), []);
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
});
test('preflight rejects unknown targets', () => {
  assert.equal(checkDeploymentConfig(root, 'production').length, 1);
});

for (const [label, config] of [
  ['missing services', {}],
  ['empty services', { services: [] }],
  ['non-array services', { services: {} }],
  ['null service', { services: [null] }],
  ['unknown service type', { services: [{ name: 'fixture', type: 'invalid', runtime: 'node' }] }],
  ['non-string runtime', { services: [{ name: 'fixture', type: 'web', runtime: 22 }] }],
  ['unsupported runtime', { services: [{ name: 'fixture', type: 'web', runtime: 'invalid' }] }],
  ['missing name', { services: [{ type: 'web', runtime: 'node' }] }],
]) {
  test(`Render targeted preflight fails closed for ${label}`, () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-preflight-'));
    try {
      fs.writeFileSync(path.join(fixtureRoot, 'render.yaml'), YAML.stringify(config));
      assert.ok(checkDeploymentConfig(fixtureRoot, 'render').length > 0);
    } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
}
