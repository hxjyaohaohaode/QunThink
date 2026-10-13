// Isolated synthetic-account server for browser tests. Never uses a real user data directory.
import { buildAgentFixtureEnvironment, startAgentChatFixture } from './agent-chat-fixture.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'qunthink-e2e-'));
const data = join(root, 'data');
await mkdir(data);
const emptyEnv = join(root, 'empty.env');
await writeFile(emptyEnv, '');
const isolated = buildAgentFixtureEnvironment(process.env, data, emptyEnv, randomBytes(32).toString('base64'));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, isolated);
// Explicitly initialize only this new, empty synthetic installation. Never
// relax the production existing-account loader or initialize after a listener.
const { initializeEmptyInstallation } = await import('../../backend/src/models/db.js');
await initializeEmptyInstallation();
await startAgentChatFixture();
await import('../../backend/src/index.js');
