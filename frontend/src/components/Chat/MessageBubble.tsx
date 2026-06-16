import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import { motion } from 'framer-motion';
import { AI_COLORS, AI_NAMES, AI_AVATAR_LETTERS, DebateRole, DEBATE_ROLE_NAMES, DEBATE_ROLE_COLORS, DEBATE_ROLE_ICONS } from '../../types';
import { useMessagesStore, useMessagesStoreInternal } from '../../stores/messagesStore';
import type { Message } from '../../types';
import { useGroupsStore } from '../../stores/groupsStore';
import { usePersonasStore } from '../../stores/personasStore';
import { useUIStore } from '../../stores/uiStore';
import { AIInfoPopup } from './AIInfoPopup';
import { useConfirm, useToast } from '../Common';
import { AudioPlayer } from './AudioPlayer';
import { MessageContextMenu, useMessageContextMenu } from './MessageContextMenu';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { CommentSection } from './CommentSection';
import { AttachmentStack } from './AttachmentStack';
import { sanitizeUrl } from '../../utils/sanitizeUrl';
import { useAudioStore } from '../../stores/audioStore';
import { TTSSynthesizeModal } from './TTSSynthesizeModal';
import { MessageTTSAudio } from '../../types';
import { useProfileStore } from '../../stores/profileStore';
import { api } from '../../services/api';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

interface MessageBubbleProps {
  message: Message;
  showActions?: boolean;
  onReply?: (messageId: string) => void;
  showTimeDivider?: boolean;
  isMultiSelectMode?: boolean;
  debateRole?: DebateRole;
  isDebateMode?: boolean;
}

const TIME_FORMATS = [
  { key: 'short', format: 'HH:mm', label: '简短时间' },
  { key: 'full', format: 'YYYY-MM-DD HH:mm', label: '完整日期' },
  { key: 'relative', format: 'relative', label: '相对时间' },
  { key: 'weekday', format: 'dddd HH:mm', label: '星期时间' },
];

const timeFormatMap = new Map<string, number>();
const TIME_FORMAT_MAP_MAX_SIZE = 1000;

function setTimeFormatEntry(key: string, value: number) {
  if (timeFormatMap.size >= TIME_FORMAT_MAP_MAX_SIZE) {
    const firstKey = timeFormatMap.keys().next().value;
    if (firstKey !== undefined) {
      timeFormatMap.delete(firstKey);
    }
  }
  timeFormatMap.set(key, value);
}

const messageAnimations = {
  userMessage: {
    initial: { opacity: 0, scale: 0.95, y: 10 },
    animate: { opacity: 1, scale: 1, y: 0 },
    transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] as const },
  },
  aiMessage: {
    initial: { opacity: 0, x: 20, y: 5 },
    animate: { opacity: 1, x: 0, y: 0 },
    transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] as const },
  },
};

const MessageBubbleComponent = ({ message, showActions: _showActions = true, onReply, showTimeDivider, isMultiSelectMode = false, debateRole, isDebateMode = false }: MessageBubbleProps) => {
  const allMessages = useMessagesStoreInternal(state => state.messages[message.group_id] || []);
  const [showComments, setShowComments] = useState(false);
  const [showAIInfo, setShowAIInfo] = useState(false);
  const [aiInfoPosition, setAIInfoPosition] = useState({ x: 0, y: 0 });
  const [, setTimeFormatVersion] = useState(0);
  const timeFormatIndexRef = useRef(timeFormatMap.get(message.id) || 0);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [showSendGlow, setShowSendGlow] = useState(false);
  const prevStatusRef = useRef(message.status);
  const { deleteMessage, editMessage, retryMessage, removeFailedMessage, updateMessage } = useMessagesStore();
  const { currentGroup } = useGroupsStore();
  const { personas } = usePersonasStore();
  const { addReplyingTo } = useUIStore();
  const { contextMenu, handleContextMenu, handleLongPress, closeContextMenu } = useMessageContextMenu();
  const { confirm, ConfirmModal } = useConfirm();
  const { showToast, Toast } = useToast();
  const { getTTSAudio, setTTSAudio, setTTSLoading, isTTSLoading, removeTTSAudio } = useAudioStore();
  const [showTTSModal, setShowTTSModal] = useState(false);
  const deletingRef = useRef(false);

  const persistedTtsAudio = useMemo(() => {
    const rawTts = message.metadata?.tts as Record<string, unknown> | undefined;
    if (!rawTts || typeof rawTts.audioUrl !== 'string') {
      return undefined;
    }

    return {
      id: rawTts.id,
      audioUrl: rawTts.audioUrl,
      duration: rawTts.duration,
      voiceId: rawTts.voiceId,
      toneId: rawTts.toneId,
      createdAt: rawTts.createdAt,
      transcript: rawTts.transcript,
      format: rawTts.format,
      provider: rawTts.provider
    } as MessageTTSAudio;
  }, [message.metadata]);
  const ttsAudio = persistedTtsAudio || getTTSAudio(message.id);
  const ttsLoading = isTTSLoading(message.id);

  useEffect(() => {
    if (prevStatusRef.current === 'sending' && message.status === 'sent') {
      setShowSendGlow(true);
      const timer = setTimeout(() => setShowSendGlow(false), 500);
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = message.status;
  }, [message.status]);

  const isUser = message.sender_type === 'user';
  const isSystem = message.sender_type === 'system';
  const senderId = message.sender_id || 'system';

  const customPersona = personas[senderId];
  const userProfile = useProfileStore(state => state.profile);
  const color = customPersona?.color || AI_COLORS[senderId] || AI_COLORS.system;
  const avatarUrl = isUser ? (userProfile?.avatar_url || undefined) : (customPersona?.avatar_url);
  const name = isUser ? (userProfile?.nickname || '我') : (customPersona?.name || AI_NAMES[senderId] || senderId);
  const avatarLetter = isUser ? (userProfile?.nickname?.charAt(0) || '我') : (AI_AVATAR_LETTERS[senderId] || name.charAt(0).toUpperCase());

  const effectiveDebateRole = debateRole || (message.metadata?.debate_role as DebateRole);
  const showDebateRole = isDebateMode && effectiveDebateRole && !isUser && !isSystem;

  const currentMsgIndex = allMessages.findIndex(m => m.id === message.id);
  const nextMsg = currentMsgIndex >= 0 ? allMessages[currentMsgIndex + 1] : undefined;
  const isLastInGroup = !nextMsg || nextMsg.sender_type !== message.sender_type || nextMsg.sender_id !== message.sender_id;

  const replyToMessages = useMemo(() => {
    if (!message.reply_to) return [];
    const replyIds = Array.isArray(message.reply_to) ? message.reply_to : [message.reply_to];
    return replyIds.map((id: string) => allMessages.find(m => m.id === id)).filter(Boolean);
  }, [message.reply_to, allMessages]);

  const handleDelete = async () => {
    if (deletingRef.current) return;
    const confirmed = await confirm({ title: '删除消息', description: '确定要删除这条消息吗？', danger: true });
    if (confirmed) {
      deletingRef.current = true;
      try {
        await deleteMessage(message.id, message.group_id);
      } finally {
        deletingRef.current = false;
      }
    }
  };

  const handleEdit = () => {
    if (!isUser) return;
    setEditContent(message.content);
    setIsEditing(true);
  };

  const handleSaveEdit = async () => {
    if (!editContent.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await editMessage(message.id, message.group_id, editContent.trim());
      setIsEditing(false);
    } catch (error) {
      showToast({ message: '编辑消息失败，请重试', type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent('');
  };

  const handleTTSClick = useCallback(() => {
    if (ttsLoading || ttsAudio) return;
    setTTSLoading(message.id, true);
    setShowTTSModal(true);
  }, [ttsLoading, ttsAudio, message.id, setTTSLoading]);

  const handleTTSSynthesized = useCallback((audio: MessageTTSAudio) => {
    setTTSAudio(message.id, audio);
    updateMessage(message.id, message.group_id, {
      metadata: {
        ...(message.metadata || {}),
        tts: audio
      }
    });
    setShowTTSModal(false);
  }, [message.id, message.group_id, message.metadata, setTTSAudio, updateMessage]);

  const handleTTSClose = useCallback(() => {
    setTTSLoading(message.id, false);
    setShowTTSModal(false);
  }, [message.id, setTTSLoading]);

  const handleTTSDelete = useCallback(async () => {
    try {
      await api.deleteTTSMessageAudio(message.id);
      removeTTSAudio(message.id);

      const nextMetadata = { ...(message.metadata || {}) };
      delete nextMetadata.tts;
      updateMessage(message.id, message.group_id, { metadata: nextMetadata });
    } catch (error) {
      showToast({ message: '删除语音失败，请稍后重试', type: 'error' });
    }
  }, [message.id, message.group_id, message.metadata, removeTTSAudio, showToast, updateMessage]);

  if (isSystem) {
    const systemSenderId = message.sender_id;
    const systemPersona = personas[systemSenderId || ''];
    const systemColor = systemPersona?.color || AI_COLORS[systemSenderId || 'system'] || '#888';
    const systemAvatarUrl = systemPersona?.avatar_url;
    const systemName = systemPersona?.name || AI_NAMES[systemSenderId || 'system'] || systemSenderId || '系统';
    const systemAvatarLetter = AI_AVATAR_LETTERS[systemSenderId || 'system'] || (systemName || '系').charAt(0).toUpperCase();
    const isRefusal = message.metadata?.refusal === true;

    return (
      <div className="flex justify-center my-3 animate-fade-in">
        <div className={`flex items-center gap-2 backdrop-blur-sm px-3 py-1.5 rounded-full max-w-[85%] shadow-sm border ${isRefusal
          ? 'bg-amber-50/90 dark:bg-amber-900/30 border-amber-200/50 dark:border-amber-700/50'
          : 'bg-bg-surface2/80 dark:bg-bg-surface/80 border-border/30'
          }`}>
          {systemSenderId && (
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[8px] font-semibold flex-shrink-0 shadow-sm overflow-hidden"
              style={{
                backgroundColor: systemAvatarUrl ? 'transparent' : systemColor,
                backgroundImage: systemAvatarUrl ? `url(${sanitizeUrl(systemAvatarUrl)})` : 'none',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}
            >
              {!systemAvatarUrl && systemAvatarLetter}
            </div>
          )}
          {isRefusal && (
            <svg className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          )}
          <div className={`text-xs text-center ${isRefusal ? 'text-amber-700 dark:text-amber-300' : 'text-text-muted'}`}>
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {showTimeDivider && (
        <div className="message-time-divider">
          <span>{formatTimeDivider(message.created_at)}</span>
        </div>
      )}

      <motion.div
        className={`flex gap-1.5 md:gap-3 ${isLastInGroup ? 'mb-2.5 md:mb-4' : 'mb-0.5 md:mb-1'} ${isUser ? 'flex-row-reverse' : 'flex-row'} group`}
        style={{ willChange: 'transform, opacity' }}
        data-message-id={message.id}
        onContextMenu={isMultiSelectMode ? undefined : (e) => handleContextMenu(e, message.id)}
        {...(isMultiSelectMode ? {} : handleLongPress(message.id))}
        onClick={(e) => {
          const target = e.currentTarget;
          if (target.classList.contains('highlight-message')) {
            target.classList.remove('highlight-message');
          }
        }}
        initial={isUser ? messageAnimations.userMessage.initial : messageAnimations.aiMessage.initial}
        animate={isUser ? messageAnimations.userMessage.animate : messageAnimations.aiMessage.animate}
        transition={isUser ? messageAnimations.userMessage.transition : messageAnimations.aiMessage.transition}
      >
        {!isUser && (
          <div
            className="w-9 h-9 rounded flex items-center justify-center text-white font-semibold text-xs md:text-sm flex-shrink-0 shadow-sm overflow-hidden cursor-pointer hover:ring-2 hover:ring-offset-2 hover:ring-gray-300 transition-all"
            style={{
              backgroundColor: avatarUrl ? 'transparent' : color,
              backgroundImage: avatarUrl ? `url(${sanitizeUrl(avatarUrl)})` : 'none',
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setAIInfoPosition({ x: rect.right + 10, y: rect.top });
              setShowAIInfo(true);
            }}
          >
            {!avatarUrl && avatarLetter}
          </div>
        )}

        {isUser && userProfile?.avatar_url && (
          <div
            className="w-9 h-9 rounded flex items-center justify-center text-white font-semibold text-xs md:text-sm flex-shrink-0 shadow-sm overflow-hidden ml-1.5 md:ml-4"
            style={{
              backgroundImage: `url(${sanitizeUrl(userProfile.avatar_url)})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
          />
        )}

        <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} ${isUser ? 'max-w-[75%] md:max-w-[70%] mr-1.5 md:mr-4' : 'max-w-[75%] md:max-w-[75%] ai-message-bubble-container ml-0.5 md:ml-3'}`}>
          {!isUser && (
            <div className="flex items-center gap-1.5 md:gap-2 mb-0.5 md:mb-1 ml-1 flex-wrap">
              {showDebateRole && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
                  style={{
                    backgroundColor: `${DEBATE_ROLE_COLORS[effectiveDebateRole] || '#6b7280'}20`,
                    color: DEBATE_ROLE_COLORS[effectiveDebateRole] || '#6b7280'
                  }}
                >
                  {DEBATE_ROLE_ICONS[effectiveDebateRole] || ''}
                  {DEBATE_ROLE_NAMES[effectiveDebateRole] || effectiveDebateRole}
                </span>
              )}
              <span className="text-xs font-bold" style={{ color }}>
                {name}
              </span>
              {!!message.metadata?.source && (
                <span className="text-xs text-text-muted bg-bg-surface2 px-1.5 py-0.5 rounded">
                  {String(message.metadata.source) === 'debate' ? <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" /></svg> 辩论</> :
                    String(message.metadata.source) === 'reply' ? <><svg className="w-3 h-3 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg> 回复</> :
                      String(message.metadata.source)}
                </span>
              )}
            </div>
          )}

          {replyToMessages.length > 0 && replyToMessages.map((replyTarget, idx) => {
            const replySenderType = replyTarget!.sender_type;
            const replySenderId = replyTarget!.sender_id || '';
            // 正确获取引用消息发送者名称：用户消息使用昵称，AI消息使用AI_NAMES映射
            const replySenderName = replySenderType === 'user'
              ? (userProfile?.nickname || '用户')
              : (personas[replySenderId]?.name || AI_NAMES[replySenderId] || replySenderId);
            const replySenderColor = replySenderType === 'user'
              ? '#171717'
              : (personas[replySenderId]?.color || AI_COLORS[replySenderId] || AI_COLORS.system);
            const replySenderAvatar = replySenderType === 'user'
              ? null
              : personas[replySenderId]?.avatar_url;
            const replyContent = replyTarget!.content || '';
            const replyTruncated = replyContent.length > 60
              ? replyContent.substring(0, 60) + '...'
              : replyContent;

            return (
              <div
                key={replyTarget!.id}
                className={`mb-1.5 px-3 py-2 rounded-lg text-xs max-w-[300px] cursor-pointer hover:bg-opacity-80 transition-all quote-card ${isUser ? 'mr-2 bg-green-50/80 dark:bg-green-900/30 border-l-[3px] border-green-400' : 'ml-1 bg-bg-surface2 border-l-[3px] border-border'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const element = document.querySelector(`[data-message-id="${replyTarget!.id}"]`);
                  if (!element) {
                    showToast({ message: '引用的消息不存在或尚未加载', type: 'warning' });
                    return;
                  }
                  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  element.classList.add('highlight-message');
                }}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  {replyToMessages.length > 1 && (
                    <span className="text-text-muted text-[9px] bg-bg-surface3 px-1 py-0.5 rounded">{idx + 1}/{replyToMessages.length}</span>
                  )}
                  <span className="text-text-muted text-[10px]"><svg className="w-2.5 h-2.5 inline" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg></span>
                  <div
                    className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[8px] shadow-sm overflow-hidden flex-shrink-0"
                    style={{
                      backgroundColor: replySenderAvatar ? 'transparent' : replySenderColor,
                      backgroundImage: replySenderAvatar ? `url(${sanitizeUrl(replySenderAvatar)})` : 'none',
                      backgroundSize: 'cover',
                      backgroundPosition: 'center'
                    }}
                  >
                    {!replySenderAvatar && (replySenderType === 'user'
                      ? (userProfile?.nickname?.charAt(0) || '用')
                      : (AI_AVATAR_LETTERS[replySenderId] || replySenderName.charAt(0).toUpperCase()))}
                  </div>
                  <span style={{ color: replySenderColor }} className="font-semibold">
                    {replySenderName}
                  </span>
                </div>
                <div className="text-text-secondary line-clamp-2 leading-relaxed pl-4 border-l-2 border-border">
                  {replyTruncated}
                </div>
              </div>
            );
          })}

          <div className={`message-bubble ${isUser ? 'user-message rounded-lg' : 'ai-message rounded-lg'} ${showSendGlow ? 'message-send-glow' : ''}`}>
            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-2">
                <AttachmentStack
                  attachments={message.attachments}
                  isUser={isUser}
                />
              </div>
            )}

            {isEditing ? (
              <div className="flex flex-col gap-2">
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value.length > 5000 ? e.target.value.substring(0, 5000) : e.target.value)}
                  maxLength={5000}
                  className="w-full min-h-[60px] p-2 text-[15px] border border-border rounded-lg resize-none focus:outline-none focus:border-accent bg-bg-surface text-text-primary"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSaveEdit();
                    }
                    if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={handleCancelEdit}
                    className="px-3 py-1 text-sm text-text-secondary hover:text-text-primary"
                    disabled={isSaving}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveEdit}
                    disabled={!editContent.trim() || isSaving}
                    className="px-3 py-1 text-sm bg-accent text-white rounded hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <MessageContent
                content={message.content}
                contentType={message.content_type}
                isUser={isUser}
                isStreaming={message.is_streaming}
              />
            )}

            {!ttsAudio && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleTTSClick}
                  disabled={ttsLoading}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${isUser
                    ? 'bg-black/5 text-text-secondary hover:bg-black/10'
                    : 'bg-purple-500/10 text-purple-600 hover:bg-purple-500/15 dark:text-purple-300'
                    } ${ttsLoading ? 'opacity-60 cursor-not-allowed' : ''}`}
                  title="生成语音"
                >
                  <svg className={`w-3.5 h-3.5 ${ttsLoading ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                  </svg>
                  <span>{ttsLoading ? '语音生成中...' : '生成语音'}</span>
                </button>
              </div>
            )}

            {ttsAudio && (
              <AudioPlayer
                messageId={message.id}
                audioUrl={ttsAudio.audioUrl}
                duration={ttsAudio.duration}
                onDelete={handleTTSDelete}
              />
            )}
            {!!message.metadata?.agent_call && (
              <span className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent/10 text-accent">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                </svg>
                这条信息调用了 {(message.metadata.agent_call as Record<string, unknown>).agentName as string} 智能体
              </span>
            )}
          </div>

          <div className={`flex items-center gap-1 md:gap-2 mt-0.5 md:mt-1 ${isUser ? 'flex-row-reverse mr-0.5 md:mr-2' : 'ml-1'}`}>
            <button
              type="button"
              className="text-text-muted cursor-pointer hover:text-text-secondary transition-colors bg-transparent border-none outline-none px-1 py-0.5 rounded hover:bg-bg-surface2 select-none underline decoration-dotted underline-offset-2 hover:decoration-solid group relative"
              style={{ fontSize: 'var(--chat-timestamp-font-size)' }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const nextIndex = (timeFormatIndexRef.current + 1) % TIME_FORMATS.length;
                timeFormatIndexRef.current = nextIndex;
                setTimeFormatEntry(message.id, nextIndex);
                setTimeFormatVersion(v => v + 1);
              }}
              title="点击切换时间格式"
            >
              {(() => {
                const format = TIME_FORMATS[timeFormatIndexRef.current];
                const time = dayjs(message.created_at);
                if (format.key === 'relative') {
                  return time.fromNow();
                }
                return time.format(format.format);
              })()}
              <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-[10px]">🕐</span>
            </button>

            {message.is_edited && (
              <span className="text-text-muted" style={{ fontSize: 'var(--chat-timestamp-font-size)' }} title={message.edited_at ? `编辑于 ${dayjs(message.edited_at).format('YYYY-MM-DD HH:mm')}` : ''}>
                已编辑
              </span>
            )}

            {isUser && message.status === 'sending' && (
              <span className="text-text-muted flex items-center gap-1" style={{ fontSize: 'var(--chat-timestamp-font-size)' }}>
                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                发送中
              </span>
            )}

            {isUser && message.status === 'failed' && (
              <div className="flex items-center gap-2">
                <span className="text-red-500" style={{ fontSize: 'var(--chat-timestamp-font-size)' }}>发送失败</span>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (currentGroup && message.tempId) {
                      await retryMessage(currentGroup.id, message.tempId);
                    }
                  }}
                  className="text-blue-500 hover:text-blue-600 underline"
                  style={{ fontSize: 'var(--chat-timestamp-font-size)' }}
                >
                  重试
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (currentGroup && message.tempId) {
                      removeFailedMessage(currentGroup.id, message.tempId);
                    }
                  }}
                  className="text-text-muted hover:text-text-secondary"
                  style={{ fontSize: 'var(--chat-timestamp-font-size)' }}
                >
                  删除
                </button>
              </div>
            )}

            {isUser && (message.status === 'sent' || (!message.status && message.status !== 'failed')) && (
              <div className="message-status sent">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
            )}
          </div>

          {!isMultiSelectMode && (
            <MessageActions
              messageId={message.id}
              isUser={isUser}
              content={message.content}
              likes={message.likes}
              likedBy={message.liked_by}
              likesCount={message.likes_count}
              dislikes={message.dislikes}
              dislikedBy={message.disliked_by}
              commentsCount={message.comments?.length}
              onReply={() => onReply?.(message.id)}
              onEdit={isUser ? handleEdit : undefined}
              onDelete={handleDelete}
              onToggleComments={() => setShowComments(!showComments)}
              showComments={showComments}
            />
          )}

          <CommentSection
            messageId={message.id}
            groupId={message.group_id}
            comments={message.comments || []}
            isOpen={showComments}
            onClose={() => setShowComments(false)}
          />
        </div>
      </motion.div>

      {contextMenu && contextMenu.messageId === message.id && (
        <MessageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={[
            { label: '复制', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>, onClick: () => { try { if (navigator.clipboard) { navigator.clipboard.writeText(message.content); } else { const ta = document.createElement('textarea'); ta.value = message.content; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } } catch { } } },
            { label: '回复', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>, onClick: () => { if (onReply) onReply(message.id); addReplyingTo(message.id); } },
            ...(isUser ? [{ label: '编辑', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>, onClick: handleEdit }] : []),
            ...(isUser ? [{ label: '删除', icon: <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.108 0 00-7.5 0" /></svg>, onClick: handleDelete, danger: true }] : []),
          ]}
          onClose={closeContextMenu}
        />
      )}

      {showAIInfo && !isUser && (
        <AIInfoPopup
          aiId={senderId}
          isOpen={showAIInfo}
          onClose={() => setShowAIInfo(false)}
          position={aiInfoPosition}
        />
      )}

      {showTTSModal && (
        <TTSSynthesizeModal
          text={message.content}
          messageId={message.id}
          onClose={handleTTSClose}
          onSynthesized={handleTTSSynthesized}
        />
      )}
      {ConfirmModal}
      {Toast}
    </>
  );
};

export const MessageBubble = React.memo(MessageBubbleComponent, (prevProps, nextProps) => {
  const prevLikedBy = prevProps.message.liked_by || [];
  const nextLikedBy = nextProps.message.liked_by || [];
  const prevDislikedBy = prevProps.message.disliked_by || [];
  const nextDislikedBy = nextProps.message.disliked_by || [];

  return (
    prevProps.message.id === nextProps.message.id &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.is_streaming === nextProps.message.is_streaming &&
    prevProps.message.status === nextProps.message.status &&
    prevProps.message.is_edited === nextProps.message.is_edited &&
    prevProps.message.likes?.length === nextProps.message.likes?.length &&
    prevProps.message.dislikes === nextProps.message.dislikes &&
    prevLikedBy.length === nextLikedBy.length &&
    prevLikedBy.every((id: string, i: number) => id === nextLikedBy[i]) &&
    prevDislikedBy.length === nextDislikedBy.length &&
    prevDislikedBy.every((id: string, i: number) => id === nextDislikedBy[i]) &&
    prevProps.message.comments?.length === nextProps.message.comments?.length &&
    prevProps.message.comments?.[prevProps.message.comments.length - 1]?.id === nextProps.message.comments?.[nextProps.message.comments.length - 1]?.id &&
    prevProps.message.attachments?.length === nextProps.message.attachments?.length &&
    prevProps.showTimeDivider === nextProps.showTimeDivider &&
    prevProps.isMultiSelectMode === nextProps.isMultiSelectMode &&
    prevProps.isDebateMode === nextProps.isDebateMode &&
    prevProps.debateRole === nextProps.debateRole
  );
});

function formatTimeDivider(timestamp: string): string {
  const time = dayjs(timestamp);
  const now = dayjs();
  const diffMinutes = now.diff(time, 'minute');
  const diffHours = now.diff(time, 'hour');
  const diffDays = now.diff(time, 'day');

  if (diffMinutes < 5) return '刚刚';
  if (diffHours < 1) return `${diffMinutes}分钟前`;
  if (diffDays < 1) return time.format('HH:mm');
  if (diffDays === 1) return '昨天 ' + time.format('HH:mm');
  if (diffDays < 7) return `${diffDays}天前`;
  return time.format('MM-DD HH:mm');
}
