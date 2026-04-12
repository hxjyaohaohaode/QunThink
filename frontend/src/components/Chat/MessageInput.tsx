import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useGroupsStore } from '../../stores/groupsStore';
import { useMessagesStore } from '../../stores/messagesStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../services/api';
import { AI_NAMES, AI_COLORS } from '../../types';
import { stopGeneration } from '../../services/websocket';

const AI_LIST = [
  { id: 'deepseek', name: 'deepseek-chat', color: '#fd9744' },
  { id: 'deepseek_reasoner', name: 'deepseek-reasoner', color: '#f97316' },
  { id: 'glm', name: 'GLM-4.5-Air', color: '#34d399' },
  { id: 'mimo', name: 'mimo-v2-flash', color: '#f59e0b' },
  { id: 'qwen', name: 'Qwen3.5-Flash', color: '#a78bfa' }
];

export function MessageInput() {
  const [input, setInput] = useState('');
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  const { currentGroup } = useGroupsStore();
  const { sendMessage, sending, messages } = useMessagesStore();
  const { replyingTo, setReplyingTo, typingIndicators } = useUIStore();

  const isAnyAITyping = currentGroup
    ? Object.values(typingIndicators[currentGroup.id] || {}).some(v => v === true)
    : false;

  // 获取被回复的消息
  const replyToMessage = replyingTo && currentGroup
    ? messages[currentGroup.id]?.find(m => m.id === replyingTo)
    : null;

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`;
    }
  }, [input]);

  // 当设置回复时，自动聚焦输入框
  useEffect(() => {
    if (replyingTo && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyingTo]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    const lastChar = value.slice(-1);
    const cursorPos = value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (lastChar === '@' || (atIndex !== -1 && atIndex === cursorPos - 1)) {
      setShowMentions(true);
      setMentionFilter('');
    } else if (atIndex !== -1) {
      const filter = textBeforeCursor.slice(atIndex + 1);
      if (!filter.includes(' ')) {
        setShowMentions(true);
        setMentionFilter(filter.toLowerCase());
      } else {
        setShowMentions(false);
      }
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (aiId: string) => {
    const cursorPos = input.lastIndexOf('@');
    const newInput = input.slice(0, cursorPos) + `@${aiId} `;
    setInput(newInput);
    setShowMentions(false);
    textareaRef.current?.focus();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (selectedFiles) {
      setFiles([...files, ...Array.from(selectedFiles)]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const handleSend = useCallback(async () => {
    if (sendingRef.current) return;
    if (!currentGroup || (!input.trim() && files.length === 0) || sending) return;

    if (files.length > 0) {
      setUploading(true);
      try {
        for (const file of files) {
          await api.uploadFile(file, currentGroup.id);
        }
        setFiles([]);
      } catch (error) {
        console.error('File upload error:', error);
      }
      setUploading(false);
    }

    if (input.trim()) {
      sendingRef.current = true;
      try {
        await sendMessage(currentGroup.id, input.trim(), replyingTo || undefined);
        setInput('');
        setReplyingTo(null);
      } finally {
        sendingRef.current = false;
      }
    }
  }, [currentGroup, input, files, sending, replyingTo, sendMessage, setReplyingTo]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleCancelReply = () => {
    setReplyingTo(null);
  };

  const filteredAIs = AI_LIST.filter(
    (ai) => !mentionFilter || ai.name.toLowerCase().includes(mentionFilter)
  );

  return (
    <div className="bg-bg-surface border-t border-gray-200 p-4">
      {/* 回复引用 */}
      {replyToMessage && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-gray-100 rounded-lg">
          <div 
            className="w-1 h-8 rounded-full"
            style={{ backgroundColor: AI_COLORS[replyToMessage.sender_id || 'system'] || '#999' }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-caption text-text-muted">
              回复 {AI_NAMES[replyToMessage.sender_id || ''] || replyToMessage.sender_id}
            </div>
            <div className="text-caption text-text-secondary truncate">
              {replyToMessage.content.substring(0, 50)}{replyToMessage.content.length > 50 ? '...' : ''}
            </div>
          </div>
          <button
            onClick={handleCancelReply}
            className="p-1 hover:bg-gray-200 rounded text-text-muted hover:text-text-primary transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {files.map((file, index) => (
            <div
              key={index}
              className="flex items-center gap-2 bg-bg-surface2 rounded-button px-3 py-1.5"
            >
              <span className="text-caption text-text-secondary truncate max-w-[150px]">
                {file.name}
              </span>
              <button
                onClick={() => removeFile(index)}
                className="text-text-muted hover:text-error transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-3">
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={currentGroup ? "输入消息，@提及 AI 成员..." : "选择一个群组开始聊天"}
            disabled={!currentGroup || sending}
            className="w-full bg-bg-surface2 border border-gray-200 rounded-button px-4 py-3 text-body text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-user/50 disabled:opacity-50"
            rows={1}
          />

          {showMentions && filteredAIs.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 bg-bg-surface border border-gray-200 rounded-card shadow-lg overflow-hidden z-10">
              {filteredAIs.map((ai) => (
                <button
                  key={ai.id}
                  onClick={() => insertMention(ai.id)}
                  className="w-full px-4 py-2 text-left hover:bg-bg-surface3 transition-colors flex items-center gap-2"
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: ai.color }}
                  />
                  <span className="text-body text-text-primary">{ai.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.py,.js,.ts,.jsx,.tsx,.html,.css,.json,.png,.jpg,.jpeg,.gif"
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!currentGroup}
          className="p-3 rounded-button bg-bg-surface2 hover:bg-bg-surface3 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          title="上传文件"
        >
          📎
        </button>

        {isAnyAITyping && (
          <button
            onClick={() => currentGroup && stopGeneration(currentGroup.id)}
            className="p-3 rounded-button bg-red-500 hover:bg-red-600 text-white transition-colors"
            title="停止生成"
          >
            ⏹️ 停止
          </button>
        )}

        <button
          onClick={handleSend}
          disabled={!currentGroup || (!input.trim() && files.length === 0) || sending || uploading}
          className="btn-primary px-6 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {sending || uploading ? '发送中...' : '➤'}
        </button>
      </div>
    </div>
  );
}
