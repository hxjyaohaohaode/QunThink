// Isolated synthetic-account server for browser tests. Never uses a real user data directory.
import { buildAgentFixtureEnvironment, startAgentChatFixture } from './agent-chat-fixture.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = await mkdtemp(join(tmpdir(), 'qunthink-e2e-'));
const emptyEnv = join(data, 'empty.env');
await writeFile(emptyEnv, '');
const isolated = buildAgentFixtureEnvironment(process.env, data, emptyEnv, randomBytes(32).toString('base64'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);
await startAgentChatFixture();
await import('../../backend/src/index.js');
