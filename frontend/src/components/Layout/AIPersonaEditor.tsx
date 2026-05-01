import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ModelConfig,
  PersonaConfig,
  PreferredRole,
  ResponseConfig,
  SocialConfig,
  usePersonasStore,
  pausePersonasAutoRefresh,
  resumePersonasAutoRefresh,
} from '../../stores/personasStore';
import { AI_COLORS, AI_NAMES } from '../../types';
import { useToast } from '../Common';

interface AIPersonaEditorProps {
  aiId: string;
  isOpen: boolean;
  onClose: () => void;
}

const defaultResponseConfig: ResponseConfig = {
  enabled: true,
  responseFrequency: 0.8,
  minDelay: 1000,
  maxDelay: 4000,
  activeHours: { start: 0, end: 24 },
  maxResponsesPerConversation: 10,
  cooldownBetweenResponses: 2000,
};

const defaultSocialConfig: SocialConfig = {
  maxMessageLength: 800,
  enableQuoting: true,
  enableSocialFeedback: true,
  quoteProbability: 0.4,
  maxQuotesPerMessage: 2,
  likeProbability: 0.3,
  commentProbability: 0.15,
  dislikeProbability: 0.05,
  interactionProbability: 0.75,
};

const defaultModelConfig: ModelConfig = {
  maxTokens: 1500,
  temperature: 0.5,
  topP: 0.9,
  frequencyPenalty: 0.3,
  presencePenalty: 0.2,
};

const defaultPersona: PersonaConfig = {
  name: '',
  style: '',
  styleTag: '',
  replyStyle: '',
  personality: '',
  typicalPhrases: [],
  color: undefined,
  avatar_url: null,
  keywords: [],
  firstSpeakerTopics: [],
  speakingOrder: 3,
  messageLength: 'medium',
  questionProbability: 0.3,
  debateTendency: 'medium',
  silenceProbability: 0.1,
  preferredRole: 'expert',
  customRoleName: '',
  responseConfig: defaultResponseConfig,
  socialConfig: defaultSocialConfig,
  modelConfig: defaultModelConfig,
  expertise: [],
  speakingTraits: '',
};

const roleOptions: PreferredRole[] = [
  'expert',
  'student',
  'critic',
  'mediator',
  'innovator',
  'analyst',
  'supporter',
  'challenger',
  'teacher',
  'storyteller',
  'pragmatist',
  'philosopher',
  'humorist',
  'skeptic',
  'optimist',
  'realist',
  'custom',
];

const roleLabels: Record<PreferredRole, string> = {
  expert: '专家',
  student: '学习者',
  critic: '评论者',
  mediator: '调解者',
  innovator: '创新者',
  analyst: '分析师',
  supporter: '支持者',
  challenger: '挑战者',
  teacher: '导师',
  storyteller: '讲述者',
  pragmatist: '实用主义者',
  philosopher: '哲学家',
  humorist: '幽默者',
  skeptic: '怀疑者',
  optimist: '乐观者',
  realist: '现实主义者',
  custom: '自定义',
};

const roleDescriptions: Record<PreferredRole, string> = {
  expert: '以专业权威的视角提供深度见解和准确信息',
  student: '以好奇求知的态度提问和学习，鼓励讨论',
  critic: '善于发现问题和不足，提供建设性批评',
  mediator: '协调不同观点，促进共识和理解',
  innovator: '提出新颖独特的想法和解决方案',
  analyst: '用数据和逻辑进行理性分析与推理',
  supporter: '给予鼓励和情感支持，营造积极氛围',
  challenger: '质疑常规观点，推动深入思考',
  teacher: '耐心讲解知识，善于引导和启发',
  storyteller: '用生动的故事和案例表达观点',
  pragmatist: '关注可行性和实际效果，注重落地',
  philosopher: '从深层原理和本质角度思考问题',
  humorist: '用幽默风趣的方式表达，活跃气氛',
  skeptic: '对信息保持审慎态度，追求证据和验证',
  optimist: '积极乐观地看待问题，关注可能性',
  realist: '客观冷静地评估现状，直面现实',
  custom: '',
};

const modelParamDescriptions: Record<string, string> = {
  maxTokens: '控制AI单次回复的最大长度，值越大回复越长',
  temperature: '控制回复的随机性，值越高越有创意，越低越精确稳定',
  topP: '核采样范围，控制候选词的范围，值越低回复越聚焦',
  frequencyPenalty: '降低已出现词语的重复概率，值越高越不容易重复用词',
  presencePenalty: '鼓励引入新话题和新概念，值越高越倾向讨论新内容',
};

function mergePersona(persona?: PersonaConfig): PersonaConfig {
  return {
    ...defaultPersona,
    ...(persona || {}),
    styleTag: persona?.styleTag || persona?.style || '',
    expertise: persona?.expertise || [],
    speakingTraits: persona?.speakingTraits || '',
    responseConfig: { ...defaultResponseConfig, ...(persona?.responseConfig || {}) },
    socialConfig: { ...defaultSocialConfig, ...(persona?.socialConfig || {}) },
    modelConfig: { ...defaultModelConfig, ...(persona?.modelConfig || {}) },
  };
}

export function AIPersonaEditor({ aiId, isOpen, onClose }: AIPersonaEditorProps) {
  const { personas, fetchPersonas, updatePersona, resetPersona } = usePersonasStore();
  const { showToast, Toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<PersonaConfig>(defaultPersona);
  const [phrasesText, setPhrasesText] = useState('');
  const [keywordsText, setKeywordsText] = useState('');
  const [topicsText, setTopicsText] = useState('');
  const [expertiseText, setExpertiseText] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'basic' | 'behavior' | 'social' | 'model'>('basic');
  const [isDirty, setIsDirty] = useState(false);
  const formRef = useRef<PersonaConfig>(defaultPersona);

  const currentPersona = personas[aiId];
  const title = useMemo(() => AI_NAMES[aiId] || currentPersona?.name || aiId, [aiId, currentPersona?.name]);
  const defaultColor = AI_COLORS[aiId] || '#6b7280';

  useEffect(() => {
    if (isOpen) {
      pausePersonasAutoRefresh();
      fetchPersonas();
    } else {
      resumePersonasAutoRefresh();
      setIsDirty(false);
    }
    return () => {
      if (isOpen) {
        resumePersonasAutoRefresh();
      }
    };
  }, [fetchPersonas, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (isDirty) return;
    const merged = mergePersona(currentPersona);
    formRef.current = merged;
    setForm(merged);
    setPhrasesText((merged.typicalPhrases || []).join('\n'));
    setKeywordsText((merged.keywords || []).join(', '));
    setTopicsText((merged.firstSpeakerTopics || []).join(', '));
    setExpertiseText((merged.expertise || []).join(', '));
    setAvatarPreview(merged.avatar_url || null);
  }, [currentPersona, isOpen, isDirty]);

  const [dragStartY, setDragStartY] = useState<number | null>(null);
  const [dragOffsetY, setDragOffsetY] = useState(0);

  const handleDragStart = useCallback((clientY: number) => {
    setDragStartY(clientY);
    setDragOffsetY(0);
  }, []);

  const handleDragMove = useCallback((clientY: number) => {
    if (dragStartY === null) return;
    const offset = Math.max(0, clientY - dragStartY);
    setDragOffsetY(offset);
  }, [dragStartY]);

  const handleDragEnd = useCallback(() => {
    if (dragOffsetY > 120) {
      onClose();
    }
    setDragStartY(null);
    setDragOffsetY(0);
  }, [dragOffsetY, onClose]);

  if (!isOpen) return null;

  const setField = <K extends keyof PersonaConfig>(key: K, value: PersonaConfig[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const setResponseConfig = <K extends keyof ResponseConfig>(key: K, value: ResponseConfig[K]) => {
    setForm((prev) => ({
      ...prev,
      responseConfig: {
        ...defaultResponseConfig,
        ...(prev.responseConfig || {}),
        [key]: value,
      },
    }));
    setIsDirty(true);
  };

  const setSocialConfig = <K extends keyof SocialConfig>(key: K, value: SocialConfig[K]) => {
    setForm((prev) => ({
      ...prev,
      socialConfig: {
        ...defaultSocialConfig,
        ...(prev.socialConfig || {}),
        [key]: value,
      },
    }));
    setIsDirty(true);
  };

  const setModelConfig = <K extends keyof ModelConfig>(key: K, value: ModelConfig[K]) => {
    setForm((prev) => ({
      ...prev,
      modelConfig: {
        ...defaultModelConfig,
        ...(prev.modelConfig || {}),
        [key]: value,
      },
    }));
    setIsDirty(true);
  };

  const handleFileSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      showToast({ message: '请选择图片文件。', type: 'error' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showToast({ message: '头像大小不能超过 2 MB。', type: 'error' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setAvatarPreview((reader.result as string) || null); setIsDirty(true); };
    reader.readAsDataURL(file);
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await resetPersona(aiId);
      setIsDirty(false);
      showToast({ message: '人设已重置。', type: 'success' });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置失败。';
      showToast({ message, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updatePersona(aiId, {
        ...form,
        avatar_url: avatarPreview,
        typicalPhrases: phrasesText.split('\n').map((item) => item.trim()).filter(Boolean),
        keywords: keywordsText.split(',').map((item) => item.trim()).filter(Boolean),
        firstSpeakerTopics: topicsText.split(',').map((item) => item.trim()).filter(Boolean),
        expertise: expertiseText.split(',').map((item) => item.trim()).filter(Boolean),
      });
      setIsDirty(false);
      showToast({ message: '人设已保存。', type: 'success' });
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败。';
      showToast({ message, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const tabButton = (tab: 'basic' | 'behavior' | 'social' | 'model', label: string) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      className={`rounded-full px-3 py-1.5 text-xs font-medium ${activeTab === tab ? 'bg-accent text-white' : 'bg-bg-surface2 text-text-secondary hover:text-text-primary'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/50 md:p-4" onClick={onClose}>
      <div
        className="flex max-h-[100dvh] md:max-h-[92vh] w-full md:max-w-3xl flex-col overflow-hidden rounded-t-2xl md:rounded-2xl border border-border-subtle bg-bg-surface shadow-2xl"
        style={{ transform: dragOffsetY > 0 ? `translateY(${dragOffsetY}px)` : undefined, transition: dragStartY === null ? 'transform 0.2s ease' : 'none' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="md:hidden flex justify-center pt-2 pb-1 cursor-grab active:cursor-grabbing"
          onTouchStart={(e) => handleDragStart(e.touches[0].clientY)}
          onTouchMove={(e) => handleDragMove(e.touches[0].clientY)}
          onTouchEnd={handleDragEnd}
          onMouseDown={(e) => handleDragStart(e.clientY)}
          onMouseMove={(e) => { if (dragStartY !== null) handleDragMove(e.clientY); }}
          onMouseUp={handleDragEnd}
          onMouseLeave={() => { if (dragStartY !== null) handleDragEnd(); }}
        >
          <div className="w-10 h-1 rounded-full bg-border-subtle" />
        </div>

        <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 md:px-6 py-3 md:py-4">
          <div>
            <h3 className="text-lg font-semibold text-text-primary">人设编辑器</h3>
            <p className="text-sm text-text-muted">为 {title} 配置性格、行为和模型参数。</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">关闭</button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2 border-b border-border-subtle px-4 md:px-6 py-3">
          {tabButton('basic', '基础')}
          {tabButton('behavior', '行为')}
          {tabButton('social', '社交')}
          {tabButton('model', '模型')}
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4 md:p-6">
          {activeTab === 'basic' && (
            <section className="grid gap-6 md:grid-cols-[220px_1fr]">
              <div className="space-y-4 rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="flex flex-col items-center gap-3">
                  <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full text-2xl font-semibold text-white" style={{ backgroundColor: form.color || defaultColor }}>
                    {avatarPreview ? <img src={avatarPreview} alt="avatar" className="h-full w-full object-cover" /> : (title[0] || '?').toUpperCase()}
                  </div>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
                  <button onClick={() => fileInputRef.current?.click()} className="rounded-xl border border-border-subtle px-3 py-2 text-sm text-text-primary">上传头像</button>
                  {avatarPreview && <button onClick={() => setAvatarPreview(null)} className="text-xs text-text-muted hover:text-text-primary">移除头像</button>}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">主题颜色</label>
                  <input type="color" value={form.color || defaultColor} onChange={(event) => setField('color', event.target.value)} className="h-10 w-full rounded-lg border border-border-subtle bg-transparent" />
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">显示名称</label>
                  <input value={form.name} onChange={(event) => setField('name', event.target.value)} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">风格标签（简短标签，如"逻辑派""务实派"）</label>
                  <input value={form.styleTag || ''} onChange={(event) => setField('styleTag', event.target.value)} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">风格描述（详细风格说明）</label>
                  <input value={form.style || ''} onChange={(event) => setField('style', event.target.value)} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">回复风格</label>
                  <input value={form.replyStyle || ''} onChange={(event) => setField('replyStyle', event.target.value)} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">性格描述</label>
                  <textarea value={form.personality || ''} onChange={(event) => setField('personality', event.target.value)} rows={5} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">说话特点（描述你说话的独特方式）</label>
                  <textarea value={form.speakingTraits || ''} onChange={(event) => setField('speakingTraits', event.target.value)} rows={3} className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">常用语句</label>
                  <textarea value={phrasesText} onChange={(event) => { setPhrasesText(event.target.value); setIsDirty(true); }} rows={5} placeholder="每行一条常用语句" className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-text-secondary">擅长领域（逗号分隔）</label>
                  <input value={expertiseText} onChange={(event) => { setExpertiseText(event.target.value); setIsDirty(true); }} placeholder="如：逻辑推理, 数据分析, 编程技术" className="w-full rounded-xl border border-border-subtle bg-bg-surface2 px-3 py-2 text-sm text-text-primary" />
                </div>
              </div>
            </section>
          )}

          {activeTab === 'behavior' && (
            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <label className="mb-1 block text-xs font-medium text-text-secondary">关键词</label>
                <input value={keywordsText} onChange={(event) => { setKeywordsText(event.target.value); setIsDirty(true); }} placeholder="使用逗号分隔关键词" className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <label className="mb-1 block text-xs font-medium text-text-secondary">优先开场话题</label>
                <input value={topicsText} onChange={(event) => { setTopicsText(event.target.value); setIsDirty(true); }} placeholder="使用逗号分隔话题" className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <label className="mb-2 block text-xs font-medium text-text-secondary">偏好角色</label>
                <select value={form.preferredRole || 'expert'} onChange={(event) => { setField('preferredRole', event.target.value as PreferredRole); (event.target as HTMLSelectElement).blur(); }} className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary">
                  {roleOptions.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}
                </select>
                {form.preferredRole && form.preferredRole !== 'custom' && roleDescriptions[form.preferredRole] && (
                  <p className="mt-2 text-[11px] text-text-muted leading-relaxed">{roleDescriptions[form.preferredRole]}</p>
                )}
                {form.preferredRole === 'custom' && (
                  <input value={form.customRoleName || ''} onChange={(event) => setField('customRoleName', event.target.value)} placeholder="输入自定义角色名称" className="mt-3 w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary" />
                )}
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <label className="mb-2 block text-xs font-medium text-text-secondary">消息长度</label>
                <select value={form.messageLength || 'medium'} onChange={(event) => { setField('messageLength', event.target.value); (event.target as HTMLSelectElement).blur(); }} className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary">
                  <option value="short">简短</option>
                  <option value="medium">中等</option>
                  <option value="long">详细</option>
                </select>
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <label className="mb-2 block text-xs font-medium text-text-secondary">辩论倾向</label>
                <select value={form.debateTendency || 'medium'} onChange={(event) => { setField('debateTendency', event.target.value); (event.target as HTMLSelectElement).blur(); }} className="w-full rounded-xl border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-text-primary">
                  <option value="low">温和（倾向赞同和附和）</option>
                  <option value="medium">平衡（理性表达不同意见）</option>
                  <option value="high">激进（喜欢反驳和质疑）</option>
                </select>
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>发言顺序倾向</span><span>{form.speakingOrder || 3}</span></div>
                <input type="range" min={1} max={10} value={form.speakingOrder || 3} onChange={(event) => setField('speakingOrder', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>提问概率</span><span>{((form.questionProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.questionProbability || 0} onChange={(event) => setField('questionProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>沉默概率</span><span>{((form.silenceProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.silenceProbability || 0} onChange={(event) => setField('silenceProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>回复频率</span><span>{((form.responseConfig?.responseFrequency || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.responseConfig?.responseFrequency || 0} onChange={(event) => setResponseConfig('responseFrequency', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
            </section>
          )}

          {activeTab === 'social' && (
            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-text-secondary">启用引用回复</span>
                  <p className="text-[10px] text-text-muted mt-0.5">AI会引用其他消息进行回复</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSocialConfig('enableQuoting', !form.socialConfig?.enableQuoting)}
                  className={`relative w-11 h-6 rounded-full transition-all duration-200 ${
                    form.socialConfig?.enableQuoting ? 'bg-accent' : 'bg-bg-surface'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200 ${
                      form.socialConfig?.enableQuoting ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-text-secondary">启用社交反馈</span>
                  <p className="text-[10px] text-text-muted mt-0.5">AI会自主点赞、评论等</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSocialConfig('enableSocialFeedback', !form.socialConfig?.enableSocialFeedback)}
                  className={`relative w-11 h-6 rounded-full transition-all duration-200 ${
                    form.socialConfig?.enableSocialFeedback ? 'bg-accent' : 'bg-bg-surface'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-all duration-200 ${
                      form.socialConfig?.enableSocialFeedback ? 'left-[22px]' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>互动概率</span><span>{((form.socialConfig?.interactionProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.socialConfig?.interactionProbability || 0} onChange={(event) => setSocialConfig('interactionProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>点赞概率</span><span>{((form.socialConfig?.likeProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.socialConfig?.likeProbability || 0} onChange={(event) => setSocialConfig('likeProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>评论概率</span><span>{((form.socialConfig?.commentProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.socialConfig?.commentProbability || 0} onChange={(event) => setSocialConfig('commentProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>点踩概率</span><span>{((form.socialConfig?.dislikeProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.socialConfig?.dislikeProbability || 0} onChange={(event) => setSocialConfig('dislikeProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>引用概率</span><span>{((form.socialConfig?.quoteProbability || 0) * 100).toFixed(0)}%</span></div>
                <input type="range" min={0} max={1} step={0.05} value={form.socialConfig?.quoteProbability || 0} onChange={(event) => setSocialConfig('quoteProbability', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>最大消息长度</span><span>{form.socialConfig?.maxMessageLength || 800}</span></div>
                <input type="range" min={50} max={4000} step={50} value={form.socialConfig?.maxMessageLength || 800} onChange={(event) => setSocialConfig('maxMessageLength', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
            </section>
          )}

          {activeTab === 'model' && (
            <section className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>最大 Tokens</span><span>{form.modelConfig?.maxTokens || 1500}</span></div>
                <p className="mb-2 text-[11px] text-text-muted leading-relaxed">{modelParamDescriptions.maxTokens}</p>
                <input type="range" min={128} max={8192} step={128} value={form.modelConfig?.maxTokens || 1500} onChange={(event) => setModelConfig('maxTokens', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>温度</span><span>{(form.modelConfig?.temperature || 0).toFixed(2)}</span></div>
                <p className="mb-2 text-[11px] text-text-muted leading-relaxed">{modelParamDescriptions.temperature}</p>
                <input type="range" min={0} max={1.5} step={0.05} value={form.modelConfig?.temperature || 0} onChange={(event) => setModelConfig('temperature', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>Top P</span><span>{(form.modelConfig?.topP || 0).toFixed(2)}</span></div>
                <p className="mb-2 text-[11px] text-text-muted leading-relaxed">{modelParamDescriptions.topP}</p>
                <input type="range" min={0} max={1} step={0.05} value={form.modelConfig?.topP || 0} onChange={(event) => setModelConfig('topP', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>频率惩罚</span><span>{(form.modelConfig?.frequencyPenalty || 0).toFixed(2)}</span></div>
                <p className="mb-2 text-[11px] text-text-muted leading-relaxed">{modelParamDescriptions.frequencyPenalty}</p>
                <input type="range" min={0} max={2} step={0.05} value={form.modelConfig?.frequencyPenalty || 0} onChange={(event) => setModelConfig('frequencyPenalty', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>存在惩罚</span><span>{(form.modelConfig?.presencePenalty || 0).toFixed(2)}</span></div>
                <p className="mb-2 text-[11px] text-text-muted leading-relaxed">{modelParamDescriptions.presencePenalty}</p>
                <input type="range" min={0} max={2} step={0.05} value={form.modelConfig?.presencePenalty || 0} onChange={(event) => setModelConfig('presencePenalty', Number(event.target.value))} className="w-full accent-[var(--accent)]" />
              </div>
              <div className="rounded-2xl border border-border-subtle bg-bg-surface2 p-4 md:col-span-2">
                <div className="mb-2 flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={form.responseConfig?.enabled ?? true} onChange={(event) => setResponseConfig('enabled', event.target.checked)} />
                  <span>启用自主回复</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>最小延迟</span><span>{((form.responseConfig?.minDelay || 0) / 1000).toFixed(1)}秒</span></div>
                    <input type="range" min={0} max={10} step={0.1} value={(form.responseConfig?.minDelay || 0) / 1000} onChange={(event) => {
                      const sec = Number(event.target.value);
                      const ms = Math.round(sec * 1000);
                      setResponseConfig('minDelay', ms);
                      if (form.responseConfig && ms >= form.responseConfig.maxDelay) {
                        setResponseConfig('maxDelay', ms + 1000);
                      }
                    }} className="w-full accent-[var(--accent)]" />
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between text-xs text-text-secondary"><span>最大延迟</span><span>{((form.responseConfig?.maxDelay || 0) / 1000).toFixed(1)}秒</span></div>
                    <input type="range" min={0} max={10} step={0.1} value={(form.responseConfig?.maxDelay || 0) / 1000} onChange={(event) => {
                      const sec = Number(event.target.value);
                      const ms = Math.round(sec * 1000);
                      setResponseConfig('maxDelay', ms);
                      if (form.responseConfig && ms <= form.responseConfig.minDelay) {
                        setResponseConfig('minDelay', Math.max(0, ms - 1000));
                      }
                    }} className="w-full accent-[var(--accent)]" />
                  </div>
                </div>
                {form.responseConfig && form.responseConfig.minDelay >= form.responseConfig.maxDelay && (
                  <p className="mt-2 text-[11px] text-amber-500">最小延迟必须小于最大延迟</p>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border-subtle px-4 md:px-6 py-3 md:py-4" style={{ paddingBottom: 'max(0.75rem, calc(env(safe-area-inset-bottom, 0px) + 60px))' }}>
          <button onClick={handleReset} disabled={saving} className="rounded-xl border border-border-subtle px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50">重置</button>
          <div className="flex gap-3">
            <button onClick={onClose} disabled={saving} className="rounded-xl border border-border-subtle px-4 py-2 text-sm font-medium text-text-primary disabled:opacity-50">取消</button>
            <button onClick={handleSave} disabled={saving || (form.responseConfig !== undefined && form.responseConfig.minDelay >= form.responseConfig.maxDelay)} className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
          </div>
        </div>
        {Toast}
      </div>
    </div>
  );
}
