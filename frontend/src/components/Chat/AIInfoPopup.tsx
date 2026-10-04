import { useEffect, useMemo, useState } from 'react';
import { usePersonasStore } from '../../stores/personasStore';
import { useModelsStore } from '../../stores/modelsStore';
import { AI_AVATAR_LETTERS, AI_COLORS, AI_NAMES } from '../../types';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

interface AIInfoPopupProps {
  aiId: string;
  isOpen: boolean;
  onClose: () => void;
  position?: { x: number; y: number };
}

export function AIInfoPopup({ aiId, isOpen, onClose, position }: AIInfoPopupProps) {
  const personas = usePersonasStore((s) => s.personas);
  const catalog = useModelsStore((s) => s.catalog);
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
  const model = catalog?.models.find(item => item.id === aiId);
  const provider = catalog?.providers.find(item => item.id === model?.providerId);
  const modelInfo = {
    model: model?.model || aiId,
    provider: provider?.name || '未配置服务商',
    description: model
      ? `已配置能力：${model.capabilities.join('、')}。${model.ready ? '连接已就绪。' : '连接尚未就绪。'}`
      : '此模型不在当前目录中，可能是历史会话成员。',
  };

  const displayName = persona?.name || model?.name || AI_NAMES[aiId] || aiId;
  const avatarColor = persona?.color || model?.color || AI_COLORS[aiId] || '#6b7280';
  const avatarUrl = persona?.avatar_url;
  const avatarLetter = (AI_AVATAR_LETTERS[aiId] || displayName[0] || '?').toUpperCase();
  const expertise = useMemo(() => persona?.expertise || [], [persona?.expertise]);
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
        className="fixed z-50 w-80 rounded-2xl border border-border-subtle bg-bg-surface p-4 shadow-2xl popover-content"
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
