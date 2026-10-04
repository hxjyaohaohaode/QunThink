import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { useMessagesStore } from '../../stores/messagesStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../services/api';
import { AI_NAMES, AI_COLORS } from '../../types';
import { useModelsStore } from '../../stores/modelsStore';
import { usePersonasStore } from '../../stores/personasStore';
import type { MessageAttachment, UploadedFile } from '../../types';
import { stopGeneration } from '../../services/websocket';
import { AnimatedButton } from '../Common/AnimatedButton';
import { AttachmentStack } from './AttachmentStack';
import { getCacheUserId, loadCacheAsync, saveCacheAsync } from '../../utils/cacheUtils';

interface LastMessageMeta {
  id: string;
  senderType: string;
  senderId: string;
}

function buildQuickReplyChips(meta: LastMessageMeta | null, aiMembers: string[] | undefined, nameForId: (id: string) => string): string[] {
  if (!meta || meta.senderType !== 'ai') return [];
  const candidates = (aiMembers || []).filter(id => id && id !== meta.senderId);
  const chips = ['展开说说', '换个角度'];
  if (candidates.length > 0) {
    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    chips.push(`@${nameForId(picked)} 你怎么看`);
  }
  chips.push('问个问题');
  return chips;
}

type ComposerAttachmentStatus = 'uploading' | 'ready';

interface ComposerAttachment {
  localId: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: ComposerAttachmentStatus;
  serverFile?: UploadedFile;
  attachment?: MessageAttachment;
}

const MAX_ATTACHMENTS = 10;

function createLocalAttachmentId() {
  return `attachment_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getUploadedFile(result: { file?: UploadedFile; files?: UploadedFile[] } | null | undefined): UploadedFile | null {
  if (result?.file) {
    return result.file;
  }
  if (Array.isArray(result?.files) && result.files.length > 0) {
    return result.files[0];
  }
  return null;
}

function toMessageAttachment(uploadedFile: UploadedFile, fallbackFile: File): MessageAttachment {
  const mediaDescription = uploadedFile.media_description
    || (typeof uploadedFile.parsed_content === 'string' ? uploadedFile.parsed_content.substring(0, 500) : '')
    || '附件识别完成';

  return {
    id: uploadedFile.id,
    name: uploadedFile.original_name || uploadedFile.filename || fallbackFile.name,
    type: uploadedFile.mime_type || fallbackFile.type || 'application/octet-stream',
    size: uploadedFile.file_size || fallbackFile.size,
    url: uploadedFile.url,
    media_description: mediaDescription
  };
}

export function MessageInput() {
  const [input, setInput] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastFailedContent, setLastFailedContent] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth < 768 : false);
  const [justSentMessage, setJustSentMessage] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSendSuccess, setShowSendSuccess] = useState(false);
  const [draftReadyScope, setDraftReadyScope] = useState<string | null>(null);
  const [draftSaveFailed, setDraftSaveFailed] = useState(false);
  const [replySelectionNotice, setReplySelectionNotice] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const MAX_CHARS = 5000;
  const charCount = input.length;
  const isOverLimit = charCount > MAX_CHARS;
  const isNearLimit = charCount > MAX_CHARS * 0.9;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const mentionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeRAFRef = useRef<number | null>(null);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 使用 RAF 调整 textarea 高度，避免布局抖动
  const adjustTextareaHeight = useCallback(() => {
    if (resizeRAFRef.current) cancelAnimationFrame(resizeRAFRef.current);
    resizeRAFRef.current = requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
      }
      resizeRAFRef.current = null;
    });
  }, []);

  const currentGroup = useGroupsStore((s) => s.currentGroup);
  const cacheUserId = getCacheUserId();
  const draftKey = cacheUserId && currentGroup?.id
    ? `message_draft_${cacheUserId}_${currentGroup.id}`
    : null;
  const catalogModels = useModelsStore((s) => s.catalog?.models);
  const personas = usePersonasStore((s) => s.personas);
  const chatStatus = useGroupsStore((s) => s.chatStatus);
  const sendMessage = useMessagesStore((s) => s.sendMessage);
  const replyingTo = useUIStore((s) => s.replyingTo);
  const connectionStatus = useUIStore((s) => s.connectionStatus);
  const clearReplyingTo = useUIStore((s) => s.clearReplyingTo);
  const removeReplyingTo = useUIStore((s) => s.removeReplyingTo);
  const rawGroupTyping = useUIStore((s) => (currentGroup ? s.typingIndicators[currentGroup.id] : undefined));
  const groupMessages = useMessagesStore((s) => (currentGroup ? s.messages[currentGroup.id] : undefined));
  const isSending = useMessagesStore((s) => (currentGroup ? (s.sending[currentGroup.id] ?? false) : false));

  const composingRef = useRef(false);
  const sendErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionContextRef = useRef<{ cursorPos: number; value: string }>({ cursorPos: 0, value: '' });
  const currentGroupIdRef = useRef<string | null>(currentGroup?.id ?? null);
  const draftScopeRef = useRef<string | null>(null);
  const previousReplyIdRef = useRef<string | null>(null);
  currentGroupIdRef.current = currentGroup?.id ?? null;

  // 每个账号、会话分别恢复文本草稿。恢复完成前禁用输入，避免异步读取覆盖新输入。
  useEffect(() => {
    let active = true;
    draftScopeRef.current = null;
    setDraftReadyScope(null);
    setInput('');
    setDraftSaveFailed(false);
    setAttachments([]);
    setUploading(false);
    setSendError(null);
    setLastFailedContent(null);
    setShowMentions(false);
    setIsClosing(false);
    setMentionFilter('');
    composingRef.current = false;
    clearReplyingTo();
    if (draftKey) {
      void loadCacheAsync<string>(draftKey).then((saved) => {
        if (!active || !cacheUserId || getCacheUserId() !== cacheUserId) return;
        draftScopeRef.current = draftKey;
        setInput(typeof saved === 'string' ? saved.slice(0, MAX_CHARS) : '');
        setDraftReadyScope(draftKey);
      });
    }
    return () => {
      active = false;
      draftScopeRef.current = null;
    };
  }, [draftKey, cacheUserId, clearReplyingTo]);

  useEffect(() => {
    if (!draftKey || draftReadyScope !== draftKey || draftScopeRef.current !== draftKey || composingRef.current) return;
    void saveCacheAsync(draftKey, input).then((saved) => {
      if (draftScopeRef.current === draftKey) setDraftSaveFailed(!saved);
    });
  }, [draftKey, draftReadyScope, input]);

  useEffect(() => {
    const nextReplyId = replyingTo[0] || null;
    if (previousReplyIdRef.current && nextReplyId && previousReplyIdRef.current !== nextReplyId) {
      setReplySelectionNotice('当前仅支持引用一条消息，已切换为刚选择的消息');
    } else if (!nextReplyId) {
      setReplySelectionNotice(null);
    }
    previousReplyIdRef.current = nextReplyId;
  }, [replyingTo]);

  const modelDetails = useMemo(() => (catalogModels || [])
    .filter(model => model.enabled && model.capabilities.includes('chat'))
    .map(model => ({
      id: model.id,
      name: personas[model.id]?.name || model.name || AI_NAMES[model.id] || model.id,
      color: personas[model.id]?.color || model.color || AI_COLORS[model.id] || '#6b7280'
    })), [catalogModels, personas]);
  const nameForId = (id: string) => modelDetails.find(model => model.id === id)?.name || personas[id]?.name || AI_NAMES[id] || id;
  const colorForId = (id: string) => modelDetails.find(model => model.id === id)?.color || personas[id]?.color || AI_COLORS[id] || '#999';
  const currentGroupAIs = useMemo(() => {
    if (!currentGroup?.ai_members?.length) return modelDetails;
    return currentGroup.ai_members.map(id => modelDetails.find(model => model.id === id))
      .filter((model): model is NonNullable<typeof model> => Boolean(model));
  }, [currentGroup?.ai_members, modelDetails]);

  const isAnyAITyping = currentGroup
    ? Object.values(rawGroupTyping || {}).some(v => v === true)
    : false;
  const hasStreamingMessages = currentGroup
    ? (groupMessages || []).some(m => m.is_streaming)
    : false;
  const isAutoChatRunning = currentGroup
    ? chatStatus.get(currentGroup.id)?.isRunning === true
    : false;
  const showStopButton = isAnyAITyping || justSentMessage || hasStreamingMessages || isAutoChatRunning;
  const hasPendingUploads = attachments.some(item => item.status !== 'ready');
  const readyAttachments = useMemo(
    () => attachments.flatMap(item => item.attachment ? [item.attachment] : []),
    [attachments]
  );
  const attachmentPreviews = useMemo<MessageAttachment[]>(
    () => attachments.map(item => item.attachment || {
      id: item.localId,
      name: item.fileName,
      type: item.mimeType || 'application/octet-stream',
      size: item.size,
      url: item.serverFile?.url,
      media_description: item.status === 'uploading' ? 'AI 正在上传并识别附件...' : '附件已就绪'
    }),
    [attachments]
  );

  useEffect(() => {
    if (isAnyAITyping && justSentMessage) {
      setJustSentMessage(false);
    }
  }, [isAnyAITyping, justSentMessage]);

  const isAIPrivateChat = currentGroup?.is_ai_private === true || currentGroup?.type === 'ai_private';
  const isUserPrivateChat = currentGroup?.is_private === true && !isAIPrivateChat && currentGroup?.ai_members?.length === 1;

  // 最后一条非流式消息的元信息；流式更新不会改变其 id，配合下方 ref 缓存保证 chips 仅在消息 id 变化时重算
  const lastNonStreamingMeta = useMemo<LastMessageMeta | null>(() => {
    const list = groupMessages || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const msg = list[i];
      if (!msg.is_streaming) {
        return { id: msg.id, senderType: msg.sender_type, senderId: msg.sender_id || '' };
      }
    }
    return null;
  }, [groupMessages]);

  const quickReplyCacheRef = useRef<{ key: string; chips: string[] }>({ key: '', chips: [] });
  const quickReplyKey = `${currentGroup?.id || ''}|${lastNonStreamingMeta?.id || ''}`;
  if (quickReplyCacheRef.current.key !== quickReplyKey) {
    quickReplyCacheRef.current = {
      key: quickReplyKey,
      chips: lastNonStreamingMeta
        ? buildQuickReplyChips(lastNonStreamingMeta, currentGroup?.ai_members, nameForId)
        : []
    };
  }
  const quickReplyChips = quickReplyCacheRef.current.chips;

  const replyToMessages = replyingTo.length > 0 && currentGroup
    ? replyingTo.map(id => (groupMessages || []).find(m => m.id === id)).filter(Boolean)
    : [];

  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleKeyboardOpen = () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
          textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          const messageList = document.querySelector<HTMLElement>('[data-message-scroller]');
          if (messageList) {
            messageList.scrollTop = messageList.scrollHeight;
          }
        });
      }, 150);
    };

    const viewport = window.visualViewport;
    if (viewport) {
      const handleViewportResize = () => {
        const heightDiff = window.innerHeight - viewport.height;
        if (heightDiff > 100) {
          handleKeyboardOpen();
        }
      };

      viewport.addEventListener('resize', handleViewportResize);
      viewport.addEventListener('scroll', handleViewportResize);

      return () => {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        viewport.removeEventListener('resize', handleViewportResize);
        viewport.removeEventListener('scroll', handleViewportResize);
      };
    } else {
      let initialHeight = window.innerHeight;

      const handleWindowResize = () => {
        const heightDiff = initialHeight - window.innerHeight;
        if (heightDiff > 100) {
          handleKeyboardOpen();
        } else if (heightDiff < 50) {
          initialHeight = window.innerHeight;
        }
      };

      window.addEventListener('resize', handleWindowResize);

      return () => {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        window.removeEventListener('resize', handleWindowResize);
      };
    }
  }, []);

  useEffect(() => {
    return () => {
      if (mentionTimeoutRef.current) {
        clearTimeout(mentionTimeoutRef.current);
      }
      if (resizeRAFRef.current) {
        cancelAnimationFrame(resizeRAFRef.current);
      }
      if (mentionDebounceRef.current) {
        clearTimeout(mentionDebounceRef.current);
      }
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
      if (sendErrorTimerRef.current) {
        clearTimeout(sendErrorTimerRef.current);
      }
    };
  }, []);

  const flashSendError = useCallback((message: string) => {
    setSendError(message);
    if (sendErrorTimerRef.current) clearTimeout(sendErrorTimerRef.current);
    sendErrorTimerRef.current = setTimeout(() => {
      setSendError(null);
      sendErrorTimerRef.current = null;
    }, 3000);
  }, []);

  const closeMentions = useCallback(() => {
    setIsClosing(true);
    if (mentionTimeoutRef.current) {
      clearTimeout(mentionTimeoutRef.current);
    }
    mentionTimeoutRef.current = setTimeout(() => {
      setShowMentions(false);
      setIsClosing(false);
    }, 150);
  }, []);

  useEffect(() => {
    if (!showMentions) return;
    const handleClickOutside = (e: Event) => {
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(e.target as Node)) {
        closeMentions();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, [showMentions, closeMentions]);

  useEffect(() => {
    if (replyingTo.length > 0 && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyingTo]);

  const handleQuickReply = useCallback((text: string) => {
    setInput(text);
    setMentionFilter('');
    closeMentions();
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, [closeMentions]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // 同步捕获光标上下文，debounce 回调只读已捕获值，避免读陈旧的 selectionStart
    mentionContextRef.current = {
      cursorPos: e.target.selectionStart ?? value.length,
      value,
    };

    // IME 组合期间不做截断，先保存原值，compositionend 时统一裁剪
    if (composingRef.current) {
      setInput(value);
      return;
    }

    if (value.length > MAX_CHARS) {
      setInput(value.substring(0, MAX_CHARS));
      flashSendError(`已超出${MAX_CHARS}字符限制，内容已截断`);
      return;
    }
    setInput(value);
    if (sendError) setSendError(null);

    // 使用 debounce 检测 @ 提及，避免每次按键都触发
    if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    mentionDebounceRef.current = setTimeout(() => {
      // 只使用 onChange 时同步捕获的上下文
      const { cursorPos, value: capturedValue } = mentionContextRef.current;
      const textBeforeCursor = capturedValue.slice(0, cursorPos);
      const atIndex = textBeforeCursor.lastIndexOf('@');

      if (atIndex !== -1) {
        const textAfterAt = textBeforeCursor.slice(atIndex + 1);
        if (!textAfterAt.includes(' ') && textAfterAt.length < 20) {
          setIsClosing(false);
          setShowMentions(true);
          setMentionFilter(textAfterAt.toLowerCase());
        } else {
          closeMentions();
        }
      } else {
        closeMentions();
      }
    }, 80);
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const value = e.currentTarget?.value ?? '';
    const finalValue = value.slice(0, MAX_CHARS);
    if (value.length > MAX_CHARS) {
      setInput(finalValue);
      flashSendError(`已超出${MAX_CHARS}字符限制，内容已截断`);
    } else {
      setInput(finalValue);
    }
    // 最后一次输入事件可能与组合结束值相同，React 不会再次触发保存 effect。
    if (draftKey && draftScopeRef.current === draftKey) {
      void saveCacheAsync(draftKey, finalValue).then((saved) => {
        if (draftScopeRef.current === draftKey) setDraftSaveFailed(!saved);
      });
    }
  };

  const uploadSelectedFiles = useCallback(async (selectedFiles: File[]) => {
    if (!currentGroup || selectedFiles.length === 0 || uploading || hasPendingUploads) {
      return;
    }

    const availableCount = MAX_ATTACHMENTS - attachments.length;
    if (availableCount <= 0) {
      setSendError(`最多只能上传 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }

    const nextFiles = selectedFiles.slice(0, availableCount);
    if (nextFiles.length < selectedFiles.length) {
      setSendError(`超出的附件已忽略，当前最多支持 ${MAX_ATTACHMENTS} 个附件`);
    } else {
      setSendError(null);
    }

    const uploadGroupId = currentGroup.id;

    const placeholders = nextFiles.map(file => ({
      localId: createLocalAttachmentId(),
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      status: 'uploading' as const
    }));

    setAttachments(prev => [...prev, ...placeholders]);
    setUploading(true);

    const uploadPromises = nextFiles.map(async (file, index) => {
      const placeholder = placeholders[index];
      try {
        const uploadResult = await api.uploadFile(file, uploadGroupId);
        const uploadedFile = getUploadedFile(uploadResult);
        if (!uploadedFile) {
          throw new Error('附件上传成功，但未返回可用的附件数据');
        }

        const nextAttachment = toMessageAttachment(uploadedFile, file);
        return { localId: placeholder.localId, status: 'ready' as const, serverFile: uploadedFile, attachment: nextAttachment };
      } catch (error: any) {
        return { localId: placeholder.localId, error: error?.message || `附件 ${file.name} 上传失败，请重试` };
      }
    });

    const results = await Promise.all(uploadPromises);

    // 上传期间已切换群组：丢弃本次结果，避免把附件入库到错误会话
    if (currentGroupIdRef.current !== uploadGroupId) {
      setUploading(false);
      return;
    }

    setAttachments(prev => {
      const failedLocalIds = new Set<string>();
      let errorMsg: string | null = null;
      const updated = prev.map(item => {
        const result = results.find(r => r.localId === item.localId);
        if (!result) return item;
        if ('error' in result) {
          failedLocalIds.add(result.localId);
          errorMsg = result.error;
          return item;
        }
        return { ...item, status: result.status, serverFile: result.serverFile, attachment: result.attachment };
      }).filter(item => !failedLocalIds.has(item.localId));
      if (errorMsg) {
        setSendError(errorMsg);
      }
      return updated;
    });

    setUploading(false);
  }, [attachments.length, currentGroup, hasPendingUploads, uploading]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          void uploadSelectedFiles([file]);
        }
        break;
      }
    }
  }, [uploadSelectedFiles]);

  const insertMention = (aiId: string) => {
    const ai = modelDetails.find(a => a.id === aiId);
    const displayName = ai ? ai.name : aiId;

    const cursorPos = textareaRef.current?.selectionStart || input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const textAfterCursor = input.slice(cursorPos);

    const atIndex = textBeforeCursor.lastIndexOf('@');
    const textBeforeAt = textBeforeCursor.slice(0, atIndex);

    const newInput = textBeforeAt + `@${displayName} ` + textAfterCursor;
    if (newInput.length > MAX_CHARS) {
      setInput(newInput.substring(0, MAX_CHARS));
      flashSendError(`已超出${MAX_CHARS}字符限制，内容已截断`);
    } else {
      setInput(newInput);
    }
    closeMentions();

    setTimeout(() => {
      const newCursorPos = textBeforeAt.length + displayName.length + 2;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (selectedFiles) {
      void uploadSelectedFiles(Array.from(selectedFiles));
    }
    e.target.value = '';
  };

  const handleRemoveAttachment = useCallback(async (attachmentId: string) => {
    const target = attachments.find(item =>
      item.localId === attachmentId
      || item.serverFile?.id === attachmentId
      || item.attachment?.id === attachmentId
    );

    if (!target) {
      return;
    }

    setAttachments(prev => prev.filter(item =>
      item.localId !== target.localId
      && item.serverFile?.id !== attachmentId
      && item.attachment?.id !== attachmentId
    ));

    if (target.serverFile?.id && currentGroup?.id) {
      try {
        await api.deleteFile(target.serverFile.id, currentGroup.id);
      } catch (error) {
        console.warn('删除未发送附件失败:', error);
      }
    }
  }, [attachments, currentGroup?.id]);

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    if (!currentGroup || (draftKey && draftReadyScope !== draftKey) || (!input.trim() && readyAttachments.length === 0) || isSending || hasPendingUploads || uploading) return;
    if (replyingTo.length > 1) {
      setSendError('当前仅支持引用一条消息，请重新选择');
      return;
    }

    setSendError(null);
    clearTimeout(successTimeoutRef.current);
    sendingRef.current = true;
    setJustSentMessage(true);

    const sendingGroupId = currentGroup.id;
    const sendingDraftKey = draftKey;
    const contentToSend = input.trim();
    try {
      // 不再使用 Promise.race 超时：超时后原 promise 仍会完成并造成二次清空/双发风险。
      // 防重复发送以 store 的 sending 状态为准（按钮禁用 + sendingRef 兜底）。
      const result = await sendMessage(
        currentGroup.id,
        contentToSend,
        replyingTo.length > 0 ? replyingTo : undefined,
        readyAttachments.length > 0 ? readyAttachments : undefined
      );
      if (result.success) {
        if (sendingDraftKey) {
          void saveCacheAsync(sendingDraftKey, '').then((saved) => {
            if (draftScopeRef.current === sendingDraftKey) setDraftSaveFailed(!saved);
          });
        }
        if (currentGroupIdRef.current === sendingGroupId) {
          setInput('');
          setAttachments([]);
          setLastFailedContent(null);
          clearReplyingTo();
          setShowSendSuccess(true);
          successTimeoutRef.current = setTimeout(() => setShowSendSuccess(false), 1500);
        }
      } else {
        if (currentGroupIdRef.current === sendingGroupId) {
          setLastFailedContent(contentToSend);
          setSendError(result.error || '发送失败，请检查网络连接');
          setJustSentMessage(false);
        }
      }
    } catch (error) {
      if (currentGroupIdRef.current === sendingGroupId) {
        setLastFailedContent(contentToSend);
        setSendError('发送失败，请检查网络连接');
        setJustSentMessage(false);
      }
    } finally {
      sendingRef.current = false;
    }
  }, [currentGroup, draftKey, draftReadyScope, hasPendingUploads, input, readyAttachments, replyingTo, sendMessage, isSending, clearReplyingTo, uploading]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMentions();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, closeMentions]);



  const filteredAIs = currentGroupAIs.filter(
    (ai) => !mentionFilter ||
      ai.name.toLowerCase().includes(mentionFilter) ||
      ai.id.toLowerCase().includes(mentionFilter)
  );

  const showMentionAll = !isUserPrivateChat && !isAIPrivateChat && currentGroupAIs.length > 1 && (
    !mentionFilter || '所有人'.includes(mentionFilter) || 'all'.includes(mentionFilter)
  );

  const insertMentionAll = () => {
    const cursorPos = textareaRef.current?.selectionStart || input.length;
    const textBeforeCursor = input.slice(0, cursorPos);
    const textAfterCursor = input.slice(cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    const textBeforeAt = textBeforeCursor.slice(0, atIndex);
    const newInput = textBeforeAt + '@所有人 ' + textAfterCursor;
    if (newInput.length > MAX_CHARS) {
      setInput(newInput.substring(0, MAX_CHARS));
      flashSendError(`已超出${MAX_CHARS}字符限制，内容已截断`);
    } else {
      setInput(newInput);
    }
    closeMentions();
    setTimeout(() => {
      const newCursorPos = textBeforeAt.length + 5;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  return (
    <div className="bg-bg-surface border-t border-border-subtle p-3 md:p-4 relative z-10 flex-shrink-0" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
      <div className="w-full">
        {isAIPrivateChat && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-accent-subtle rounded-lg">
            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" /></svg>
            <span className="text-xs text-accent">你的消息将作为"旁白"参与对话</span>
          </div>
        )}
        {isUserPrivateChat && (
          <div className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-accent-subtle rounded-lg">
            <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" /></svg>
            <span className="text-xs text-accent">与 {nameForId(currentGroup?.ai_members?.[0] || 'AI')} 的私聊</span>
          </div>
        )}
        <>
          {replyToMessages.length > 0 && (
            <div className="flex flex-col gap-1 mb-3">
              {replyToMessages.map((msg) => (
                <div key={msg!.id} className="flex items-center gap-2 px-3 py-2 bg-bg-surface2 rounded-xl border-l-2 border-l-accent">
                  <div
                    className="w-1 h-8 rounded-full"
                    style={{ backgroundColor: colorForId(msg!.sender_id || 'system') }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-caption text-text-muted">
                      引用 · {nameForId(msg!.sender_id || '未知')}
                    </div>
                    <div className="text-caption text-text-secondary truncate">
                      {(msg!.content || '').substring(0, 40)}{(msg!.content || '').length > 40 ? '...' : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => removeReplyingTo(msg!.id)}
                    className="p-1 hover:bg-bg-surface3 rounded text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          {replySelectionNotice && (
            <div role="status" className="mb-2 px-3 text-xs text-text-secondary">{replySelectionNotice}</div>
          )}

          {sendError && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg">
              <span className="text-red-500 dark:text-red-400 text-sm flex-1 flex items-center gap-1.5">
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
                {sendError}
              </span>
              <button
                onClick={() => {
                  setSendError(null);
                  if (lastFailedContent) {
                    setInput(lastFailedContent);
                    setLastFailedContent(null);
                  }
                }}
                className="px-3 py-1 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 underline"
              >
                重试
              </button>
              <button
                onClick={() => {
                  setSendError(null);
                  setLastFailedContent(null);
                }}
                className="p-1 hover:bg-red-100 dark:hover:bg-red-800 rounded text-red-400 dark:text-red-500 hover:text-red-600 dark:hover:text-red-300 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
          )}

          {attachmentPreviews.length > 0 && (
            <div className="mb-3 space-y-2">
              <AttachmentStack
                attachments={attachmentPreviews}
                isUser={true}
                onDelete={(attachmentId) => { void handleRemoveAttachment(attachmentId); }}
              />
              <div className="flex items-center justify-between px-1 text-xs text-text-muted">
                <span>已完成识别 {readyAttachments.length}/{attachments.length} 个附件</span>
                <span>识别完成后会把附件描述广播给不具备视觉/解析能力的模型</span>
              </div>
            </div>
          )}

          {uploading && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
              <svg className="animate-spin w-4 h-4 text-blue-500" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span className="text-sm text-blue-600 dark:text-blue-400">正在上传并识别附件内容，识别完成后才可继续上传或发送...</span>
            </div>
          )}

          {quickReplyChips.length > 0 && (
            <div className="mb-2 -mx-1 px-1 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {quickReplyChips.map(chip => (
                <button
                  key={chip}
                  onClick={() => handleQuickReply(chip)}
                  title="点击填入输入框"
                  className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs whitespace-nowrap bg-bg-surface2 border border-border-subtle text-text-secondary hover:text-accent hover:border-accent/40 active:scale-95 transition-all"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          <div className="relative flex items-end gap-2 md:gap-3">
            <div className={`relative flex-1 ${connectionStatus === 'disconnected' ? 'border-red-500 ring-2 ring-red-200 rounded-2xl' : ''}`}>
              <textarea
                ref={textareaRef}
                value={draftKey && draftReadyScope !== draftKey ? '' : input}
                onChange={handleInputChange}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onFocus={() => {
                  setIsInputFocused(true);
                }}
                onBlur={() => {
                  setIsInputFocused(false);
                }}
                placeholder={draftKey && draftReadyScope !== draftKey ? '正在恢复此会话草稿...' : (isAIPrivateChat ? "输入旁白内容，引导AI对话方向..." : (isUserPrivateChat ? "输入消息..." : (currentGroup ? "输入消息，@提及 AI 成员..." : "选择一个群组开始聊天")))}
                disabled={!currentGroup || isSending || Boolean(draftKey && draftReadyScope !== draftKey)}
                className={`w-full bg-bg-surface2 border rounded-2xl px-4 py-3 text-body text-text-primary placeholder:text-text-muted resize-none focus:outline-none disabled:opacity-50 transition-all duration-200 ${isInputFocused
                  ? 'border-accent ring-2 ring-accent/20'
                  : 'border-border-subtle'
                  }`}
                rows={1}
                maxLength={MAX_CHARS}
              />

              {showMentions && (filteredAIs.length > 0 || showMentionAll) && (
                <div
                  ref={mentionMenuRef}
                  className={`absolute left-0 right-0 bg-bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden ${isMobile
                    ? 'bottom-full mb-2 max-h-[40vh]'
                    : 'bottom-full mb-2 max-h-60'
                    } ${isClosing ? 'animate-mention-menu-close' : 'animate-mention-menu-open'}`}
                >
                  <div className="px-3 py-2 text-xs text-text-muted border-b border-border bg-bg-surface2">
                    选择要@的AI成员
                  </div>
                  <div className="overflow-y-auto max-h-[calc(100%-36px)]">
                    {showMentionAll && (
                      <button
                        onClick={insertMentionAll}
                        className="w-full px-3 py-2.5 text-left hover:bg-bg-surface2 transition-colors flex items-center gap-3 border-b border-border animate-mention-item"
                      >
                        <span className="w-3 h-3 rounded-full flex-shrink-0 bg-gradient-to-br from-blue-400 to-purple-500" />
                        <span className="text-sm font-medium text-text-primary">所有人</span>
                        <span className="text-xs text-text-muted ml-auto">@所有人</span>
                      </button>
                    )}
                    {filteredAIs.map((ai, index) => (
                      <button
                        key={ai.id}
                        onClick={() => insertMention(ai.id)}
                        className="w-full px-3 py-2.5 text-left hover:bg-bg-surface2 transition-colors flex items-center gap-3 border-b border-border last:border-b-0 animate-mention-item"
                        style={{
                          animationDelay: `${(showMentionAll ? index + 1 : index) * 40}ms`
                        }}
                      >
                        <span
                          className="w-3 h-3 rounded-full flex-shrink-0 transition-transform duration-200 hover:scale-125"
                          style={{ backgroundColor: ai.color }}
                        />
                        <span className="text-sm font-medium text-text-primary">{ai.name}</span>
                        <span className="text-xs text-text-muted ml-auto">{ai.id}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            <AnimatedButton
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!currentGroup || uploading || hasPendingUploads}
              className="p-2 md:p-3"
              title="上传文件"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" /></svg>
            </AnimatedButton>

            {showStopButton && (
              <AnimatedButton
                variant="primary"
                size="sm"
                onClick={() => {
                  if (currentGroup) {
                    try {
                      stopGeneration(currentGroup.id);
                    } catch (e) {
                      setSendError('停止生成失败，请重试');
                      setTimeout(() => setSendError(null), 3000);
                    }
                    setJustSentMessage(false);
                  }
                }}
                className="w-10 h-10 rounded-full !min-w-0 flex items-center justify-center !bg-red-500 hover:!bg-red-600 shadow-lg shadow-red-500/30"
                title="停止生成"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </AnimatedButton>
            )}

            <AnimatedButton
              variant="primary"
              size="md"
              onClick={handleSend}
              disabled={!currentGroup || Boolean(draftKey && draftReadyScope !== draftKey) || (!input.trim() && readyAttachments.length === 0) || isSending || uploading || hasPendingUploads || connectionStatus === 'disconnected'}
              className={`w-10 h-10 rounded-full !min-w-0 !md:min-w-0 flex items-center justify-center ${(!currentGroup || Boolean(draftKey && draftReadyScope !== draftKey) || (!input.trim() && readyAttachments.length === 0) || isSending || uploading || hasPendingUploads || connectionStatus === 'disconnected') ? 'opacity-50' : ''} ${showSendSuccess ? 'animate-send-success' : ''}`}
            >
              {isSending || uploading || hasPendingUploads ? (
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : showSendSuccess ? (
                <svg className="w-5 h-5 animate-checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" className="animate-draw-check" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" /></svg>
              )}
            </AnimatedButton>
          </div>
          {connectionStatus === 'disconnected' && (
            <div className="text-xs text-red-500 px-4 pb-1 flex items-center gap-1">
              <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" /></svg>
              网络已断开，消息可能无法发送
            </div>
          )}
          {draftSaveFailed && (
            <div role="alert" className="text-xs text-red-500 px-4 pb-1">此浏览器的加密草稿保存失败；刷新页面前请复制输入内容。</div>
          )}
          <div className="px-4 pb-1 flex items-center justify-between">
            <div className={`text-xs transition-colors ${isOverLimit ? 'text-red-500 font-semibold' : isNearLimit ? 'text-orange-500' : 'text-text-muted'}`}>
              {charCount}/{MAX_CHARS}
            </div>
            {isNearLimit && (
              <div className="text-xs text-text-muted">
                {isOverLimit ? '已超出限制' : '接近限制'}
              </div>
            )}
          </div>
          {currentGroup && cacheUserId && (
            <div className="px-4 text-[10px] text-text-muted">文本草稿仅保存在此浏览器当前账号的加密缓存中，7 天后过期；附件需重新选择。</div>
          )}
        </>
      </div>
    </div>
  );
}
