export const AI_NAMES = {
  deepseek: 'deepseek-chat',
  deepseek_reasoner: 'deepseek-reasoner',
  glm_air: 'GLM-4.5-Air',
  glm_flash: 'GLM-4.7-Flash',
  glm_flashx: 'GLM-4.7-FlashX',
  mimo_flash: 'mimo-v2.5',
  mimo_omni: 'mimo-v2-omni',
  mimo_tts: 'mimo-v2-tts',
  qwen_flash: 'Qwen3.5-Flash',
  qwen_turbo: 'qwen-turbo'
};

export const AI_MENTION_ALIASES = {
  deepseek: ['deepseek', 'deepseek-chat', 'DeepSeek', 'deepseek_chat', '深度求索'],
  deepseek_reasoner: ['deepseek_reasoner', 'deepseek-reasoner', 'DeepSeek Reasoner', 'DeepSeek_Reasoner', 'reasoner', '推理版'],
  glm_air: ['glm_air', 'GLM-4.5-Air', 'GLM', 'glm-4.5-air', '智谱Air'],
  glm_flash: ['glm_flash', 'GLM-4.7-Flash', 'glm-4.7-flash', '智谱Flash'],
  glm_flashx: ['glm-flashx', 'glm-4.7-flashx', 'flashx', '智谱FlashX'],
  mimo_flash: ['mimo_flash', 'mimo-v2.5', 'mimo-v2-flash', 'Mimo', 'mimo_v2_flash', '蜜蜜'],
  mimo_omni: ['mimo-omni', 'mimo-v2-omni', 'omni', '蜜蜜全能'],
  mimo_tts: ['mimo_tts', 'mimo-v2-tts', 'tts', '语音合成', '蜜蜜语音'],
  qwen_flash: ['qwen_flash', 'Qwen3.5-Flash', 'Qwen', 'qwen3.5-flash', '千问', '通义千问'],
  qwen_turbo: ['qwen-turbo', 'turbo', '千问turbo', '通义千问turbo']
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
