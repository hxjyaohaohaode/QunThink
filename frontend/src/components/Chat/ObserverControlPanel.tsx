import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../services/api';
import { useToast } from '../Common';

interface ObserverControlPanelProps {
  groupId: string;
  topic?: string;
}

export function ObserverControlPanel({ groupId, topic }: ObserverControlPanelProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    if (isRunning) {
      timerRef.current = setInterval(() => {
        setElapsed(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setElapsed(0);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isRunning]);

  useEffect(() => {
    return () => {
      if (isRunning) {
        api.stopAIPrivateChat(groupId).catch(() => {});
      }
    };
  }, [groupId]);

  const handleStart = useCallback(async () => {
    setIsStarting(true);
    try {
      await api.startAIPrivateChat(groupId);
      setIsRunning(true);
      showToast({ message: 'AI 私聊已开始', type: 'success' });
    } catch {
      showToast({ message: '启动失败，请重试', type: 'error' });
    } finally {
      setIsStarting(false);
    }
  }, [groupId, showToast]);

  const handleStop = useCallback(async () => {
    try {
      await api.stopAIPrivateChat(groupId);
      setIsRunning(false);
      showToast({ message: 'AI 私聊已停止', type: 'info' });
    } catch {
      setIsRunning(false);
    }
  }, [groupId, showToast]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex-shrink-0 border-t border-border bg-bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isRunning ? 'bg-green-500 animate-pulse' : 'bg-text-muted'}`} />
            <span className="text-xs text-text-secondary whitespace-nowrap">
              {isRunning ? '对话中' : '已停止'}
            </span>
          </div>
          {isRunning && (
            <span className="text-xs text-text-muted font-mono tabular-nums">
              {formatTime(elapsed)}
            </span>
          )}
          {topic && (
            <span className="text-xs text-text-muted truncate hidden sm:inline">
              主题：{topic}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {!isRunning ? (
            <button
              onClick={handleStart}
              disabled={isStarting}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg transition-all duration-200 disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5.14v14l11-7-11-7z" />
              </svg>
              {isStarting ? '启动中...' : '开始对话'}
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-medium rounded-lg border border-red-500/20 transition-all duration-200"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M6 6h12v12H6z" />
              </svg>
              停止对话
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-text-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
        <p className="text-[10px] text-text-muted leading-relaxed">
          旁观模式 · 你只能观看 AI 之间的对话，无法发送消息。切换离开将自动停止对话。
        </p>
      </div>
    </div>
  );
}
