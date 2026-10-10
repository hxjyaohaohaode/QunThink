// Offline configuration checks only. This never loads .env or contacts a provider.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

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
  } else if (target === 'render') {
    const config = YAML.parse(fs.readFileSync(path.join(root, 'render.yaml'), 'utf8'));
    if (!config || !Array.isArray(config.services) || config.services.length === 0) {
      return ['render.yaml requires a nonempty services array.'];
    }
    for (const service of config.services) {
      if (!service || typeof service !== 'object' || Array.isArray(service)) {
        errors.push('render.yaml contains an invalid service object.');
        continue;
      }
      if (typeof service.name !== 'string' || !service.name.trim()) errors.push('render.yaml service names must be nonempty strings.');
      if (service.type !== 'web') errors.push('render.yaml QunThink services require type web.');
      if (typeof service.runtime !== 'string' || !['node', 'static'].includes(service.runtime)) errors.push('render.yaml QunThink runtimes must be node or static.');
      if ('env' in service || !service.runtime) errors.push('render.yaml services must use runtime rather than deprecated env.');
      if (service.runtime === 'static' && 'region' in service) errors.push('render.yaml static sites must omit region.');
    }
  } else {
    errors.push('Choose exactly one supported target: render, compose, or vercel.');
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
