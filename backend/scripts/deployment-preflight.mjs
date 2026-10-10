// Offline configuration checks only. This never loads .env or contacts a provider.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Deliberately a static-template contract, not a deployment or secret validator.
function checkFreeRender(config) {
  const errors = [];
  const fail = message => errors.push(`render.free.yaml ${message}`);
  if (Object.keys(config).some(key => key !== 'services')) {
    fail('must contain only services; databases, projects and environment groups are not part of the free static-frontend option.');
  }
  if (config.services.length !== 1 || config.services[0].runtime !== 'static') {
    fail('supports only one static frontend with an existing durable backend. Free Node backends lose uploaded files, backgrounds and TTS audio; external PostgreSQL does not preserve those bytes.');
    return errors;
  }
  const [frontend] = config.services;
  if (['disk', 'plan', 'startCommand', 'healthCheckPath'].some(key => key in frontend)) {
    fail('static frontend must not declare a disk, compute plan or backend runtime settings.');
  }
  if (frontend.autoDeployTrigger !== 'off') fail('must retain manual service deploys during readiness preparation.');
  if ('rootDir' in frontend) fail('must omit rootDir so frontend builds retain repository-root shared contracts.');
  if (frontend.buildCommand !== 'cd frontend && test -n "$VITE_BACKEND_URL" && npm ci && npm run build') {
    fail('build command must require the existing backend origin and build from the repository root.');
  }
  if (frontend.staticPublishPath !== './frontend/dist') fail('must publish ./frontend/dist.');
  const env = new Map();
  if (!Array.isArray(frontend.envVars)) {
    fail('frontend requires an explicit envVars array.');
  } else {
    for (const entry of frontend.envVars) {
      if (!entry || typeof entry.key !== 'string' || !entry.key || 'fromGroup' in entry || env.has(entry.key)) {
        fail('envVars must have unique explicit keys without inherited groups.');
        continue;
      }
      // Backend database credentials and encryption keys must never go here.
      if (!['NODE_VERSION', 'VITE_BACKEND_URL', 'VITE_AUTH_MODE'].includes(entry.key)) {
        fail('must contain only frontend build settings, with no backend credentials or additional environment inputs.');
      }
      env.set(entry.key, entry);
    }
  }
  const backendOrigin = env.get('VITE_BACKEND_URL');
  if (!backendOrigin || backendOrigin.sync !== false || Object.keys(backendOrigin).some(key => !['key', 'sync'].includes(key))) {
    fail('VITE_BACKEND_URL must be a manual sync:false input for the verified existing persistent backend, without an invented or generated value.');
  }
  for (const [key, value] of [['VITE_AUTH_MODE', 'session'], ['NODE_VERSION', '22.12.0']]) {
    const entry = env.get(key);
    if (!entry || entry.value !== value || Object.keys(entry).some(field => !['key', 'value'].includes(field))) {
      fail(`${key} must retain the documented fixed value.`);
    }
  }
  return errors;
}

export function checkDeploymentConfig(root, target) {
  const errors = [];
  if (target === 'vercel') {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'frontend/vercel.json'), 'utf8'));
    if ((config.rewrites || []).some(rule => /REPLACE_WITH|YOUR_BACKEND_HOST/i.test(rule.destination || ''))) {
      errors.push('frontend/vercel.json contains an unresolved backend rewrite. Verify the existing backend and routing contract before enabling Vercel deployment.');
    }
  } else if (target === 'compose') {
    const config = YAML.parse(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
    const build = config.services?.frontend?.build;
    if (build?.context !== '.' || build?.dockerfile !== 'frontend/Dockerfile') {
      errors.push('docker-compose.yml frontend build must use repository-root context and frontend/Dockerfile to include shared contracts.');
    }
  } else if (target === 'render' || target === 'render-free') {
    const filename = target === 'render-free' ? 'render.free.yaml' : 'render.yaml';
    const config = YAML.parse(fs.readFileSync(path.join(root, filename), 'utf8'));
    if (!config || !Array.isArray(config.services) || config.services.length === 0) {
      return [`${filename} requires a nonempty services array.`];
    }
    for (const service of config.services) {
      if (!service || typeof service !== 'object' || Array.isArray(service)) {
        errors.push(`${filename} contains an invalid service object.`);
        continue;
      }
      if (typeof service.name !== 'string' || !service.name.trim()) errors.push(`${filename} service names must be nonempty strings.`);
      if (service.type !== 'web') errors.push(`${filename} QunThink services require type web.`);
      if (typeof service.runtime !== 'string' || !['node', 'static'].includes(service.runtime)) errors.push(`${filename} QunThink runtimes must be node or static.`);
      if ('env' in service || !service.runtime) errors.push(`${filename} services must use runtime rather than deprecated env.`);
      if (service.runtime === 'static' && 'region' in service) errors.push(`${filename} static sites must omit region.`);
    }
    if (target === 'render-free' && !errors.length) errors.push(...checkFreeRender(config));
  } else {
    errors.push('Choose exactly one supported target: render, render-free, compose, or vercel.');
  }
  return errors;
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  try {
    const errors = checkDeploymentConfig(root, process.argv[2]);
    for (const error of errors) console.error(error);
    if (!errors.length) console.log('Targeted offline checks passed, not full deployment validation. Provider settings, credentials, backups and deployment health remain unverified.');
    process.exitCode = errors.length ? 1 : 0;
  } catch {
    console.error('Unable to read or parse deployment configuration. No provider operation was attempted.');
    process.exitCode = 1;
  }
}
