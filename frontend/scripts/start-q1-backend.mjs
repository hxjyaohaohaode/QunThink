import { assertQ1CiRuntime, Q1_ORIGIN, inspectRequest, completionBody, streamBody } from './q1-fixture-protocol.mjs';
// Must execute before creating any listener or importing the application.
assertQ1CiRuntime();
const { createServer } = await import('node:http');
const { mkdtemp, writeFile } = await import('node:fs/promises');
const { randomBytes, randomUUID } = await import('node:crypto');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { once } = await import('node:events');
const data = await mkdtemp(join(tmpdir(), 'qunthink-q1-ci-'));
const emptyEnv = join(data, 'empty.env');
await writeFile(emptyEnv, '');
process.env.DOTENV_CONFIG_PATH = emptyEnv;
const calls = [], pending = new Map();
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
function reply(call, res, body, observation) {
  call.releasedAt = new Date().toISOString();
  call.responseAttemptedAfterDisconnect = res.destroyed;
  if (res.destroyed) return;
  if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(streamBody(observation.content)); }
  else send(res, 200, completionBody(observation.content));
}
const provider = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, Q1_ORIGIN);
    if (req.headers.host !== new URL(Q1_ORIGIN).host) return send(res, 400, { error: 'Exact loopback host required' });
    if (req.method === 'GET' && url.pathname === '/__q1/observations') return send(res, 200, { fixture: 'deterministic-local-http-v1', calls });
    if (req.method === 'POST' && url.pathname === '/__q1/release') {
      const model = url.searchParams.get('model'); const released = [];
      for (const [id, item] of pending) if (item.call.model === model) {
        reply(item.call, item.res, item.body, item.observation); pending.delete(id); released.push(id);
      }
      return send(res, 200, { released });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return send(res, 404, { error: 'Fixture endpoint not implemented' });
    if (req.headers.authorization || req.headers['x-api-key']) return send(res, 400, { error: 'Credentials forbidden in synthetic fixture' });
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 256000) throw new Error('Fixture input too large'); }
    const body = JSON.parse(raw); const observation = inspectRequest(body);
    const call = { id: randomUUID(), model: body.model, receivedAt: new Date().toISOString(), body, ...observation, content: undefined };
    calls.push(call);
    res.on('close', () => { if (!res.writableFinished) call.disconnectedAt = new Date().toISOString(); });
    if (observation.hold) pending.set(call.id, { call, res, body, observation });
    else reply(call, res, body, observation);
  } catch (error) { if (!res.headersSent) send(res, 400, { error: error.message }); else res.destroy(); }
});
provider.listen(3203, '127.0.0.1'); await once(provider, 'listening');
Object.assign(process.env, {
  NODE_ENV: 'development', AUTH_MODE: 'session', PORT: '3202',
  DATA_DIR: data, AUTH_DB_PATH: join(data, 'auth.json'), MEMORY_DELETION_DIR: join(data, 'memory-deletions'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://127.0.0.1:3210',
  QUNTHINK_SHARED_PROVIDER_KEYS: '0', QUNTHINK_GOAL_BRIEF_SCHEDULER: '0', AI_HEALTH_PROBES: '0',
  AI_ALLOWED_LOCAL_ORIGINS: Q1_ORIGIN,
  MONGODB_URI: '', SUPABASE_DB_URL: '', QUNTHINK_FOUNDATIONS_RUNTIME_URL: '',
});
// No real provider configuration or secrets are inherited by this fixture.
for (const key of Object.keys(process.env)) if (/(?:API_KEY|ACCESS_TOKEN|SECRET_KEY)$/.test(key) || /^(?:ALIYUN_|MIMO_BASE_URL$|OPENAI_|ANTHROPIC_|AZURE_|SMS_)/.test(key)) delete process.env[key];
console.log('Q1 isolated development-mode backend: real message scheduling enabled, local deterministic HTTP fixture only; PostgreSQL/Goal runtime disabled.');
await import('../../backend/src/index.js');
