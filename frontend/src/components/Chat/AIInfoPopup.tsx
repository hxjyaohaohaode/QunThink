import { useEffect, useMemo, useState } from 'react';
import { usePersonasStore } from '../../stores/personasStore';
import { AI_AVATAR_LETTERS, AI_COLORS, AI_NAMES } from '../../types';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

interface AIInfoPopupProps {
  aiId: string;
  isOpen: boolean;
  onClose: () => void;
  position?: { x: number; y: number };
}

const AI_MODEL_INFO: Record<string, { model: string; provider: string; description: string }> = {
  deepseek: {
    model: 'deepseek-chat',
    provider: 'DeepSeek',
    description: '通用对话模型，兼顾逻辑推理、日常问答与代码协助。',
  },
  deepseek_reasoner: {
    model: 'deepseek-reasoner',
    provider: 'DeepSeek',
    description: '推理增强模型，适合复杂分析和多步骤思考。',
  },
  glm_air: {
    model: 'GLM-4.5-Air',
    provider: 'Zhipu AI',
    description: '轻量级对话模型，适合日常助手类任务。',
  },
  glm_flash: {
    model: 'GLM-4.7-Flash',
    provider: 'Zhipu AI',
    description: '低延迟快速响应模型，适合高频常规对话。',
  },
  glm_flashx: {
    model: 'GLM-4.7-FlashX',
    provider: 'Zhipu AI',
    description: '增强版快速模型，具备更强的分析和上下文处理能力。',
  },
  mimo_flash: {
    model: 'mimo-v2.5',
    provider: 'Mimo',
    description: '最新版 MiMo 模型，速度与质量兼顾，回复简洁直接。',
  },
  mimo_omni: {
    model: 'mimo-v2-omni',
    provider: 'Mimo',
    description: '多模态模型，适合理解跨文本与媒体信息。',
  },
  mimo_tts: {
    model: 'mimo-v2-tts',
    provider: 'Mimo',
    description: '语音合成模型，可将文本转成自然流畅的语音。',
  },
  qwen_flash: {
    model: 'Qwen3.5-Flash',
    provider: 'Alibaba Cloud',
    description: '快速版通义模型，知识覆盖广、响应速度快。',
  },
  qwen_turbo: {
    model: 'qwen-turbo',
    provider: 'Alibaba Cloud',
    description: '通用加速模型，适合高响应要求的助手场景。',
  },
};

export function AIInfoPopup({ aiId, isOpen, onClose, position }: AIInfoPopupProps) {
  const { personas } = usePersonasStore();
  const [adjustedPosition, setAdjustedPosition] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isOpen || !position) {
      setAdjustedPosition(null);
      return;
    }
    const width = 320;
    const height = 380;
    setAdjustedPosition({
      x: Math.max(12, Math.min(position.x, window.innerWidth - width - 12)),
      y: Math.max(12, Math.min(position.y, window.innerHeight - height - 12)),
    });
  }, [isOpen, position]);

  const persona = personas[aiId];
  const modelInfo = AI_MODEL_INFO[aiId] || {
    model: aiId,
    provider: '未知',
    description: '暂无额外模型说明。',
  };

  const displayName = persona?.name || AI_NAMES[aiId] || aiId;
  const avatarColor = persona?.color || AI_COLORS[aiId] || '#6b7280';
  const avatarUrl = persona?.avatar_url;
  const avatarLetter = (AI_AVATAR_LETTERS[aiId] || displayName[0] || '?').toUpperCase();
  const expertise = persona?.expertise || [];
  const summary = useMemo(() => ({
    style: persona?.style || '默认风格',
    personality: persona?.personality || '友好、乐于助人。',
    replyStyle: persona?.replyStyle || '自然对话',
  }), [persona?.personality, persona?.replyStyle, persona?.style]);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-80 rounded-2xl border border-border-subtle bg-bg-surface p-4 shadow-2xl"
        style={{
          left: adjustedPosition ? `${adjustedPosition.x}px` : '50%',
          top: adjustedPosition ? `${adjustedPosition.y}px` : '50%',
          transform: adjustedPosition ? 'none' : 'translate(-50%, -50%)',
        }}
      >
        <div className="mb-4 flex items-start gap-3 border-b border-border-subtle pb-4">
          <div
            className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-semibold text-white"
            style={{
              backgroundColor: avatarUrl ? 'transparent' : avatarColor,
              backgroundImage: avatarUrl ? `url(${sanitizeUrl(avatarUrl)})` : 'none',
              backgroundPosition: 'center',
              backgroundSize: 'cover',
            }}
          >
            {!avatarUrl && avatarLetter}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold text-text-primary">{displayName}</div>
            <div className="text-sm text-text-muted">{modelInfo.provider}</div>
            <div className="mt-1 text-xs text-text-muted">{modelInfo.model}</div>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">关闭</button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <div className="mb-1 text-xs font-medium tracking-wide text-text-muted">风格</div>
            <div className="text-text-primary">{summary.style}</div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium tracking-wide text-text-muted">性格</div>
            <div className="text-text-primary">{summary.personality}</div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium tracking-wide text-text-muted">回复风格</div>
            <div className="text-text-primary">{summary.replyStyle}</div>
          </div>
          {expertise.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium tracking-wide text-text-muted">擅长领域</div>
              <div className="flex flex-wrap gap-2">
                {expertise.map((item) => (
                  <span key={item} className="rounded-full bg-bg-surface2 px-2 py-1 text-xs text-text-secondary">{item}</span>
                ))}
              </div>
            </div>
          )}
          <div className="rounded-xl bg-bg-surface2 p-3 text-xs leading-6 text-text-secondary">
            {modelInfo.description}
          </div>
        </div>
      </div>
    </>
  );
}
