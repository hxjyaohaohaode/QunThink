export const AI_NAMES = {
  deepseek: 'deepseek-v4-flash',
  deepseek_reasoner: 'deepseek-v4-pro',
  glm_air: 'GLM-4.5-Air',
  glm_flash: 'GLM-4.7-Flash',
  glm_flashx: 'GLM-4.7-FlashX',
  mimo_flash: 'mimo-v2.5-pro',
  mimo_omni: 'mimo-v2.5',
  mimo_tts: 'mimo-v2.5-tts-voicedesign',
  qwen_flash: 'Qwen3.5-Flash',
  qwen_turbo: 'qwen-turbo',
  glm_4v_flash: 'GLM-4.6V-Flash',
  qwen_vl_plus: 'Qwen-VL-Plus',
  qwen_omni: 'Qwen2.5-Omni-7B'
};

export const AI_MENTION_ALIASES = {
  deepseek: ['deepseek', 'deepseek-v4-flash', 'DeepSeek', 'deepseek_v4_flash', '深度求索', 'V4 Flash'],
  deepseek_reasoner: ['deepseek_reasoner', 'deepseek-v4-pro', 'DeepSeek Pro', 'DeepSeek_V4_Pro', 'reasoner', '推理版', 'V4 Pro'],
  glm_air: ['glm_air', 'GLM-4.5-Air', 'GLM', 'glm-4.5-air', '智谱Air'],
  glm_flash: ['glm_flash', 'GLM-4.7-Flash', 'glm-4.7-flash', '智谱Flash'],
  glm_flashx: ['glm-flashx', 'glm-4.7-flashx', 'flashx', '智谱FlashX'],
  mimo_flash: ['mimo_flash', 'mimo-v2.5-pro', 'mimo-v2.5-pro', 'Mimo Pro', '蜜蜜Pro', 'mimo_v2_5_pro'],
  mimo_omni: ['mimo-omni', 'mimo-v2.5', 'omni', '蜜蜜', 'mimo'],
  mimo_tts: ['mimo_tts', 'mimo-v2.5-tts-voicedesign', 'tts', '语音合成', '蜜蜜语音', 'mimo_voicedesign'],
  qwen_flash: ['qwen_flash', 'Qwen3.5-Flash', 'Qwen', 'qwen3.5-flash', '千问', '通义千问'],
  qwen_turbo: ['qwen-turbo', 'turbo', '千问turbo', '通义千问turbo'],
  glm_4v_flash: ['glm_4v_flash', 'glm-4.6v-flash', '4.6V-Flash', '智谱视觉', '免费视觉'],
  qwen_vl_plus: ['qwen_vl_plus', 'qwen-vl-plus', 'VL-Plus', '通义视觉', '千问视觉'],
  qwen_omni: ['qwen_omni', 'qwen2.5-omni-7b', 'Omni-7B', '通义全模态', '千问全模态']
};

export function calculateSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const set1 = new Set(text1.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 1));
  const set2 = new Set(text2.replace(/[^\w\u4e00-\u9fff]/g, ' ').split(/\s+/).filter(w => w.length > 1));
  if (set1.size === 0 || set2.size === 0) return 0;
  let intersection = 0;
  for (const word of set1) {
    if (set2.has(word)) intersection++;
  }
  return intersection / Math.min(set1.size, set2.size);
}

export function getSenderName(senderType, senderId, currentAiId, userProfile = null) {
  if (senderType === 'user') return userProfile?.nickname || '用户';
  const name = AI_NAMES[senderId] || senderId || '某人';
  const isSelf = senderId === currentAiId;
  return isSelf ? `【你(${name})】` : name;
}

export function formatTime(isoString) {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return '';
  }
}
