import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function renderSameOriginHttps(base, origin) {
  let url;
  try { url = new URL(origin); } catch { throw new Error('APP_ORIGIN must be a canonical HTTPS origin'); }
  if (url.protocol !== 'https:' || origin !== url.origin || url.username || url.password || !/^[a-zA-Z0-9.-]+$/.test(url.hostname)) {
    throw new Error('APP_ORIGIN must be a canonical HTTPS DNS or IPv4 origin without credentials/path');
  }
  if ((base.match(/listen 80;/g) || []).length !== 1 || (base.match(/server_name localhost;/g) || []).length !== 1) throw new Error('Nginx base configuration changed; review the TLS renderer');
  const secure = base.replace('listen 80;', 'listen 443 ssl;\n    ssl_certificate /etc/nginx/tls/server.crt;\n    ssl_certificate_key /etc/nginx/tls/server.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:QunThinkTLS:10m;')
    .replace('server_name localhost;', `server_name ${url.hostname};\n    if ($host != ${url.hostname}) { return 421; }\n    add_header Strict-Transport-Security "max-age=31536000" always;`);
  return `# Generated for one direct TLS proxy. Do not add an unreviewed outer proxy.\nserver {\n    listen 80;\n    server_name ${url.hostname};\n    location = /nginx-health {\n        allow 127.0.0.1; allow ::1; deny all;\n        root /usr/share/nginx/html;\n        try_files /index.html =503;\n    }\n    location / { return 308 ${origin}$request_uri; }\n}\n\n${secure}`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const base = fs.readFileSync(new URL('../frontend/nginx.conf', import.meta.url), 'utf8');
    process.stdout.write(renderSameOriginHttps(base, process.argv[2] || process.env.APP_ORIGIN));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
