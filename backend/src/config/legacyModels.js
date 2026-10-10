// Metadata for explicitly saved legacy model overrides only.
// Never seeded into a new account or used as a connection/credential source.
export const LEGACY_MODEL_METADATA = {
  glm_flash: { name: 'glm-4-flash', params: { max_tokens: 1000 } },
  mimo_flash: { name: 'mimo-v2.5-pro', params: { max_tokens: 1000 } },
  qwen_flash: { name: 'Qwen3.5-Flash', params: { max_tokens: 1500 } },
  deepseek: { name: 'deepseek-v4-flash', params: { max_tokens: 1500 } },
  glm_flashx: { name: 'glm-4-flashx', params: { max_tokens: 1500 } },
  glm_air: { name: 'GLM-4.5-Air', params: { max_tokens: 1500 } },
  qwen_turbo: { name: 'qwen-turbo', params: { max_tokens: 1500 } },
  mimo_omni: { name: 'mimo-v2.5', params: { max_tokens: 1500 } },
  deepseek_reasoner: { name: 'deepseek-v4-pro', params: { max_tokens: 2000 } },
  mimo_tts: { name: 'mimo-v2.5-tts', params: { max_tokens: 200 }, isTTS: true },
  glm_4v_flash: { name: 'glm-4.6v-flash', params: { max_tokens: 500 }, capabilities: ['vision'] },
  qwen_vl_plus: { name: 'qwen-vl-plus', params: { max_tokens: 500 }, capabilities: ['vision'] },
  qwen_omni: { name: 'qwen2.5-omni-7b', params: { max_tokens: 500 }, capabilities: ['vision', 'audio', 'video'] },
};

// Retire only demonstrably auto-created membership. Keep the group, all its
// messages, custom groups/agents and explicit user catalogs unchanged. A copy
// of retired IDs is retained so this compatibility migration is reversible.
const SEEDED_GROUP_IDS = new Set(['group-presidential', 'group-debate', 'group-collaborative']);
export function retireImplicitPresetMembers(data) {
  const ownedModels = new Set(data.modelCatalog?.models?.map(model => model.id) ||
    Object.entries(data.aiModels || {}).filter(([, model]) => typeof model?.model === 'string' && model.model.trim()).map(([id]) => id));
  let changed = false;
  for (const group of data.groups || []) {
    if (group.type !== 'preset' || !SEEDED_GROUP_IDS.has(group.id) || !Array.isArray(group.ai_members)) continue;
    const retired = group.ai_members.filter(id => Object.hasOwn(LEGACY_MODEL_METADATA, id) && !ownedModels.has(id));
    if (!retired.length) continue;
    group.retired_ai_members = [...new Set([...(group.retired_ai_members || []), ...retired])];
    group.ai_members = group.ai_members.filter(id => !retired.includes(id));
    changed = true;
  }
  return changed;
}
