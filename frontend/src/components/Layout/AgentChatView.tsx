import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useAgentsStore } from '../../stores/agentsStore';
import { AgentChatMessage } from '../../types';
import { motion, AnimatePresence } from 'framer-motion';
import { avatarBackgroundImageStyle } from '../Common/Avatar';

interface AgentChatViewProps {
  agentId: string;
  onBack: () => void;
}

interface ActiveSuggestions {
  msgId: string;
  items: string[];
}

const AVATAR_COLORS = [
  '#f97316', '#8b5cf6', '#06b6d4', '#10b981',
  '#ef4444', '#f59e0b', '#3b82f6', '#ec4899',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const ALLOWED_FILE_TYPES = {
  images: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/flac'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
  documents: [
    'application/pdf', 'text/plain', 'text/csv', 'text/markdown',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
};

const ALLOWED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg',
  'pdf',
  'txt', 'csv', 'md', 'xml', 'json', 'yaml', 'yml', 'toml',
  'mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv', 'quicktime',
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'wma',
  'doc', 'docx',
  'xls', 'xlsx',
  'ppt', 'pptx',
  'py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'java', 'c', 'cpp', 'go', 'rs'
]);

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_FILES = 10;

const SuggestionButtons = React.memo(function SuggestionButtons({
  suggestions,
  onClick,
  onRefresh,
  disabled
}: {
  suggestions: string[];
  onClick: (suggestion: string) => void;
  onRefresh?: () => void;
  disabled: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className="flex flex-wrap gap-2 mt-2.5 ml-1 items-center"
    >
      {suggestions.map((suggestion, idx) => (
        <motion.button
          key={`suggestion-${idx}`}
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.12 } }}
          transition={{ duration: 0.2, delay: idx * 0.06 }}
          onClick={() => onClick(suggestion)}
          disabled={disabled}
          className="group flex items-center gap-1.5 px-3.5 py-2 bg-bg-surface2 hover:bg-accent/8 border border-border-subtle hover:border-accent/25 rounded-xl text-xs text-text-secondary hover:text-accent transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          <svg className="w-3.5 h-3.5 opacity-35 group-hover:opacity-60 transition-opacity flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
          </svg>
          <span className="max-w-[220px] truncate">{suggestion}</span>
        </motion.button>
      ))}
      {onRefresh && (
        <motion.button
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, delay: suggestions.length * 0.06 }}
          onClick={onRefresh}
          disabled={disabled}
          className="flex items-center gap-1 px-2.5 py-2 text-xs text-text-muted hover:text-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          title="换一批"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
          </svg>
          <span>换一批</span>
        </motion.button>
      )}
    </motion.div>
  );
});

export function AgentChatView({ agentId, onBack }: AgentChatViewProps) {
  const agents = useAgentsStore((s) => s.agents);
  const currentAgent = useAgentsStore((s) => s.currentAgent);
  const selectAgent = useAgentsStore((s) => s.selectAgent);
  const fetchAgentMessages = useAgentsStore((s) => s.fetchAgentMessages);
  const sendAgentMessage = useAgentsStore((s) => s.sendAgentMessage);
  const stopAgentMessage = useAgentsStore((s) => s.stopAgentMessage);
  const fetchAgentSuggestions = useAgentsStore((s) => s.fetchAgentSuggestions);
  const agentMessages = useAgentsStore((s) =>
    s.agentMessages.get(agentId)
  );
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [initialSuggestions, setInitialSuggestions] = useState<string[]>([]);
  const [activeSuggestions, setActiveSuggestions] = useState<ActiveSuggestions | null>(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const viewRef = useRef({ agentId, generation: 0 });
  if (viewRef.current.agentId !== agentId) viewRef.current = { agentId, generation: viewRef.current.generation + 1 };
  const sendAttemptRef = useRef(0);
  const composerRevisionRef = useRef(0);

  const mountedRef = useRef(true);
  const [suggestionRevision, setSuggestionRevision] = useState(0);
  const suggestionRequestRef = useRef<{ key: string; promise: Promise<string[]> } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendingRef = useRef(false);

  const agent = currentAgent?.id === agentId ? currentAgent : agents.find((a) => a.id === agentId);


  const messages = agentMessages || [];
  const isAgentStreaming = messages.some((m) => m.is_streaming);

  const lastFinishedAgentMsgId = messages.length > 0
    ? [...messages].reverse().find(m => m.sender_type === 'agent' && !m.is_streaming && !m.response_state)?.id
    : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    sendAttemptRef.current++;
    composerRevisionRef.current++;
    sendingRef.current = false;
    setIsSending(false);
    setInputValue('');
    setAttachedFiles([]);
    setSendNotice(null);
    let isCancelled = false;
    setMessagesLoaded(false);
    setInitialSuggestions([]);
    setActiveSuggestions(null);
    setLoadingSuggestions(false);
    selectAgent(agentId);
    fetchAgentMessages(agentId).then(() => {
      if (!isCancelled && mountedRef.current) setMessagesLoaded(true);
    });
    return () => { isCancelled = true; };
  }, [agentId]);

  const getLocalSuggestions = useCallback((isInitial: boolean): string[] => {
    if (!agent) return [];
    const desc = agent.description || '';
    const name = agent.name || '';
    if (isInitial) {
      if (desc.includes('编程') || desc.includes('代码') || desc.includes('开发')) {
        return ['帮我写一个实用的代码示例', '这个技术栈有哪些最佳实践？', '帮我分析一下常见的架构模式'];
      }
      if (desc.includes('写作') || desc.includes('文案') || desc.includes('创作')) {
        return ['帮我写一篇关于这个主题的文章', '能换个风格再写一版吗？', '给我一些创意灵感和方向'];
      }
      if (desc.includes('翻译') || desc.includes('语言')) {
        return ['帮我翻译这段内容', '解释一下这个词的用法和语境', '帮我纠正这段话的语法错误'];
      }
      if (desc.includes('健身') || desc.includes('运动') || desc.includes('健康')) {
        return ['帮我制定一个适合我的训练计划', '有哪些适合初学者的动作？', '如何科学地避免运动损伤？'];
      }
      if (desc.includes('学习') || desc.includes('教育') || desc.includes('考试')) {
        return ['帮我梳理一下这个领域的知识框架', '有哪些重点和难点需要掌握？', '给我出几道练习题检验一下'];
      }
      return [`你能帮我做什么？介绍一下你的功能`, `${name}有什么独特的优势？`, '给我一个具体的使用场景'];
    }
    return ['能详细解释一下吗？', '有其他方案吗？', '能举个例子吗？'];
  }, [agent]);

  useEffect(() => {
    // Loading/output are results of this effect, never triggers for cancelling it.
    if (!agent?.enable_suggestions || !messagesLoaded || isSending || isAgentStreaming || messages[messages.length - 1]?.response_state) {
      setLoadingSuggestions(false);
      return;
    }
    const isInitial = messages.length === 0;
    if (!isInitial && !lastFinishedAgentMsgId) {
      setLoadingSuggestions(false);
      return;
    }
    const key = JSON.stringify([agentId, isInitial ? 'initial' : lastFinishedAgentMsgId, suggestionRevision]);
    let cancelled = false;
    setLoadingSuggestions(true);
    // Reattach to the same request after effect replay; never dispatch twice for
    // a loading-state render or StrictMode. An explicit refresh gets a new key.
    if (suggestionRequestRef.current?.key !== key) {
      suggestionRequestRef.current = { key, promise: fetchAgentSuggestions(agentId) };
    }
    const apply = (received: string[]) => {
      if (cancelled || !mountedRef.current) return;
      const items = received.length ? received : getLocalSuggestions(isInitial);
      if (isInitial) setInitialSuggestions(items);
      else if (lastFinishedAgentMsgId) setActiveSuggestions({ msgId: lastFinishedAgentMsgId, items });
      setLoadingSuggestions(false);
    };
    suggestionRequestRef.current.promise.then(apply, () => apply([]));
    return () => { cancelled = true; };
  }, [agentId, agent?.enable_suggestions, messagesLoaded, messages.length,
    lastFinishedAgentMsgId, messages[messages.length - 1]?.response_state, isSending, isAgentStreaming, suggestionRevision,
    fetchAgentSuggestions, getLocalSuggestions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, initialSuggestions, activeSuggestions]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    composerRevisionRef.current++;
    const files = Array.from(e.target.files || []);
    if (attachedFiles.length + files.length > MAX_FILES) return;
    const allAllowedTypes = [...ALLOWED_FILE_TYPES.images, ...ALLOWED_FILE_TYPES.audio, ...ALLOWED_FILE_TYPES.video, ...ALLOWED_FILE_TYPES.documents];
    const validFiles = files.filter(file => {
      if (file.size > MAX_FILE_SIZE) return false;
      if (file.type && allAllowedTypes.includes(file.type)) return true;
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (ALLOWED_EXTENSIONS.has(ext)) return true;
      if (!file.type || file.type === 'application/octet-stream') return true;
      return false;
    });
    setAttachedFiles(prev => [...prev, ...validFiles]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [attachedFiles.length]);

  const removeAttachedFile = useCallback((index: number) => {
    composerRevisionRef.current++;
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const getFileIcon = (file: File): React.ReactNode => {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const mimeType = file.type || '';
    const renderIcon = (d: string): React.ReactNode => (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    );
    if (mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return renderIcon('m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z');
    if (mimeType.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'wma', 'ogg'].includes(ext)) return renderIcon('M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z');
    if (mimeType.startsWith('video/') || ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv'].includes(ext)) return renderIcon('m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z');
    if (ext === 'pdf') return renderIcon('M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z');
    if (['doc', 'docx'].includes(ext)) return renderIcon('M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z');
    if (['xls', 'xlsx', 'csv'].includes(ext)) return renderIcon('M3.75 3v11.25A2.25 2.25 0 0 0 6 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0 1 18 16.5h-2.25m-7.5 0h7.5m-7.5 0-1 3m8.5-3 1 3m0 0 .5 1.5m-.5-1.5h-9.5m0 0-.5 1.5m.75-9 3-3 2.148 2.148A12.061 12.061 0 0 1 16.5 7.605');
    if (['ppt', 'pptx'].includes(ext)) return renderIcon('M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z');
    if (['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'toml'].includes(ext)) return renderIcon('M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z');
    if (['py', 'js', 'ts', 'jsx', 'tsx', 'html', 'css', 'java', 'c', 'cpp', 'go', 'rs'].includes(ext)) return renderIcon('M17.25 6.75 22.5 12l-5.25 5.25M6.75 17.25 1.5 12l5.25-5.25');
    return renderIcon('M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776');
  };

  const clearSuggestions = useCallback(() => {
    setInitialSuggestions([]);
    setActiveSuggestions(null);
  }, []);

  const refreshSuggestions = useCallback(() => {
    if (!agent?.enable_suggestions || loadingSuggestions) return;
    setSuggestionRevision(value => value + 1);
    setActiveSuggestions(null);
    setInitialSuggestions([]);
  }, [agent?.enable_suggestions, loadingSuggestions]);

  const handleSend = useCallback(async (overrideMessage?: string) => {
    const originalInput = overrideMessage ?? inputValue;
    const content = originalInput.trim();
    if ((!content && attachedFiles.length === 0) || isSending || isAgentStreaming) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    const view = viewRef.current;
    const attempt = ++sendAttemptRef.current;
    const revision = composerRevisionRef.current;
    const ownsView = () => mountedRef.current && viewRef.current === view && sendAttemptRef.current === attempt;
    setSendNotice(null);

    const messageText = content || (attachedFiles.length > 0 ? `请分析我上传的${attachedFiles.length}个文件` : '');
    const filesToSend = [...attachedFiles];

    setInputValue('');
    setAttachedFiles([]);
    clearSuggestions();
    setIsSending(true);
    try {
      await sendAgentMessage(agentId, messageText, filesToSend);
    } catch (error) {
      if (ownsView() && composerRevisionRef.current === revision) {
        setInputValue(originalInput);
        setAttachedFiles(filesToSend);
        const reason = error instanceof Error ? error.message : '回复未完成';
        setSendNotice(`${reason}。原输入已保留；消息可能已经保存，请先核对会话，再决定是否重新发送。`);
      }
    } finally {
      if (ownsView()) { setIsSending(false); sendingRef.current = false; }
    }
  }, [inputValue, attachedFiles, isSending, isAgentStreaming, agentId, clearSuggestions, sendAgentMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleSuggestionClick = useCallback((suggestion: string) => {
    composerRevisionRef.current++;
    setInputValue(suggestion);
    setAttachedFiles([]);
    clearSuggestions();
    setTimeout(() => {
      inputRef.current?.focus();
    }, 50);
  }, [clearSuggestions]);

  const displayMessages: AgentChatMessage[] = messages.length > 0
    ? messages
    : agent
      ? [{
        id: 'opening',
        agent_id: agentId,
        sender_type: 'agent',
        content: agent.opening_message,
        created_at: agent.created_at,
      }]
      : [];

  const avatarColor = agent ? getAvatarColor(agent.name) : '#737373';
  const showInitialSuggestions = messages.length === 0 && initialSuggestions.length > 0 && !loadingSuggestions;
  const isSuggestionDisabled = isSending || isAgentStreaming;

  if (!agent) {
    return (
      <div className="h-full flex flex-col bg-bg-primary items-center justify-center">
        <div className="text-text-muted text-sm">该智能体不存在或已被删除</div>
        <button onClick={onBack} className="mt-4 px-4 py-2 text-sm text-accent hover:underline">返回</button>
      </div>
    );
  }


  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-surface border-b border-border-subtle flex-shrink-0">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-bg-surface2 transition-colors"
        >
          <svg className="w-5 h-5 text-text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        {agent && (
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 shadow-sm overflow-hidden"
              style={{
                backgroundColor: agent.avatar_url ? 'transparent' : avatarColor,
                backgroundImage: avatarBackgroundImageStyle(agent.avatar_url),
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              {!agent.avatar_url && agent.name.charAt(0)}
            </div>
            <span className="text-sm font-semibold text-text-primary truncate">{agent.name}</span>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {displayMessages.map((msg) => {
          const isUser = msg.sender_type === 'user';
          const isSuggestionActive = activeSuggestions && activeSuggestions.msgId === msg.id;

          return (
            <div
              key={msg.id}
              className={`flex gap-2.5 mb-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
            >
              {!isUser && agent && (
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-semibold flex-shrink-0 shadow-sm overflow-hidden mt-1"
                  style={{
                    backgroundColor: agent.avatar_url ? 'transparent' : avatarColor,
                    backgroundImage: avatarBackgroundImageStyle(agent.avatar_url),
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                >
                  {!agent.avatar_url && agent.name.charAt(0)}
                </div>
              )}
              <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[75%]`}>
                <div
                  className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words ${isUser
                    ? 'bg-accent text-white rounded-tr-sm'
                    : 'bg-bg-surface text-text-primary rounded-tl-sm border border-border-subtle'
                    }`}
                >
                  {msg.is_streaming && !msg.content ? (
                    <div className="flex items-center gap-1.5 py-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  ) : (
                    <>
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className={`flex flex-wrap gap-1.5 mb-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
                          {msg.attachments.map((att, idx) => (
                            <span
                              key={idx}
                              className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs ${isUser
                                ? 'bg-white/20 text-white/90'
                                : 'bg-bg-surface2 text-text-secondary'
                                }`}
                            >
                              <span className="inline-flex">
                                {att.type === 'image' ? (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                                  </svg>
                                ) : att.type === 'audio' ? (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
                                  </svg>
                                ) : att.type === 'video' ? (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
                                  </svg>
                                ) : (
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                                  </svg>
                                )}
                              </span>
                              <span className="max-w-[120px] truncate">{att.filename}</span>
                            </span>
                          ))}
                        </div>
                      )}
                      {msg.content}
                      {msg.response_state && <p role="status" className="mt-2 text-sm text-red-500">
                        {msg.response_state === 'incomplete' ? '回复未完成，已收到的内容仅供参考。' : '未能完成回复。'}
                        {msg.response_error}
                      </p>}
                      {msg.is_streaming && msg.content && (
                        <span className="inline-block w-0.5 h-4 bg-text-primary ml-0.5 animate-pulse align-text-bottom" />
                      )}
                    </>
                  )}
                </div>
                <AnimatePresence>
                  {isSuggestionActive && (
                    <SuggestionButtons
                      suggestions={activeSuggestions.items}
                      onClick={handleSuggestionClick}
                      onRefresh={refreshSuggestions}
                      disabled={isSuggestionDisabled}
                    />
                  )}
                </AnimatePresence>
              </div>
            </div>
          );
        })}

        <AnimatePresence>
          {showInitialSuggestions && (
            <motion.div
              key="initial-suggestions"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="flex justify-start mb-3"
            >
              <div className="ml-[42px]">
                <SuggestionButtons
                  suggestions={initialSuggestions}
                  onClick={handleSuggestionClick}
                  onRefresh={refreshSuggestions}
                  disabled={isSuggestionDisabled}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {loadingSuggestions && (
          <div className="flex justify-start mb-3">
            <div className="ml-[42px] flex items-center gap-1.5 px-3 py-2">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce" style={{ animationDelay: '300ms' }} />
              <span className="text-xs text-text-muted ml-1">生成建议中...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {sendNotice && <div role="alert" className="mx-4 mt-2 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-secondary">{sendNotice}</div>}

      {attachedFiles.length > 0 && (
        <div className="flex-shrink-0 px-4 py-2 bg-bg-surface border-t border-border-subtle">
          <div className="flex flex-wrap gap-2">
            {attachedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center gap-2 px-3 py-2 bg-bg-surface2 rounded-lg text-xs text-text-secondary border border-border-subtle"
              >
                <span className="text-lg">{getFileIcon(file)}</span>
                <span className="max-w-[150px] truncate">{file.name}</span>
                <button
                  onClick={() => removeAttachedFile(index)}
                  className="ml-1 text-text-muted hover:text-red-500 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-shrink-0 px-4 bg-bg-surface border-t border-border-subtle" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))', paddingTop: '0.75rem' }}>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isSending || isAgentStreaming || attachedFiles.length >= MAX_FILES}
            className="w-10 h-10 rounded-full bg-bg-surface2 flex items-center justify-center hover:bg-bg-surface3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            title="上传附件"
          >
            <svg className="w-5 h-5 text-text-secondary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => { composerRevisionRef.current++; setInputValue(e.target.value); }}
            onKeyDown={handleKeyDown}
            placeholder="输入消息或上传附件..."
            disabled={isSending || isAgentStreaming}
            className="flex-1 px-3.5 py-2.5 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50 transition-all"
          />
          {(isSending || isAgentStreaming) && <button
            onClick={() => stopAgentMessage(agentId)}
            className="px-3 py-2 rounded-lg bg-bg-surface2 text-sm text-text-secondary hover:bg-bg-surface3"
            aria-label="停止生成"
          >停止生成</button>}
          <button
            onClick={() => handleSend()}
            disabled={(!inputValue.trim() && attachedFiles.length === 0) || isSending || isAgentStreaming}
            className="w-10 h-10 rounded-full bg-accent flex items-center justify-center hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
          >
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
            </svg>
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.html,.css,.java,.c,.cpp,.go,.rs"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>
    </div>
  );
}
