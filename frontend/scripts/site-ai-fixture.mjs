import { buildAgentFixtureEnvironment } from './agent-chat-fixture.mjs';

// Deliberately reuse only the existing strict environment whitelist, not its
// server or local-provider listener. Site UI intercepts the optional API itself.
export function buildSiteAiFixtureEnvironment(env, data, emptyEnv, encryptionKey) {
  return {
    ...buildAgentFixtureEnvironment(env, data, emptyEnv, encryptionKey),
    PORT: '3222', CORS_ORIGINS: 'http://127.0.0.1:3220',
    AI_ALLOWED_LOCAL_ORIGINS: '', SERVER_AI_ENABLED: 'false',
  };
}
