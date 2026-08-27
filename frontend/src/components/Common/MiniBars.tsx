import { useMemo } from 'react';

interface MiniBarsProps {
  data: { date: string; count: number }[];
  height?: number;
  className?: string;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function formatTooltipLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${parsed.getMonth() + 1}/${parsed.getDate()} 周${WEEKDAY_LABELS[parsed.getDay()]}`;
}

const MINI_BARS_STYLE = `
@keyframes minibar-grow {
  from { transform: scaleY(0); }
  to { transform: scaleY(1); }
}
.minibar-grow {
  transform-origin: bottom;
  animation: minibar-grow 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@media (prefers-reduced-motion: reduce) {
  .minibar-grow { animation: none; }
}
`;

export function MiniBars({ data, height = 96, className }: MiniBarsProps) {
  const maxCount = useMemo(
    () => data.reduce((max, item) => Math.max(max, item.count), 1),
    [data]
  );

  if (data.length === 0) return null;

  const lastIndex = data.length - 1;

  return (
    <div className={className} role="img" aria-label={`每日消息活跃柱状图，共 ${data.length} 天`}>
      <style>{MINI_BARS_STYLE}</style>
      <div className="flex items-end gap-[3px] w-full" style={{ height }}>
        {data.map((item, index) => {
          const ratio = item.count / maxCount;
          const barHeight = Math.max(5, Math.round(ratio * 100));
          const tooltipAlign =
            index === 0
              ? 'left-0 translate-x-0'
              : index === lastIndex
                ? 'right-0 left-auto translate-x-0'
                : 'left-1/2 -translate-x-1/2';
          return (
            <div
              key={`${item.date}-${index}`}
              className="group/bar relative flex-1 min-w-0 h-full flex flex-col justify-end cursor-default"
            >
              <div
                className={`pointer-events-none absolute bottom-full mb-1.5 ${tooltipAlign} hidden group-hover/bar:block z-20 whitespace-nowrap rounded-md bg-neutral-800 dark:bg-neutral-700 text-white text-[10px] leading-none px-1.5 py-1 shadow-lg`}
              >
                {formatTooltipLabel(item.date)} · {item.count} 条
              </div>
              <div
                className={`w-full rounded-t-[3px] bg-accent/60 hover:bg-accent transition-colors ${
                  item.count > 0 ? 'minibar-grow' : ''
                }`}
                style={{
                  height: `${barHeight}%`,
                  animationDelay: `${Math.min(index * 25, 600)}ms`
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1.5 text-[10px] text-text-muted">
        <span>{formatTooltipLabel(data[0].date)}</span>
        <span>{formatTooltipLabel(data[lastIndex].date)}</span>
      </div>
    </div>
  );
}
