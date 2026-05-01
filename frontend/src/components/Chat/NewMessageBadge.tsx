import { useReducedMotion } from '../../hooks/useReducedMotion';

interface NewMessageBadgeProps {
  count: number;
  onClick: () => void;
}

export function NewMessageBadge({ count, onClick }: NewMessageBadgeProps) {
  const reducedMotion = useReducedMotion();
  
  if (count <= 0) return null;

  return (
    <button
      onClick={onClick}
      aria-live="polite"
      className={`absolute bottom-4 right-4 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-full shadow-lg px-4 py-2 flex items-center gap-1.5 hover:from-green-600 hover:to-emerald-600 active:scale-95 transition-all duration-200 z-10 hover:shadow-xl group ${
        !reducedMotion ? 'new-message-badge-pulse' : ''
      }`}
    >
      <svg 
        className={`w-4 h-4 ${!reducedMotion ? 'animate-bounce-subtle' : ''}`} 
        fill="none" 
        stroke="currentColor" 
        viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
      </svg>
      <span className="text-sm font-medium">
        {count}条新消息
      </span>
      {!reducedMotion && (
        <>
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full animate-ping-fast"></span>
          <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full"></span>
        </>
      )}
      {reducedMotion && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full"></span>
      )}
    </button>
  );
}
