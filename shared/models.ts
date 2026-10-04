export type ModelCapability = 'chat' | 'vision' | 'audio' | 'video' | 'tts';
export interface ModelProvider {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  enabled: boolean;
  keyRequired: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  apiKeyConfigured?: boolean;
  keySource?: 'user' | 'environment' | 'none';
  ready?: boolean;
}
export interface CatalogModel {
  id: string;
  providerId: string;
  name: string;
  model: string;
  enabled: boolean;
  capabilities: ModelCapability[];
  contextWindow: number;
  maxTokens: number;
  temperature: number | null;
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
  ttsMode?: 'speech' | 'chat-audio';
  ttsVoice?: string | null;
  color: string;
  ready?: boolean;
  verifiedCapabilities?: ModelCapability[];
}
export interface ModelCatalog {
  revision: number;
  providers: ModelProvider[];
  models: CatalogModel[];
  defaults: { chat: string | null; vision: string | null; tts: string | null };
}
