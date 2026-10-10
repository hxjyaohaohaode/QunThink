// Keyless loopback protocol fixture for real-browser Agent cancellation tests.
// This is deterministic test data, never a live-model quality/cost evaluation.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
export const AGENT_FIXTURE_ORIGIN = 'http://127.0.0.1:3203';
export const AGENT_PARTIAL = '合成浏览器验收：这是停止前已收到的部分正文。';
export const AGENT_COMPLETE = '合成浏览器验收：新的独立请求已完整回复。';

// Build rather than merge the child test environment. Local dotenv files,
// inherited provider/SMS credentials and remote database URLs are never used.
export function buildAgentFixtureEnvironment(env, data, emptyEnv, encryptionKey) {
  const inherited = Object.fromEntries([
    'PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'FORCE_COLOR', 'NO_COLOR'
  ].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  return {
    ...inherited, NODE_ENV: 'test', AUTH_MODE: 'session', PORT: '3202',
    DATA_DIR: data, AUTH_DB_PATH: join(data, 'auth.json'), MEMORY_DELETION_DIR: join(data, 'memory-deletions'),
    DOTENV_CONFIG_PATH: emptyEnv, ENCRYPTION_KEY: encryptionKey,
    AI_ALLOWED_LOCAL_ORIGINS: AGENT_FIXTURE_ORIGIN, CORS_ORIGINS: 'http://127.0.0.1:3210',
    QUNTHINK_SHARED_PROVIDER_KEYS: '0', QUNTHINK_GOAL_BRIEF_SCHEDULER: '0', AI_HEALTH_PROBES: '0',
    MONGODB_URI: '', SUPABASE_DB_URL: '', QUNTHINK_FOUNDATIONS_RUNTIME_URL: ''
  };
}

export function inspectAgentRequest(body) {
  if (typeof body?.model !== 'string' || !/^agent-fixture-[a-f0-9-]+$/.test(body.model) || !Array.isArray(body.messages)) throw new Error('Only synthetic Agent models are accepted');
  const latest = [...body.messages].reverse().find(message => message.role === 'user');
  const hold = body.stream === true && typeof latest?.content === 'string' && latest.content.includes('AGENT-E2E-STOP');
  return {
    stream: body.stream === true, hold,
    content: body.stream === true ? (hold ? AGENT_PARTIAL : AGENT_COMPLETE)
      : JSON.stringify({ system_prompt: 'Synthetic assistant for browser transport testing. No real external actions.' })
  };
}

export async function startAgentChatFixture() {
  if (process.env.NODE_ENV !== 'test' || process.env.AUTH_MODE !== 'session') throw new Error('Agent fixture requires the isolated test backend');
  const calls = [];
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(AGENT_FIXTURE_ORIGIN).host) return json(res, 400, { error: 'Exact loopback host required' });
      if (req.headers.authorization || req.headers['x-api-key']) return json(res, 400, { error: 'Credentials forbidden in fixture' });
      if (req.method === 'GET' && req.url === '/__agent/observations') return json(res, 200, { fixture: 'keyless-agent-stream-v1', calls });
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'Unknown fixture endpoint' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 256000) throw new Error('Fixture request too large'); }
      const body = JSON.parse(raw);
      const observation = inspectAgentRequest(body);
      const call = { model: body.model, stream: body.stream === true, disconnected: false, completed: false };
      calls.push(call);
      res.on('close', () => { if (!res.writableFinished) call.disconnected = true; });
      if (!body.stream) {
        call.completed = true;
        return json(res, 200, { choices: [{ message: { content: observation.content } }] });
      }
      const { content, hold } = observation;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      if (!hold) { call.completed = true; res.end('data: [DONE]\n\n'); }
      // The held first response ends only when the actual browser/backend
      // cancellation closes this socket. No timer or manufactured [DONE].
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message }); else res.destroy();
    }
  });
  server.listen(3203, '127.0.0.1'); await once(server, 'listening');
  return server;
}
