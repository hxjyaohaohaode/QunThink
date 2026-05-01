import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { useAudioStore } from '../../stores/audioStore';
import { getDevUserId } from '../../services/api';
import { resolveBackendAssetUrl } from '../../services/runtimeConfig';

interface AudioPlayerProps {
  messageId: string;
  audioUrl: string;
  duration: number;
  onDelete?: () => void;
}

function buildAudioSrc(rawUrl: string): string {
  let src = rawUrl;

  if (src.startsWith('http')) {
    try {
      const urlObj = new URL(src);
      if (import.meta.env.DEV) {
        urlObj.searchParams.set('userId', getDevUserId());
      }
      return urlObj.toString();
    } catch {
      return rawUrl;
    }
  }

  if (!src.startsWith('/')) {
    src = `/api/tts/audio/${src}`;
  }
  if (!/\.(wav|mp3|ogg|flac|aac|m4a)$/i.test(src)) {
    src = `${src}.wav`;
  }
  src = resolveBackendAssetUrl(src);
  if (import.meta.env.DEV) {
    const sep = src.includes('?') ? '&' : '?';
    src = `${src}${sep}userId=${getDevUserId()}`;
  }

  return src;
}

export const AudioPlayer = memo(function AudioPlayer({ messageId, audioUrl, duration, onDelete }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const srcRef = useRef<string>('');
  const { setAudioPlaying, setAudioTime, setCurrentAudioId, currentAudioId, stopAll } = useAudioStore();
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [actualDuration, setActualDuration] = useState(duration > 0 ? duration : 0);

  useEffect(() => {
    const src = buildAudioSrc(audioUrl);

    if (srcRef.current === src) return;
    srcRef.current = src;

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
      audioRef.current = null;
    }

    const audio = new Audio();
    const isCrossOrigin = src.startsWith('http') && !src.startsWith(window.location.origin);
    if (isCrossOrigin) {
      audio.crossOrigin = 'anonymous';
    }
    audio.preload = 'metadata';
    audio.src = src;
    audioRef.current = audio;
    setAudioError(null);
    setProgress(0);
    setCurrentTime(0);

    const onTimeUpdate = () => {
      if (audio.duration) {
        const pct = (audio.currentTime / audio.duration) * 100;
        setProgress(pct);
        setCurrentTime(audio.currentTime);
        setAudioTime(messageId, audio.currentTime, audio.duration);
      }
    };

    const onEnded = () => {
      setIsPlaying(false);
      setProgress(100);
      setAudioPlaying(messageId, false);
      setCurrentAudioId(null);
    };

    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setActualDuration(audio.duration);
        setAudioTime(messageId, audio.currentTime, audio.duration);
      }
    };

    const onPlay = () => {
      setIsPlaying(true);
      setAudioPlaying(messageId, true);
      setAudioError(null);
    };

    const onPause = () => {
      setIsPlaying(false);
      setAudioPlaying(messageId, false);
    };

    const onError = () => {
      let errorMsg = '未知错误';
      if (audio.error) {
        switch (audio.error.code) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorMsg = '音频加载被中止';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorMsg = '网络错误';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorMsg = '音频解码失败';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '不支持的音频格式';
            break;
          default:
            errorMsg = `错误代码: ${audio.error.code}`;
        }
      }
      setAudioError(errorMsg);
      setIsPlaying(false);
      setAudioPlaying(messageId, false);
      setCurrentAudioId(null);
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [audioUrl, messageId, setAudioPlaying, setAudioTime, setCurrentAudioId]);

  useEffect(() => {
    if (currentAudioId && currentAudioId !== messageId && isPlaying) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        setIsPlaying(false);
        setAudioPlaying(messageId, false);
      }
    }
  }, [currentAudioId, messageId, isPlaying, setAudioPlaying]);

  const handlePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      stopAll();
      setCurrentAudioId(messageId);
      setAudioError(null);
      
      if (audio.readyState < 2) {
        audio.load();
      }
      
      audio.play().catch((error) => {
        setIsPlaying(false);
        setAudioPlaying(messageId, false);
        setCurrentAudioId(null);
        if (error.name === 'NotAllowedError') {
          setAudioError('请点击播放按钮开始播放');
        } else {
          setAudioError(error?.message || '音频播放失败');
        }
      });
    }
  }, [messageId, setAudioPlaying, setCurrentAudioId, stopAll]);

  const handlePause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    setIsPlaying(false);
    setAudioPlaying(messageId, false);
  }, [messageId, setAudioPlaying]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !audio.duration) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const pct = clickX / rect.width;
    audio.currentTime = pct * audio.duration;
    setProgress(pct * 100);
    setCurrentTime(audio.currentTime);
  }, []);

  const handleDelete = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    setIsPlaying(false);
    setAudioPlaying(messageId, false);
    if (currentAudioId === messageId) {
      setCurrentAudioId(null);
    }
    onDelete?.();
    setShowDeleteConfirm(false);
  }, [messageId, setAudioPlaying, currentAudioId, setCurrentAudioId, onDelete]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const preferredDuration = actualDuration > 0 ? actualDuration : duration;
  const sanitizedDuration = (preferredDuration > 0 && preferredDuration < 600) ? preferredDuration : 0;
  const displayDuration = sanitizedDuration > 0 ? sanitizedDuration : 5;

  return (
    <div className="flex items-center gap-2 mt-3 group/audio">
      {audioError ? (
        <div className="flex items-center gap-2 bg-red-900/40 backdrop-blur-sm rounded-xl px-3.5 py-2 min-w-[160px] max-w-[280px]">
          <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
          <span className="text-red-300 text-xs">{audioError}</span>
          <button
            onClick={() => { setAudioError(null); handlePlay(); }}
            className="ml-auto text-xs text-red-300 hover:text-red-200 underline"
          >
            重试
          </button>
        </div>
      ) : (
      <div className="flex items-center gap-2.5 bg-bg-surface3 backdrop-blur-sm rounded-xl px-3.5 py-2 min-w-[160px] max-w-[280px]">
        <button
          onClick={isPlaying ? handlePause : handlePlay}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/25 hover:bg-white/40 text-white transition-all flex-shrink-0 shadow-sm"
          title={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? (
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1 flex flex-col gap-1.5 min-w-0">
          <div
            className="w-full h-2 bg-white/20 rounded-full cursor-pointer relative group/progress"
            onClick={handleSeek}
          >
            <div
              className="h-full bg-indigo-400 rounded-full relative transition-all"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-md opacity-0 group-hover/progress:opacity-100 transition-opacity" />
            </div>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-xs text-white/75 font-medium">{formatTime(currentTime)}</span>
            <span className="text-xs text-white/75 font-medium">{formatTime(displayDuration)}</span>
          </div>
        </div>
      </div>
      )}

      <div className="flex items-center gap-1 opacity-0 group-hover/audio:opacity-100 transition-opacity">
        <span className="text-xs text-text-muted">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z" /></svg> {formatTime(displayDuration)}
        </span>
        {onDelete && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1 text-text-muted hover:text-red-500 transition-colors"
            title="删除语音"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-bg-surface rounded-lg p-4 w-64 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text-primary mb-2">删除语音</h3>
            <p className="text-xs text-text-muted mb-4">确定要删除这条语音吗？删除后无法恢复。</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-surface2 rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
