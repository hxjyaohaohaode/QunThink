import { memo, useState, useEffect } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { AI_COLORS, AI_NAMES } from '../../types';

interface TypingIndicatorProps {
  aiId: string;
}

export const TypingIndicator = memo(function TypingIndicator({ aiId }: TypingIndicatorProps) {
  const color = AI_COLORS[aiId] || AI_COLORS.system;
  const name = AI_NAMES[aiId] || aiId;
  const reducedMotion = useReducedMotion();
  const [elapsed, setElapsed] = useState(0);

  // 显示思考时间，超过5秒显示"深度思考中"；降频至 2s 并在 reducedMotion 时停用计时
  useEffect(() => {
    if (reducedMotion) return;
    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 2000);
    return () => clearInterval(timer);
  }, [reducedMotion]);

  const thinkingText = elapsed < 5 ? '正在输入' : elapsed < 15 ? '正在思考' : '深度思考中';

  return (
    <div className="typing-indicator-wrapper visible">
      <div className="flex gap-2 items-start">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 shadow-sm"
          style={{ backgroundColor: color }}
        >
          {name.charAt(0)}
        </div>

        <div className="flex flex-col items-start">
          <span className="text-xs font-medium mb-1 ml-1" style={{ color }}>
            {name}
          </span>
          <div className="bg-bg-surface2 rounded-2xl rounded-tl-sm px-4 py-3">
            {reducedMotion ? (
              <div className="flex items-center gap-1">
                <span className="text-sm text-text-muted">{thinkingText}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="typing-indicator">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </div>
                {elapsed >= 5 && (
                  <span className="text-xs text-text-muted ml-1">{thinkingText}{elapsed >= 15 ? ` ${elapsed}s` : ''}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const MultiTypingIndicator = memo(function MultiTypingIndicator({ aiIds }: { aiIds: string[] }) {
  const reducedMotion = useReducedMotion();

  if (aiIds.length === 0) return null;
  
  if (aiIds.length === 1) {
    return <TypingIndicator aiId={aiIds[0]} />;
  }

  return (
    <div className="typing-indicator-wrapper visible">
      <div className="flex items-center gap-3 p-3 bg-bg-surface2 rounded-2xl max-w-[300px]">
        <div className="flex -space-x-2">
          {aiIds.slice(0, 4).map((aiId, index) => {
            const color = AI_COLORS[aiId] || AI_COLORS.system;
            const name = AI_NAMES[aiId] || aiId;
            return (
              <div
                key={aiId}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold ring-2 ring-bg-surface2"
                style={{ 
                  backgroundColor: color,
                  zIndex: aiIds.length - index
                }}
                title={name}
              >
                {name.charAt(0)}
              </div>
            );
          })}
          {aiIds.length > 4 && (
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold bg-text-muted text-white ring-2 ring-bg-surface2">
              +{aiIds.length - 4}
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-2 flex-1">
          <span className="text-sm text-text-secondary">
            {aiIds.length === 2 
              ? `${AI_NAMES[aiIds[0]] || aiIds[0]} 和 ${AI_NAMES[aiIds[1]] || aiIds[1]} 正在输入`
              : `${aiIds.length} 位 AI 正在输入`
            }
          </span>
          {!reducedMotion && (
            <div className="typing-indicator-mini">
              <span className="typing-dot-mini" />
              <span className="typing-dot-mini" />
              <span className="typing-dot-mini" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
