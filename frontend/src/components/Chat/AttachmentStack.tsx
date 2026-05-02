import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { MessageAttachment } from '../../types';
import { sanitizeUrl } from '../../utils/sanitizeUrl';

interface AttachmentStackProps {
  attachments: MessageAttachment[];
  isUser?: boolean;
  onPreview?: (attachment: MessageAttachment, index: number) => void;
  onDelete?: (attachmentId: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

const STACK_THRESHOLD = 2;
const VISIBLE_STACK_LAYERS = 3;
const SWIPE_THRESHOLD_MIN = 48;
const SWIPE_THRESHOLD_MAX = 64;
const LIGHTBOX_Z_INDEX = 9999;
const STACK_CARD_WIDTH = 252;
const STACK_CARD_HEIGHT = 176;
const STACK_FRONT_CARD_WIDTH = 224;
const STACK_FRONT_CARD_HEIGHT = 168;
const STACK_FRONT_CARD_LEFT = 14;
const STACK_FRONT_CARD_TOP = 4;

function getSwipeThreshold() {
  return Math.max(SWIPE_THRESHOLD_MIN, Math.min(SWIPE_THRESHOLD_MAX, STACK_CARD_WIDTH * 0.18));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

export function getFileTypeIcon(type: string): { icon: string; color: string; svg: (size?: number) => JSX.Element } {
  const size = 24;
  const svgs: Record<string, () => JSX.Element> = {
    image: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21,15 16,10 5,21" />
      </svg>
    ),
    video: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23,7 16,12 23,17 23,7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    ),
    audio: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
    ),
    pdf: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /><line x1="8" y1="9" x2="10" y2="9" />
      </svg>
    ),
    doc: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10,9 9,9 8,9" />
      </svg>
    ),
    xls: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /><path d="M12 9L8 13" />
      </svg>
    ),
    ppt: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" /><rect x="8" y="12" width="8" height="5" rx="1" /><line x1="10" y1="15" x2="14" y2="15" />
      </svg>
    ),
    archive: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="21,8 21,21 3,21 3,8" /><rect x="1" y="3" width="22" height="5" /><line x1="10" y1="12" x2="14" y2="12" />
      </svg>
    ),
    code: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16,18 22,12 16,6" /><polyline points="8,6 2,12 8,18" />
      </svg>
    ),
    file: () => (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14,2 14,8 20,8" />
      </svg>
    ),
  };

  if (type.startsWith('image/')) return { icon: 'image', color: '#10b981', svg: svgs.image };
  if (type.startsWith('video/')) return { icon: 'video', color: '#f59e0b', svg: svgs.video };
  if (type.startsWith('audio/')) return { icon: 'audio', color: '#8b5cf6', svg: svgs.audio };
  if (type.includes('pdf')) return { icon: 'pdf', color: '#ef4444', svg: svgs.pdf };
  if (type.includes('word') || type.includes('document') || type.includes('doc')) return { icon: 'doc', color: '#3b82f6', svg: svgs.doc };
  if (type.includes('excel') || type.includes('spreadsheet') || type.includes('xls')) return { icon: 'xls', color: '#22c55e', svg: svgs.xls };
  if (type.includes('powerpoint') || type.includes('presentation') || type.includes('ppt')) return { icon: 'ppt', color: '#f97316', svg: svgs.ppt };
  if (type.includes('zip') || type.includes('rar') || type.includes('7z') || type.includes('tar') || type.includes('gz')) return { icon: 'archive', color: '#6b7280', svg: svgs.archive };
  if (type.includes('javascript') || type.includes('typescript') || type.includes('python') || type.includes('java') || type.includes('html') || type.includes('css')) return { icon: 'code', color: '#a855f7', svg: svgs.code };
  return { icon: 'file', color: '#6b7280', svg: svgs.file };
}

function isImageType(type: string) { return type?.startsWith('image/'); }
function isVideoType(type: string) { return type?.startsWith('video/'); }
function isAudioType(type: string) { return type?.startsWith('audio/'); }

function getCollapsedTitle(attachment: MessageAttachment | undefined, total: number): string {
  if (!attachment) return '附件';
  if (total > 1) {
    if (isImageType(attachment.type)) return `${total} 张图片`;
    if (isVideoType(attachment.type)) return `${total} 个视频`;
    if (isAudioType(attachment.type)) return `${total} 段音频`;
    return `${total} 个附件`;
  }

  if (isImageType(attachment.type)) return '图片附件';
  if (isVideoType(attachment.type)) return '视频附件';
  if (isAudioType(attachment.type)) return '音频附件';
  return attachment.name || '文件附件';
}

function getCollapsedSubtitle(attachment: MessageAttachment | undefined): string {
  if (!attachment) return '轻触查看';
  const description = (attachment.media_description || '').trim();
  if (description && !description.startsWith('[')) {
    return description.length > 24 ? `${description.slice(0, 24)}...` : description;
  }

  if (isImageType(attachment.type)) return '轻触查看大图';
  if (isVideoType(attachment.type)) return '轻触播放内容';
  if (isAudioType(attachment.type)) return '轻触播放音频';
  return formatFileSize(attachment.size);
}

const LightboxModal: React.FC<{
  attachments: MessageAttachment[];
  initialIndex: number;
  isUser: boolean;
  onClose: () => void;
  onDelete?: (attachmentId: string) => void;
}> = ({ attachments, initialIndex, onClose, onDelete }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [showControls, setShowControls] = useState(true);
  const [isZoomed, setIsZoomed] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const current = attachments[currentIndex];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          setCurrentIndex(prev => Math.max(0, prev - 1));
          setIsZoomed(false);
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
          break;
        case 'ArrowRight':
          setCurrentIndex(prev => Math.min(attachments.length - 1, prev + 1));
          setIsZoomed(false);
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
          break;
        case '+':
        case '=':
          setZoomScale(prev => Math.min(5, prev * 1.2));
          setIsZoomed(true);
          break;
        case '-':
          setZoomScale(prev => {
            const next = prev / 1.2;
            if (next <= 1) {
              setIsZoomed(false);
              return 1;
            }
            return next;
          });
          break;
        case '0':
          setIsZoomed(false);
          setZoomScale(1);
          setPanOffset({ x: 0, y: 0 });
          break;
        case 'Delete':
        case 'Backspace':
          if (onDelete && current) {
            onDelete(current.id);
            if (attachments.length <= 1) onClose();
            else setCurrentIndex(prev => Math.min(prev, attachments.length - 2));
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [attachments.length, current, onClose, onDelete]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = setTimeout(() => setShowControls(false), 3000);
  }, []);

  useEffect(() => {
    resetControlsTimer();
    return () => { if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current); };
  }, [currentIndex, resetControlsTimer]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!isImageType(current?.type || '')) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setZoomScale(prev => {
      const next = prev * delta;
      if (next <= 1) { setIsZoomed(false); return 1; }
      if (next >= 5) return 5;
      setIsZoomed(true);
      return next;
    });
  }, [current?.type]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!isZoomed) return;
    setIsPanning(true);
    panStartRef.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
  }, [isZoomed, panOffset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setPanOffset({ x: e.clientX - panStartRef.current.x, y: e.clientY - panStartRef.current.y });
  }, [isPanning]);

  const handleMouseUp = useCallback(() => { setIsPanning(false); }, []);

  const handleDownload = useCallback(() => {
    if (!current?.url) return;
    const a = document.createElement('a');
    a.href = sanitizeUrl(current.url);
    a.download = current.name || 'download';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [current]);

  if (!current) return null;

  return (
    <AnimatePresence>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 bg-black/95 flex items-center justify-center select-none"
        style={{ zIndex: LIGHTBOX_Z_INDEX }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        onMouseMove={resetControlsTimer}
        onWheel={handleWheel}
      >
        <div
          className="relative max-w-[95vw] max-h-[95vh] flex items-center justify-center"
          style={{
            transform: isZoomed ? `scale(${zoomScale}) translate(${panOffset.x / zoomScale}px, ${panOffset.y / zoomScale}px)` : 'scale(1)',
            transition: isPanning ? 'none' : 'transform 0.2s ease-out',
            cursor: isZoomed ? (isPanning ? 'grabbing' : 'grab') : 'default'
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {isImageType(current.type) && current.url && (
            <img
              src={sanitizeUrl(current.url)}
              alt={current.name}
              className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
              draggable={false}
            />
          )}
          {isVideoType(current.type) && current.url && (
            <video
              src={sanitizeUrl(current.url)}
              controls
              className="max-w-[90vw] max-h-[85vh] rounded-lg"
              autoPlay
            />
          )}
          {isAudioType(current.type) && current.url && (
            <div className="flex flex-col items-center gap-6 p-8">
              <div className="w-24 h-24 rounded-full bg-white/10 flex items-center justify-center">
                <svg className="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                </svg>
              </div>
              <p className="text-white text-sm font-medium">{current.name}</p>
              <audio src={sanitizeUrl(current.url)} controls className="w-80" autoPlay />
            </div>
          )}
          {!isImageType(current.type) && !isVideoType(current.type) && !isAudioType(current.type) && (
            <div className="flex flex-col items-center gap-4 p-8 bg-white/10 rounded-2xl max-w-[90vw] max-h-[85vh] overflow-auto">
              {getFileTypeIcon(current.type).svg()}
              <p className="text-white text-sm font-medium max-w-[300px] truncate">{current.name}</p>
              <p className="text-white/60 text-xs">{formatFileSize(current.size)}</p>
              {current.media_description && (
                <div className="w-full max-w-[600px] mt-2 p-4 bg-black/30 rounded-xl text-left overflow-auto max-h-[40vh]">
                  <p className="text-white/80 text-xs whitespace-pre-wrap break-words">{current.media_description}</p>
                </div>
              )}
              {current.url && (
                <a
                  href={sanitizeUrl(current.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm transition-colors"
                >
                  下载文件
                </a>
              )}
            </div>
          )}
        </div>

        <AnimatePresence>
          {showControls && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 pointer-events-none"
            >
              <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent pointer-events-auto">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button onClick={onClose} className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                    <span className="text-white text-sm font-medium">{currentIndex + 1} / {attachments.length}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isImageType(current.type) && (
                      <>
                        <button onClick={() => { setIsZoomed(!isZoomed); setZoomScale(isZoomed ? 1 : 2); setPanOffset({ x: 0, y: 0 }); }} className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors" title={isZoomed ? '缩小 (0)' : '放大 (+)'}>
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                            {isZoomed
                              ? <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM13.5 10.5h-6" />
                              : <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607zM10.5 7.5v6m3-3h-6" />
                            }
                          </svg>
                        </button>
                      </>
                    )}
                    <button onClick={handleDownload} className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors" title="下载">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                    </button>
                    {onDelete && (
                      <button onClick={() => { onDelete(current.id); if (attachments.length <= 1) onClose(); else setCurrentIndex(prev => Math.min(prev, attachments.length - 2)); }} className="w-9 h-9 rounded-full bg-red-500/20 hover:bg-red-500/40 flex items-center justify-center text-red-300 transition-colors" title="删除">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.108 0 00-7.5 0" /></svg>
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-white/80 text-xs mt-2 truncate max-w-[60vw]">{current.name}</p>
              </div>

              {attachments.length > 1 && (
                <>
                  <button onClick={() => { setCurrentIndex(prev => Math.max(0, prev - 1)); setIsZoomed(false); setZoomScale(1); setPanOffset({ x: 0, y: 0 }); }} disabled={currentIndex === 0} className={`absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white transition-all pointer-events-auto ${currentIndex === 0 ? 'opacity-30 cursor-not-allowed' : 'hover:scale-110'}`}>
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                  </button>
                  <button onClick={() => { setCurrentIndex(prev => Math.min(attachments.length - 1, prev + 1)); setIsZoomed(false); setZoomScale(1); setPanOffset({ x: 0, y: 0 }); }} disabled={currentIndex === attachments.length - 1} className={`absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center text-white transition-all pointer-events-auto ${currentIndex === attachments.length - 1 ? 'opacity-30 cursor-not-allowed' : 'hover:scale-110'}`}>
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                  </button>
                </>
              )}

              <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/60 to-transparent pointer-events-auto">
                <div className="flex items-center justify-center gap-2 overflow-x-auto pb-2 scrollbar-thin">
                  {attachments.map((att, idx) => (
                    <button
                      key={att.id}
                      onClick={() => { setCurrentIndex(idx); setIsZoomed(false); setZoomScale(1); setPanOffset({ x: 0, y: 0 }); }}
                      className={`flex-shrink-0 w-12 h-12 rounded-lg overflow-hidden border-2 transition-all ${idx === currentIndex ? 'border-white scale-110' : 'border-white/30 opacity-60 hover:opacity-100'}`}
                    >
                      {isImageType(att.type) && att.url ? (
                        <img src={sanitizeUrl(att.url)} alt="" className="w-full h-full object-cover" draggable={false} />
                      ) : (
                        <div className="w-full h-full bg-white/10 flex items-center justify-center text-lg">
                        {getFileTypeIcon(att.type).svg()}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                <p className="text-white/50 text-[10px] text-center mt-1">← → 切换 · +/- 缩放 · Esc 关闭 · Del 删除</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
};

const BatchActionBar: React.FC<{
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDownloadSelected: () => void;
  onDeleteSelected: () => void;
  onClose: () => void;
}> = ({ selectedCount, totalCount, onSelectAll, onDeselectAll, onDownloadSelected, onDeleteSelected, onClose }) => (
  <motion.div
    initial={{ opacity: 0, y: 20 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 20 }}
    className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-bg-surface2 border border-border/40 shadow-lg"
  >
    <div className="flex items-center gap-2">
      <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-surface3 transition-colors">
        <svg className="w-4 h-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
      <span className="text-xs font-medium text-text-secondary">已选 {selectedCount}/{totalCount}</span>
      <button onClick={selectedCount === totalCount ? onDeselectAll : onSelectAll} className="text-xs text-accent hover:text-accent-hover font-medium transition-colors">
        {selectedCount === totalCount ? '取消全选' : '全选'}
      </button>
    </div>
    <div className="flex items-center gap-1">
      <button onClick={onDownloadSelected} disabled={selectedCount === 0} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
        下载
      </button>
      <button onClick={onDeleteSelected} disabled={selectedCount === 0} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-500 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.108 0 00-7.5 0" /></svg>
        删除
      </button>
    </div>
  </motion.div>
);

const AttachmentItem: React.FC<{
  attachment: MessageAttachment;
  isUser: boolean;
  isExpanded: boolean;
  isSelectMode: boolean;
  isSelected: boolean;
  dragIndex: number;
  dropIndex: number | null;
  onPreview: () => void;
  onToggleSelect: () => void;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  onDelete?: (attachmentId: string) => void;
  index: number;
}> = React.memo(({ attachment, isUser, isExpanded, isSelectMode, isSelected, dragIndex, dropIndex, onPreview, onToggleSelect, onDragStart, onDragOver, onDragEnd, onDelete, index }) => {
  const isImage = isImageType(attachment.type);
  const isVideo = isVideoType(attachment.type);
  const isAudio = isAudioType(attachment.type);
  const fileSize = formatFileSize(attachment.size);
  const { color } = getFileTypeIcon(attachment.type);

  const isDragging = dragIndex === index;
  const isDropTarget = dropIndex === index;

  return (
    <div
      className={`relative group/att overflow-hidden rounded-[24px] border border-border/15 bg-white/72 shadow-[0_14px_34px_rgba(15,23,42,0.08)] backdrop-blur-md transition-all duration-200 ${
        isExpanded ? 'cursor-pointer' : ''
      } ${isDragging ? 'opacity-40 scale-95' : ''} ${
        isDropTarget ? 'ring-2 ring-accent ring-offset-1' : ''
      } ${isSelectMode && isSelected ? 'ring-2 ring-accent' : ''}`}
      draggable={isExpanded && !isSelectMode}
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDragEnd={onDragEnd}
    >
      {isSelectMode && (
        <div
          className="absolute top-1.5 left-1.5 z-20 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all cursor-pointer"
          style={{
            backgroundColor: isSelected ? 'var(--accent)' : 'rgba(255,255,255,0.8)',
            borderColor: isSelected ? 'var(--accent)' : 'rgba(0,0,0,0.2)'
          }}
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
        >
          {isSelected && (
            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
        </div>
      )}

      {isImage && attachment.url ? (
        <div className="relative" onClick={isSelectMode ? onToggleSelect : onPreview}>
          <img
            src={sanitizeUrl(attachment.url)}
            alt={attachment.name}
            className={`w-full object-cover ${isExpanded ? 'aspect-[4/3] min-h-[190px]' : 'h-full max-h-[200px]'}`}
            loading="lazy"
            draggable={false}
          />
          <div className={`absolute inset-0 transition-opacity ${isExpanded ? 'bg-gradient-to-t from-black/22 via-transparent to-white/10 opacity-100' : 'bg-gradient-to-t from-black/34 via-black/0 to-transparent opacity-80 group-hover/att:opacity-100'}`} />
          {attachment.media_description && !isExpanded && (
            <div className="absolute inset-x-0 bottom-0 p-2.5">
              <p className="rounded-2xl bg-black/42 px-2.5 py-1.5 text-[10px] text-white/95 shadow-sm backdrop-blur-md line-clamp-2">{attachment.media_description}</p>
            </div>
          )}
        </div>
      ) : isVideo && attachment.url ? (
        <div
          className={`flex flex-col gap-1 px-3 py-3 rounded-[18px] text-xs ${isUser ? 'bg-white/20 text-white' : 'bg-bg-surface2/80 text-text-secondary'}`}
          onClick={isSelectMode ? onToggleSelect : onPreview}
        >
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}20` }}>
              <svg className="w-4 h-4" fill="none" stroke={color} viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-medium">{attachment.name}</span>
              <span className="opacity-60 text-[10px]">{fileSize}</span>
            </div>
          </div>
          {attachment.media_description && !attachment.media_description.startsWith('[') && (
            <p className="line-clamp-2 text-[10px] leading-4 opacity-80 pl-10">{attachment.media_description}</p>
          )}
        </div>
      ) : isAudio && attachment.url ? (
        <div
          className={`flex flex-col gap-1 px-3 py-3 rounded-[18px] text-xs ${isUser ? 'bg-white/20 text-white' : 'bg-bg-surface2/80 text-text-secondary'}`}
          onClick={isSelectMode ? onToggleSelect : onPreview}
        >
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${color}20` }}>
              <svg className="w-4 h-4" fill="none" stroke={color} viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-medium">{attachment.name}</span>
              <span className="opacity-60 text-[10px]">{fileSize}</span>
            </div>
          </div>
          {attachment.media_description && !attachment.media_description.startsWith('[') && (
            <p className="line-clamp-2 text-[10px] leading-4 opacity-80 pl-10">{attachment.media_description}</p>
          )}
        </div>
      ) : (
        <div
          className={`flex flex-col gap-1 px-3 py-3 rounded-[18px] text-xs ${isUser ? 'bg-white/20 text-white' : 'bg-bg-surface2/80 text-text-secondary'}`}
          onClick={isSelectMode ? onToggleSelect : onPreview}
        >
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-base" style={{ backgroundColor: `${color}20` }}>
              {getFileTypeIcon(attachment.type).svg(16)}
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="truncate font-medium">{attachment.name}</span>
              <span className="opacity-60 text-[10px]">{fileSize}</span>
            </div>
          </div>
          {attachment.media_description && !attachment.media_description.startsWith('[') && (
            <p className="line-clamp-2 text-[10px] leading-4 opacity-80 pl-10">{attachment.media_description}</p>
          )}
        </div>
      )}

      {isExpanded && (
        <div className="border-t border-border/10 bg-white/72 px-3 py-2 backdrop-blur-md">
          <div className="truncate text-[11px] font-medium text-text-primary">{attachment.name}</div>
          <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-text-muted">
            <span className="truncate">{fileSize}</span>
            <span className="truncate">{attachment.type.split('/')[0] || '文件'}</span>
          </div>
          {attachment.media_description && (
            <div className="mt-1.5 rounded-lg bg-bg-surface2/60 px-2 py-1.5">
              <p className="text-[10px] font-medium text-text-muted mb-0.5">AI 识别内容</p>
              <p className="text-[10px] leading-4 text-text-secondary whitespace-pre-wrap break-words">{attachment.media_description}</p>
            </div>
          )}
        </div>
      )}

      {onDelete && isExpanded && !isSelectMode && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(attachment.id);
          }}
          className="absolute right-2 top-2 z-20 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white opacity-0 shadow-sm backdrop-blur-md transition-all hover:bg-red-500/90 group-hover/att:opacity-100"
          title="移除附件"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
});

export const AttachmentStack: React.FC<AttachmentStackProps> = ({
  attachments,
  isUser = false,
  onPreview,
  onDelete,
  onReorder
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showLightbox, setShowLightbox] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);

  const stackRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef(0);
  const touchStartYRef = useRef(0);
  const gestureStartAtRef = useRef(0);
  const swipeIntentRef = useRef(false);
  const swipeOffsetFrameRef = useRef<number | null>(null);
  const pendingSwipeOffsetRef = useRef(0);
  const suppressPreviewClickRef = useRef(false);

  const swipeThreshold = useMemo(() => getSwipeThreshold(), []);
  const setSwipeOffsetSmooth = useCallback((nextOffset: number) => {
    pendingSwipeOffsetRef.current = nextOffset;
    if (swipeOffsetFrameRef.current !== null) {
      return;
    }

    swipeOffsetFrameRef.current = window.requestAnimationFrame(() => {
      swipeOffsetFrameRef.current = null;
      setSwipeOffset(pendingSwipeOffsetRef.current);
    });
  }, []);

  const resetSwipeOffsetSmooth = useCallback(() => {
    pendingSwipeOffsetRef.current = 0;
    if (swipeOffsetFrameRef.current !== null) {
      window.cancelAnimationFrame(swipeOffsetFrameRef.current);
      swipeOffsetFrameRef.current = null;
    }
    setSwipeOffset(0);
  }, []);

  const shouldStack = attachments.length >= STACK_THRESHOLD;

  const handleOpenLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
    setShowLightbox(true);
    onPreview?.(attachments[index], index);
  }, [attachments, onPreview]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!shouldStack || isExpanded) return;
    const touch = e.touches[0];
    touchStartXRef.current = touch.clientX;
    touchStartYRef.current = touch.clientY;
    gestureStartAtRef.current = Date.now();
    swipeIntentRef.current = false;
    resetSwipeOffsetSmooth();
    setIsSwiping(false);
  }, [shouldStack, isExpanded, resetSwipeOffsetSmooth]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!shouldStack || isExpanded) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartXRef.current;
    const dy = touch.clientY - touchStartYRef.current;

    if (!swipeIntentRef.current && Math.abs(dx) > 8 && Math.abs(dx) / Math.max(Math.abs(dy), 1) > 1.35) {
      swipeIntentRef.current = true;
      setIsSwiping(true);
    }

    if (swipeIntentRef.current) {
      e.preventDefault();
      setSwipeOffsetSmooth(dx);
    }
  }, [shouldStack, isExpanded, setSwipeOffsetSmooth]);

  const handleTouchEnd = useCallback(() => {
    const elapsed = Math.max(Date.now() - gestureStartAtRef.current, 1);
    const velocityX = Math.abs(swipeOffset) / elapsed;
    const reachedThreshold = Math.abs(swipeOffset) >= swipeThreshold;
    const isFastSwipe = velocityX > 0.35;

    if (!swipeIntentRef.current) {
      setIsSwiping(false);
      resetSwipeOffsetSmooth();
      return;
    }

    if ((reachedThreshold || isFastSwipe) && swipeOffset < 0 && currentIndex < attachments.length - 1) {
      suppressPreviewClickRef.current = true;
      setCurrentIndex(prev => prev + 1);
    } else if ((reachedThreshold || isFastSwipe) && swipeOffset > 0 && currentIndex > 0) {
      suppressPreviewClickRef.current = true;
      setCurrentIndex(prev => prev - 1);
    }

    swipeIntentRef.current = false;
    setIsSwiping(false);
    resetSwipeOffsetSmooth();
  }, [swipeOffset, swipeThreshold, currentIndex, attachments.length, resetSwipeOffsetSmooth]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!shouldStack || isExpanded) return;
    touchStartXRef.current = e.clientX;
    touchStartYRef.current = e.clientY;
    gestureStartAtRef.current = Date.now();
    swipeIntentRef.current = false;
    resetSwipeOffsetSmooth();
    setIsSwiping(false);

    const handleMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - touchStartXRef.current;
      const dy = ev.clientY - touchStartYRef.current;
      if (!swipeIntentRef.current && Math.abs(dx) > 8 && Math.abs(dx) / Math.max(Math.abs(dy), 1) > 1.35) {
        swipeIntentRef.current = true;
        setIsSwiping(true);
      }
      if (swipeIntentRef.current) {
        setSwipeOffsetSmooth(dx);
      }
    };

    const handleMouseUp = (ev: MouseEvent) => {
      const dx = ev.clientX - touchStartXRef.current;
      const elapsed = Math.max(Date.now() - gestureStartAtRef.current, 1);
      const velocityX = Math.abs(dx) / elapsed;
      const reachedThreshold = Math.abs(dx) >= swipeThreshold;
      const isFastSwipe = velocityX > 0.35;
      if (swipeIntentRef.current && (reachedThreshold || isFastSwipe)) {
        if (dx < 0 && currentIndex < attachments.length - 1) {
          suppressPreviewClickRef.current = true;
          setCurrentIndex(prev => prev + 1);
        } else if (dx > 0 && currentIndex > 0) {
          suppressPreviewClickRef.current = true;
          setCurrentIndex(prev => prev - 1);
        }
      }
      swipeIntentRef.current = false;
      setIsSwiping(false);
      resetSwipeOffsetSmooth();
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [shouldStack, isExpanded, swipeThreshold, currentIndex, attachments.length, resetSwipeOffsetSmooth, setSwipeOffsetSmooth]);

  useEffect(() => {
    return () => {
      if (swipeOffsetFrameRef.current !== null) {
        window.cancelAnimationFrame(swipeOffsetFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isExpanded || isSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isExpanded) {
        setIsExpanded(false);
        setCurrentIndex(0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isExpanded, isSelectMode]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(attachments.map(a => a.id)));
  }, [attachments]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleDownloadSelected = useCallback(() => {
    attachments.filter(a => selectedIds.has(a.id) && a.url).forEach(a => {
      const link = document.createElement('a');
      link.href = sanitizeUrl(a.url!);
      link.download = a.name;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
  }, [attachments, selectedIds]);

  const handleDeleteSelected = useCallback(() => {
    selectedIds.forEach(id => onDelete?.(id));
    setSelectedIds(new Set());
    setIsSelectMode(false);
  }, [selectedIds, onDelete]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    if (!onReorder) return;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, [onReorder]);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (!onReorder || dragIndex === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }, [onReorder, dragIndex]);

  const handleDragEnd = useCallback(() => {
    if (onReorder && dragIndex !== null && dropIndex !== null && dragIndex !== dropIndex) {
      onReorder(dragIndex, dropIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [onReorder, dragIndex, dropIndex]);

  const stackedLayers = useMemo(() => {
    if (!shouldStack || isExpanded) return [];
    const layers: { attachment: MessageAttachment; offsetX: number; offsetY: number; zIndex: number; opacity: number; rotate: number; scale: number; depth: number }[] = [];
    const count = Math.min(VISIBLE_STACK_LAYERS, attachments.length);
    for (let i = 0; i < count; i++) {
      const attIndex = (currentIndex + i) % attachments.length;
      layers.push({
        attachment: attachments[attIndex],
        offsetX: i * 6,
        offsetY: i * 5,
        zIndex: count - i,
        opacity: i === 0 ? 1 : i === 1 ? 0.9 : 0.78,
        rotate: i === 0 ? 0 : i === 1 ? -0.6 : -1.1,
        scale: i === 0 ? 1 : i === 1 ? 0.985 : 0.97,
        depth: i
      });
    }
    return layers;
  }, [shouldStack, isExpanded, attachments, currentIndex]);

  const currentAttachment = attachments[currentIndex] || attachments[0];

  if (!shouldStack) {
    return (
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment, index) => (
          <AttachmentItem
            key={attachment.id}
            attachment={attachment}
            isUser={isUser}
            isExpanded={false}
            isSelectMode={false}
            isSelected={false}
            dragIndex={-1}
            dropIndex={null}
            onPreview={() => handleOpenLightbox(index)}
            onToggleSelect={() => {}}
            onDragStart={() => {}}
            onDragOver={() => {}}
            onDragEnd={() => {}}
            onDelete={onDelete}
            index={index}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="attachment-stack-container group/stack">
      <AnimatePresence mode="wait">
        {!isExpanded ? (
          <motion.div
            key="stacked"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="relative pb-1"
          >
            <div
              ref={stackRef}
              className="relative select-none overflow-visible"
              style={{
                width: STACK_CARD_WIDTH,
                height: STACK_CARD_HEIGHT,
                transition: isSwiping ? 'none' : 'transform 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)'
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onMouseDown={handleMouseDown}
            >
              <div className="pointer-events-none absolute left-4 top-6 h-[132px] w-[176px] rounded-[28px] bg-black/12 blur-2xl" />
              <div className="pointer-events-none absolute left-1 top-[13px] h-[150px] w-[206px] rounded-[24px] border border-black/5 bg-white/55 shadow-[0_12px_34px_rgba(15,23,42,0.10)] backdrop-blur-md" />
              <div className="absolute inset-0">
                {stackedLayers.map(({ attachment, offsetX, offsetY, zIndex, opacity, rotate, scale, depth }) => (
                  <div
                    key={attachment.id}
                    className="absolute"
                    style={{
                      left: STACK_FRONT_CARD_LEFT,
                      top: STACK_FRONT_CARD_TOP,
                      width: STACK_FRONT_CARD_WIDTH,
                      height: STACK_FRONT_CARD_HEIGHT,
                      transform: `translate3d(${offsetX + (isSwiping ? swipeOffset * (depth === 0 ? 1 : depth === 1 ? 0.22 : 0.08) : 0)}px, ${offsetY}px, 0) rotate(${rotate}deg) scale(${scale})`,
                      zIndex,
                      opacity,
                      transition: 'transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease-out',
                      willChange: 'transform, opacity',
                      pointerEvents: zIndex === stackedLayers.length ? 'auto' : 'none'
                    }}
                    onClick={zIndex === stackedLayers.length ? () => {
                      if (suppressPreviewClickRef.current) {
                        suppressPreviewClickRef.current = false;
                        return;
                      }
                      handleOpenLightbox(currentIndex);
                    } : undefined}
                  >
                    <div className="relative h-full w-full overflow-hidden rounded-[22px] border border-white/75 bg-white shadow-[0_14px_28px_rgba(15,23,42,0.14)]">
                      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-white/18 to-transparent" />
                      {isImageType(attachment.type) && attachment.url ? (
                        <img src={sanitizeUrl(attachment.url)} alt={attachment.name || '附件图片'} className="pointer-events-none h-full w-full select-none object-cover" draggable={false} loading="lazy" />
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-bg-surface2 via-white to-bg-surface3 p-3">
                          <div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ backgroundColor: `${getFileTypeIcon(attachment.type).color}18` }}>
                            {getFileTypeIcon(attachment.type).svg()}
                          </div>
                          {attachment.media_description && !attachment.media_description.startsWith('[') && (
                            <p className="mt-2 line-clamp-3 text-center text-[9px] leading-3 text-text-secondary">{attachment.media_description}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {attachments.length > 1 && (
                <div className="absolute right-3 top-3 z-30 rounded-full bg-black/20 px-2.5 py-1 text-[10px] font-medium text-white/92 shadow-sm backdrop-blur-sm">
                  {currentIndex + 1}/{attachments.length}
                </div>
              )}

              <button
                type="button"
                onClick={() => setIsExpanded(true)}
                className="absolute bottom-[8px] left-[14px] right-[14px] z-20 rounded-[16px] bg-black/28 px-3 py-2 text-left text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)] backdrop-blur-sm transition-colors hover:bg-black/34"
                aria-label="展开附件堆叠"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="line-clamp-1 text-[11px] font-semibold">{getCollapsedTitle(currentAttachment, attachments.length)}</div>
                    <div className="line-clamp-1 text-[10px] text-white/82">
                      {getCollapsedSubtitle(currentAttachment)}
                    </div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-white/92">
                    查看
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-white/72">
                  <span>{formatFileSize(currentAttachment?.size || 0)}</span>
                  <span>
                    {attachments.length > 1 ? `共 ${attachments.length} 个` : '轻触展开'}
                  </span>
                </div>
              </button>

              {attachments.length > 1 && (
                <>
                  <button
                    className={`absolute left-2 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/82 text-gray-700 shadow-sm backdrop-blur-md transition-all group-hover/stack:opacity-100 ${
                      currentIndex === 0 ? 'opacity-0 pointer-events-none' : 'opacity-0 hover:bg-white'
                    }`}
                    onClick={(e) => { e.stopPropagation(); setCurrentIndex(prev => Math.max(0, prev - 1)); }}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
                  </button>
                  <button
                    className={`absolute right-2 top-1/2 z-30 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/82 text-gray-700 shadow-sm backdrop-blur-md transition-all group-hover/stack:opacity-100 ${
                      currentIndex === attachments.length - 1 ? 'opacity-0 pointer-events-none' : 'opacity-0 hover:bg-white'
                    }`}
                    onClick={(e) => { e.stopPropagation(); setCurrentIndex(prev => Math.min(attachments.length - 1, prev + 1)); }}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                  </button>
                </>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="space-y-3 rounded-[30px] border border-border/20 bg-white/86 p-3 shadow-[0_28px_70px_rgba(15,23,42,0.12)] backdrop-blur-xl dark:bg-bg-surface/90"
          >
            {isSelectMode && (
              <BatchActionBar
                selectedCount={selectedIds.size}
                totalCount={attachments.length}
                onSelectAll={selectAll}
                onDeselectAll={deselectAll}
                onDownloadSelected={handleDownloadSelected}
                onDeleteSelected={handleDeleteSelected}
                onClose={() => { setIsSelectMode(false); deselectAll(); }}
              />
            )}

            <div className="flex items-center justify-between gap-3 rounded-[22px] bg-white/72 px-3 py-2.5 shadow-[0_8px_24px_rgba(15,23,42,0.06)] ring-1 ring-black/5 backdrop-blur-md">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-text-primary">附件</div>
                <div className="text-xs text-text-muted">{attachments.length} 个项目</div>
              </div>
              <div className="flex items-center gap-2">
                {attachments.length > 1 && (
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => { setIsSelectMode(!isSelectMode); if (isSelectMode) deselectAll(); }}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur-sm shadow-sm border transition-all ${
                      isSelectMode
                        ? 'bg-accent/10 text-accent border-accent/30'
                        : 'bg-bg-surface2/80 text-text-secondary border-border/20 hover:bg-bg-surface3'
                    }`}
                  >
                    {isSelectMode ? '取消选择' : '选择'}
                  </motion.button>
                )}
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => { setIsExpanded(false); setCurrentIndex(0); setIsSelectMode(false); deselectAll(); }}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium backdrop-blur-sm shadow-sm border transition-all ${
                    isUser
                      ? 'bg-white/90 text-green-700 border-white/50 hover:bg-white'
                      : 'bg-bg-surface2/80 text-text-secondary border-border/20 hover:bg-bg-surface3'
                  }`}
                >
                  收起
                </motion.button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {attachments.map((attachment, index) => (
                <AttachmentItem
                  key={attachment.id}
                  attachment={attachment}
                  isUser={isUser}
                  isExpanded={true}
                  isSelectMode={isSelectMode}
                  isSelected={selectedIds.has(attachment.id)}
                  dragIndex={dragIndex ?? -1}
                  dropIndex={dropIndex}
                  onPreview={() => handleOpenLightbox(index)}
                  onToggleSelect={() => toggleSelect(attachment.id)}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragEnd={handleDragEnd}
                  onDelete={onDelete}
                  index={index}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showLightbox && (
          <LightboxModal
            attachments={attachments}
            initialIndex={lightboxIndex}
            isUser={isUser}
            onClose={() => setShowLightbox(false)}
            onDelete={onDelete}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default AttachmentStack;
