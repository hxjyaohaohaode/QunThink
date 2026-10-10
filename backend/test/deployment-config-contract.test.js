import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { checkDeploymentConfig } from '../scripts/deployment-preflight.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const schema = JSON.parse(fs.readFileSync(new URL('./fixtures/render.schema.json', import.meta.url), 'utf8'));
const blueprint = YAML.parse(fs.readFileSync(path.join(root, 'render.yaml'), 'utf8'));

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
  assert.deepEqual(checkDeploymentConfig(root, 'compose'), []);
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
