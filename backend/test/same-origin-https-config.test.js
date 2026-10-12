import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { renderSameOriginHttps } from '../../scripts/render-same-origin-https.mjs';
const base = fs.readFileSync(new URL('../../frontend/nginx.conf', import.meta.url), 'utf8');
for (const origin of [undefined,'','http://app.invalid','https://app.invalid/','https://app.invalid/x','https://user:secret@app.invalid','https://app.invalid?a=1','https://app.invalid#x']) {
  test(`TLS config rejects invalid origin ${String(origin).replace('secret','redacted')}`, () => assert.throws(() => renderSameOriginHttps(base, origin)));
}
test('TLS rendering retains protected routes, upload limits and canonical redirects', () => {
  const text = renderSameOriginHttps(base, 'https://app.example.invalid');
  assert.match(text, /listen 443 ssl;/); assert.match(text, /return 308 https:\/\/app.example.invalid\$request_uri/);
  assert.match(text, /ssl_protocols TLSv1.2 TLSv1.3/); assert.match(text, /return 421/);
  assert.equal((text.match(/512m/g)||[]).length, 2); assert.match(text, /11m/);
  assert.match(text, /allow 127.0.0.1; allow ::1; deny all/);
});
test('renderer rejects drift instead of silently emitting an HTTP configuration', () => assert.throws(() => renderSameOriginHttps(base.replace('listen 80;', 'listen 8080;'), 'https://app.invalid')));
test('HTTPS overlay requires explicit read-only certificate mounts and merges CORS/443 only', () => {
  const config = YAML.parse(fs.readFileSync(new URL('../../deploy/compose.https.yml', import.meta.url), 'utf8'));
  assert.equal(config.services.frontend.volumes.length, 3);
  for (const mount of config.services.frontend.volumes) { assert.equal(mount.read_only, true); assert.equal(mount.bind.create_host_path, false); }
  assert.deepEqual(config.services.frontend.ports, ['443:443']);
  assert.match(config.services.backend.environment[0], /^CORS_ORIGINS=\$\{APP_ORIGIN:\?/);
});
