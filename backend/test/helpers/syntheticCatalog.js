// Explicit user-owned fixtures. Tests must not depend on platform defaults.
export function syntheticModel(overrides = {}) {
  return {
    id: 'test_model', providerId: 'test_provider', name: 'User test model',
    model: 'test/model', enabled: true, capabilities: ['chat'],
    contextWindow: 32000, maxTokens: 1500, temperature: null,
    tokenParameter: 'max_tokens', ttsMode: 'speech', ttsVoice: null,
    color: '#6366f1', ...overrides
  };
}
export function syntheticProvider(overrides = {}) {
  return { id: 'test_provider', name: 'User test provider', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com', enabled: true, keyRequired: true,
    apiKey: 'synthetic-user-owned-key', ...overrides };
}
