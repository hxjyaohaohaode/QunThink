// Isolated synthetic-account server for browser tests. Never uses a real user data directory.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = await mkdtemp(join(tmpdir(), 'qunthink-e2e-'));
Object.assign(process.env, {
  NODE_ENV: 'test', AUTH_MODE: 'session', PORT: '3202',
  DATA_DIR: data, AUTH_DB_PATH: join(data, 'auth.json'),
  MEMORY_DELETION_DIR: join(data, 'memory-deletions'),
  CORS_ORIGINS: 'http://127.0.0.1:3210', QUNTHINK_SHARED_PROVIDER_KEYS: '0',
  QUNTHINK_GOAL_BRIEF_SCHEDULER: '0', AI_HEALTH_PROBES: '0',
  MONGODB_URI: '', SUPABASE_DB_URL: '', QUNTHINK_FOUNDATIONS_RUNTIME_URL: '',
});
await import('../../backend/src/index.js');
