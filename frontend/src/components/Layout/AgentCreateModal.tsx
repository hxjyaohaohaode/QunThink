import { useState } from 'react';
import { useAgentsStore } from '../../stores/agentsStore';
import { AgentQuestion } from '../../types';
import { useToast } from '../Common';

interface AgentCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
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

export function AgentCreateModal({ isOpen, onClose }: AgentCreateModalProps) {
  const { generateQuestions, createAgent, creatingAgent } = useAgentsStore();
  const { showToast, Toast } = useToast();

  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [avatarFile, setAvatarFile] = useState<string | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [openingMessage, setOpeningMessage] = useState('');
  const [enableSuggestions, setEnableSuggestions] = useState(true);
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [creating, setCreating] = useState(false);

  const isStep1Valid = name.trim() && description.trim() && openingMessage.trim();

  const handleNextStep = async () => {
    if (!isStep1Valid) return;
    setLoadingQuestions(true);
    try {
      const result = await generateQuestions({
        name: name.trim(),
        description: description.trim(),
        openingMessage: openingMessage.trim(),
      });
      setQuestions(result);
      setStep(2);
    } catch {
      showToast({ message: '生成问题失败，请重试', type: 'error' });
    } finally {
      setLoadingQuestions(false);
    }
  };

  const parseBooleanAnswer = (answer: string): boolean => {
    const lower = answer.toLowerCase();
    return lower.includes('是') || lower.includes('需要') || lower.includes('yes') || lower.includes('true');
  };

  const handleAvatarClick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        showToast({ message: '图片大小不能超过2MB', type: 'error' });
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        setAvatarFile(ev.target?.result as string);
        setAvatarPreview(ev.target?.result as string);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const handleCreate = async () => {
    let capabilities = {
      scheduled_tasks: false,
      web_search: false,
      multimodal: false,
    };

    for (const q of questions) {
      const answer = answers[q.id] || '';
      const qLower = q.question.toLowerCase();
      if (qLower.includes('定时') || qLower.includes('计划') || qLower.includes('调度') || qLower.includes('scheduled')) {
        capabilities.scheduled_tasks = parseBooleanAnswer(answer);
      }
      if (qLower.includes('搜索') || qLower.includes('联网') || qLower.includes('web') || qLower.includes('search')) {
        capabilities.web_search = parseBooleanAnswer(answer);
      }
      if (qLower.includes('多模态') || qLower.includes('图片') || qLower.includes('图像') || qLower.includes('multimodal') || qLower.includes('image')) {
        capabilities.multimodal = parseBooleanAnswer(answer);
      }
    }

    setCreating(true);
    setStep(3);
    try {
      await createAgent({
        name: name.trim(),
        description: description.trim(),
        openingMessage: openingMessage.trim(),
        enableSuggestions,
        capabilities,
        avatarUrl: avatarFile || null,
      });
      showToast({ message: '智能体创建成功', type: 'success' });
      handleClose();
    } catch {
      showToast({ message: '创建智能体失败', type: 'error' });
      setStep(2);
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setStep(1);
    setName('');
    setAvatarFile(null);
    setAvatarPreview(null);
    setDescription('');
    setOpeningMessage('');
    setEnableSuggestions(true);
    setQuestions([]);
    setAnswers({});
    setLoadingQuestions(false);
    setCreating(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={handleClose}>
      <div
        className="w-full max-w-md bg-bg-surface rounded-2xl shadow-2xl border border-border-subtle overflow-hidden animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-text-muted bg-bg-surface2 px-2 py-0.5 rounded-full">
              {step}/3
            </span>
            <h2 className="text-base font-semibold text-text-primary">
              {step === 1 ? '创建智能体' : step === 2 ? 'AI 问答配置' : '正在创建'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-bg-surface2 transition-colors"
            disabled={creating}
          >
            <svg className="w-5 h-5 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex flex-col items-center mb-2">
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-semibold shadow-sm overflow-hidden cursor-pointer hover:ring-4 hover:ring-accent/30 hover:scale-105 transition-all relative group"
                  style={{ backgroundColor: avatarPreview ? undefined : (name ? getAvatarColor(name) : '#737373') }}
                  onClick={handleAvatarClick}
                  title="点击上传头像"
                >
                  {avatarPreview ? (
                    <img src={avatarPreview} alt={name} className="w-full h-full object-cover" />
                  ) : (
                    <>
                      <span>{name ? name.charAt(0) : '?'}</span>
                      <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                        <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                        </svg>
                      </div>
                    </>
                  )}
                </div>
                <span className="text-xs text-text-muted mt-2">点击上传头像</span>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  智能体名称 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="输入智能体名称"
                  className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                  maxLength={50}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  简介 <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="描述智能体的功能和用途"
                  rows={3}
                  className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none transition-all"
                  maxLength={500}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  开场白 <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={openingMessage}
                  onChange={(e) => setOpeningMessage(e.target.value)}
                  placeholder="智能体首次对话的开场语"
                  rows={2}
                  className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none transition-all"
                  maxLength={300}
                />
              </div>

              <div className="flex items-center justify-between py-2">
                <div>
                  <span className="text-sm text-text-primary">开启建议回复</span>
                  <p className="text-xs text-text-muted mt-0.5">智能体会根据上下文提供回复建议</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnableSuggestions(!enableSuggestions)}
                  className={`relative w-11 h-6 rounded-full transition-all duration-200 ${
                    enableSuggestions ? 'bg-accent' : 'bg-bg-surface2'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200 ${
                      enableSuggestions ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              {loadingQuestions ? (
                <div className="flex flex-col items-center justify-center py-8">
                  <svg className="w-8 h-8 text-accent animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm text-text-muted mt-3">正在生成配置问题...</p>
                </div>
              ) : questions.length > 0 ? (
                <>
                  <p className="text-xs text-text-muted">请回答以下问题，帮助智能体了解自身能力</p>
                  {questions.map((q) => (
                    <div key={q.id}>
                      <label className="block text-sm text-text-primary mb-1.5">{q.question}</label>
                      <input
                        type="text"
                        value={answers[q.id] || ''}
                        onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        placeholder="是/否"
                        className="w-full px-3 py-2 bg-bg-surface2 border border-border-subtle rounded-[10px] text-sm outline-none text-text-primary placeholder-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all"
                      />
                    </div>
                  ))}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-8">
                  <p className="text-sm text-text-muted">暂无配置问题，可直接创建</p>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="flex flex-col items-center justify-center py-8">
              <svg className="w-12 h-12 text-accent animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <p className="text-sm text-text-primary font-medium mt-4">正在创建智能体...</p>
              <p className="text-xs text-text-muted mt-2 text-center">AI架构师正在为智能体分配模型角色并优化系统提示</p>
            </div>
          )}
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-border-subtle">
          {step === 2 && (
            <button
              onClick={() => setStep(1)}
              className="flex-1 py-2.5 text-sm font-medium text-text-secondary bg-transparent border border-border rounded-[10px] hover:bg-bg-surface2 transition-colors"
            >
              上一步
            </button>
          )}
          {step === 1 ? (
            <button
              onClick={handleNextStep}
              disabled={!isStep1Valid || loadingQuestions}
              className="flex-1 py-2.5 text-sm font-medium text-white bg-accent rounded-[10px] hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loadingQuestions ? '生成中...' : '下一步'}
            </button>
          ) : step === 2 ? (
            <button
              onClick={handleCreate}
              disabled={creatingAgent}
              className="flex-1 py-2.5 text-sm font-medium text-white bg-accent rounded-[10px] hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              创建智能体
            </button>
          ) : (
            <button
              disabled
              className="flex-1 py-2.5 text-sm font-medium text-white bg-accent/50 rounded-[10px] cursor-not-allowed"
            >
              创建中...
            </button>
          )}
        </div>
      </div>

      {Toast}
    </div>
  );
}
