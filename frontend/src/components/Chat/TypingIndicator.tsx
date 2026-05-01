import { memo } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { AI_COLORS, AI_NAMES } from '../../types';

interface TypingIndicatorProps {
  aiId: string;
}

export const TypingIndicator = memo(function TypingIndicator({ aiId }: TypingIndicatorProps) {
  const color = AI_COLORS[aiId] || AI_COLORS.system;
  const name = AI_NAMES[aiId] || aiId;
  const reducedMotion = useReducedMotion();

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
                <span className="text-sm text-text-muted">正在输入</span>
              </div>
            ) : (
              <div className="typing-indicator">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
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
