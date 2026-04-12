interface NewMessageBadgeProps {
  count: number;
  onClick: () => void;
}

export function NewMessageBadge({ count, onClick }: NewMessageBadgeProps) {
  if (count <= 0) return null;

  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 right-4 bg-green-500 text-white rounded-full shadow-lg px-4 py-2 flex items-center gap-1.5 hover:bg-green-600 active:bg-green-700 transition-all duration-200 z-10 hover:shadow-xl"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
      </svg>
      <span className="text-sm font-medium">
        {count}条新消息
      </span>
    </button>
  );
}
