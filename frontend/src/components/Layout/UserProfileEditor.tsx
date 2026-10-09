import { useState, useEffect, useCallback, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { useProfileStore, UserProfile } from '../../stores/profileStore';
import { useModalAnimation } from '../../hooks/useModalAnimation';
import { useToast, useConfirm } from '../Common';
import { useFocusTrap } from '../Common/useFocusTrap';
import { avatarBackgroundImageStyle } from '../Common/Avatar';

interface UserProfileEditorProps {
  isOpen: boolean;
  onClose: () => void;
}

const GENDER_OPTIONS = ['男', '女', '其他', '不愿透露'];
const EDUCATION_OPTIONS = ['高中及以下', '大专', '本科', '硕士', '博士', '其他'];
const HOBBY_OPTIONS = ['运动', '音乐', '阅读', '旅行', '美食', '摄影', '游戏', '编程', '艺术', '电影', '健身', '烹饪', '其他'];
const PERSONALITY_OPTIONS = ['开朗', '内向', '理性', '感性', '严谨', '随和', '独立', '合作', '冒险', '稳重', '幽默', '认真', '其他'];

function TagSelector({
  options,
  selected,
  onChange,
  customInput,
  onCustomInputChange,
  onCustomInputConfirm
}: {
  options: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
  customInput: string;
  onCustomInputChange: (value: string) => void;
  onCustomInputConfirm: () => void;
}) {
  const toggleTag = (tag: string) => {
    if (selected.includes(tag)) {
      onChange(selected.filter(t => t !== tag));
    } else {
      onChange([...selected, tag]);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => toggleTag(option)}
            className={`px-3 py-1 rounded-full text-sm transition-all duration-200 ${
              selected.includes(option)
                ? 'bg-user text-white'
                : 'bg-bg-surface2 dark:bg-gray-700 text-text-secondary dark:text-gray-300 hover:bg-bg-surface3 dark:hover:bg-gray-600'
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={customInput}
          onChange={(e) => onCustomInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customInput.trim()) {
              e.preventDefault();
              onCustomInputConfirm();
            }
          }}
          placeholder="自定义标签，按回车添加"
          className="flex-1 px-3 py-1.5 border border-border dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
        />
      </div>
      {selected.filter(t => !options.includes(t)).length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {selected.filter(t => !options.includes(t)).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              className="px-3 py-1 rounded-full text-sm bg-user text-white transition-all duration-200"
            >
              {tag} ×
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserProfileEditor({ isOpen, onClose }: UserProfileEditorProps) {
  const profile = useProfileStore((s) => s.profile);
  const fetchProfile = useProfileStore((s) => s.fetchProfile);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const { isVisible, isClosing, close: handleClose, overlayClass } = useModalAnimation(isOpen, onClose);
  const { showToast, Toast } = useToast();
  const formId = useId();
  const { confirm, cancelPending, ConfirmModal } = useConfirm();
  const sessionRef = useRef(0);
  const avatarReadRef = useRef(0);
  const avatarReaderRef = useRef<FileReader | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarReading, setAvatarReading] = useState(false);
  const openRef = useRef(isOpen); openRef.current = isOpen;
  const savingRef = useRef(false);
  const closePendingRef = useRef(false);
  const [form, setForm] = useState<UserProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hobbyCustomInput, setHobbyCustomInput] = useState('');
  const [personalityCustomInput, setPersonalityCustomInput] = useState('');

  useEffect(() => {
    sessionRef.current++;
    openRef.current = isOpen;
    if (!isOpen) {
      cancelPending();
      closePendingRef.current = false;
      savingRef.current = false;
      setSaving(false);
      setAvatarReading(false);
      setHobbyCustomInput('');
      setPersonalityCustomInput('');
      setValidationError(null);
    }
    return () => {
      sessionRef.current++;
      openRef.current = false;
      avatarReadRef.current++;
      avatarReaderRef.current?.abort();
      avatarReaderRef.current = null;
    };
  }, [isOpen, cancelPending]);

  const handleCloseWithDirtyCheck = useCallback(async () => {
    if (!openRef.current || savingRef.current || closePendingRef.current) return;
    const session = sessionRef.current;
    closePendingRef.current = true;
    try {
      if (isDirty && !await confirm({ title: '放弃未保存的资料修改？', description: '已保存的资料不会改变。选择继续编辑可保留当前输入。', confirmText: '放弃修改', cancelText: '继续编辑', danger: true })) return;
      if (!openRef.current || sessionRef.current !== session) return;
      setIsDirty(false);
      handleClose();
    } finally { if (sessionRef.current === session) closePendingRef.current = false; }
  }, [isDirty, handleClose, confirm]);
  const trapRef = useFocusTrap<HTMLDivElement>(isVisible, () => { void handleCloseWithDirtyCheck(); });

  // 包装 setForm，任何用户编辑都标记为脏数据
  const updateForm = useCallback((updater: UserProfile | ((prev: UserProfile) => UserProfile)) => {
    if (savingRef.current) return;
    setForm(updater);
    setIsDirty(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchProfile();
    }
  }, [isOpen, fetchProfile]);

  useEffect(() => {
    if (isOpen && !isDirty) setForm(profile);
    if (!isOpen) setIsDirty(false);
  }, [profile, isOpen, isDirty]);

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
      void handleCloseWithDirtyCheck();
    }
    setDragStartY(null);
    setDragOffsetY(0);
  }, [dragOffsetY, handleCloseWithDirtyCheck]);

  if (!isVisible) return null;

  const handleSave = async () => {
    if (savingRef.current || avatarReading) return;
    setValidationError(null);
    if (!form.nickname?.trim()) {
      setValidationError('昵称不能为空');
      return;
    }
    if (form.age !== null && form.age !== undefined && (isNaN(form.age) || form.age < 1 || form.age > 150)) {
      setValidationError('年龄需在1-150之间');
      return;
    }
    if (form.height !== null && form.height !== undefined && (isNaN(form.height) || form.height < 30 || form.height > 300)) {
      setValidationError('身高需在30-300cm之间');
      return;
    }
    if (form.weight !== null && form.weight !== undefined && (isNaN(form.weight) || form.weight < 10 || form.weight > 500)) {
      setValidationError('体重需在10-500kg之间');
      return;
    }
    const saveSession = sessionRef.current;
    savingRef.current = true; setSaving(true);
    try {
      const hobby = hobbyCustomInput.trim(), personality = personalityCustomInput.trim();
      await updateProfile({ ...form,
        hobbies: hobby && !form.hobbies.includes(hobby) ? [...form.hobbies, hobby] : form.hobbies,
        personality: personality && !form.personality.includes(personality) ? [...form.personality, personality] : form.personality,
      });
      if (!openRef.current || sessionRef.current !== saveSession) return;
      setIsDirty(false);
      showToast({ message: '资料已保存', type: 'success' });
      handleClose();
    } catch (error) {
      if (!openRef.current || sessionRef.current !== saveSession) return;
      const message = error instanceof Error ? error.message : '保存个人资料失败';
      showToast({ message, type: 'error' });
    } finally {
      if (sessionRef.current === saveSession) { savingRef.current = false; setSaving(false); }
    }
  };

  const addHobbyCustomTag = () => {
    const tag = hobbyCustomInput.trim();
    if (tag && !form.hobbies.includes(tag)) {
      updateForm({ ...form, hobbies: [...form.hobbies, tag] });
    }
    setHobbyCustomInput('');
  };

  const addPersonalityCustomTag = () => {
    const tag = personalityCustomInput.trim();
    if (tag && !form.personality.includes(tag)) {
      updateForm({ ...form, personality: [...form.personality, tag] });
    }
    setPersonalityCustomInput('');
  };

  return createPortal(
    <>
    <div data-profile-layer className={`fixed inset-0 bg-black/50 flex items-end md:items-center justify-center z-[70] ${overlayClass}`} onClick={handleCloseWithDirtyCheck}>
      <div
        ref={trapRef} role="dialog" aria-modal="true" aria-label="编辑个人资料" data-observe="settings" aria-busy={saving}
        className={`bg-bg-surface dark:bg-gray-800 w-full md:max-w-[480px] md:rounded-lg rounded-t-2xl shadow-xl max-h-[100dvh] md:max-h-[85vh] flex flex-col overflow-hidden profile-editor-motion ${isClosing ? 'profile-editor-motion-closing' : ''}`}
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

        <div className="flex shrink-0 items-center justify-between px-6 py-4 border-b border-border-subtle">
          <h3 className="text-lg font-semibold text-text-primary dark:text-white">编辑个人资料</h3>
          <button disabled={saving} onClick={() => void handleCloseWithDirtyCheck()} className="min-h-11 rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">关闭</button>
        </div>

        <div data-profile-scroll className="min-h-0 flex-1 overflow-y-auto p-6">
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          <p className="text-xs text-text-secondary leading-relaxed">除昵称外均可不填。昵称、偏好和自我介绍等资料可能随对话发送给你选择的模型服务商，请只填写愿意用于个性化交流的信息。</p>
          <div className="flex items-center gap-4">
            <div className="relative group">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold overflow-hidden border-2 border-border-subtle"
                style={{
                  backgroundColor: form.avatar_url ? 'transparent' : 'var(--accent-color, #4f46e5)',
                  backgroundImage: avatarBackgroundImageStyle(form.avatar_url),
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {!form.avatar_url && (form.nickname?.charAt(0) || 'U')}
              </div>
              <button type="button" aria-label="选择头像" onClick={() => avatarInputRef.current?.click()} className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 group-hover:bg-black/40 focus-visible:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors cursor-pointer">
                <svg className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                </svg>
              </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setValidationError('请选择 JPG、PNG 或 WebP 图片'); return; }
                    if (file.size > 2 * 1024 * 1024) {
                      setValidationError('头像图片不能超过2MB');
                      return;
                    }
                    avatarReaderRef.current?.abort();
                    const readId = ++avatarReadRef.current, session = sessionRef.current;
                    const reader = new FileReader(); avatarReaderRef.current = reader;
                    setAvatarReading(true); setIsDirty(true); setValidationError(null);
                    const current = () => openRef.current && sessionRef.current === session && avatarReadRef.current === readId;
                    reader.onload = (ev) => {
                      if (!current()) return;
                      setAvatarReading(false); avatarReaderRef.current = null;
                      const result = ev.target?.result as string;
                      updateForm(current => ({ ...current, avatar_url: result }));
                    };
                    reader.onerror = () => {
                      if (!current()) return;
                      setAvatarReading(false); avatarReaderRef.current = null;
                      showToast({ message: '头像读取失败，请重试', type: 'error' });
                    };
                    reader.readAsDataURL(file);
                  }}
                />
            </div>
            <div className="flex-1">
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">头像</label>
              <p className="text-[11px] text-text-muted">点击更换头像，支持 JPG/PNG/WebP，不超过 2MB</p>
              {avatarReading && <p role="status" className="text-xs text-text-secondary">正在读取头像…</p>}
              {form.avatar_url && (
                <button
                  type="button"
                  onClick={() => { avatarReadRef.current++; avatarReaderRef.current?.abort(); avatarReaderRef.current = null; setAvatarReading(false); updateForm({ ...form, avatar_url: '' }); }}
                  className="text-[11px] text-red-400 hover:text-red-500 mt-1"
                >
                  移除头像
                </button>
              )}
            </div>
          </div>

          <div>
            <label htmlFor={`${formId}-nickname`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">昵称</label>
            <input id={`${formId}-nickname`}
              type="text"
              value={form.nickname}
              onChange={(e) => updateForm({ ...form, nickname: e.target.value })}
              placeholder="输入昵称..."
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label htmlFor={`${formId}-gender`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">性别</label>
            <select id={`${formId}-gender`}
              value={form.gender}
              onChange={(e) => updateForm({ ...form, gender: e.target.value })}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            >
              <option value="">请选择</option>
              {GENDER_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor={`${formId}-age`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">年龄</label>
              <input id={`${formId}-age`}
                type="number"
                value={form.age ?? ''}
                onChange={(e) => updateForm({ ...form, age: e.target.value ? Number(e.target.value) : null })}
                placeholder="年龄"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-height`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">身高(cm)</label>
              <input id={`${formId}-height`}
                type="number"
                value={form.height ?? ''}
                onChange={(e) => updateForm({ ...form, height: e.target.value ? Number(e.target.value) : null })}
                placeholder="身高"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-weight`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">体重(kg)</label>
              <input id={`${formId}-weight`}
                type="number"
                value={form.weight ?? ''}
                onChange={(e) => updateForm({ ...form, weight: e.target.value ? Number(e.target.value) : null })}
                placeholder="体重"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${formId}-occupation`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">职业</label>
              <input id={`${formId}-occupation`}
                type="text"
                value={form.occupation}
                onChange={(e) => updateForm({ ...form, occupation: e.target.value })}
                placeholder="输入职业..."
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label htmlFor={`${formId}-education`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">学历</label>
              <select id={`${formId}-education`}
                value={form.education}
                onChange={(e) => updateForm({ ...form, education: e.target.value })}
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              >
                <option value="">请选择</option>
                {EDUCATION_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">爱好</label>
            <TagSelector
              options={HOBBY_OPTIONS}
              selected={form.hobbies}
              onChange={(hobbies) => updateForm({ ...form, hobbies })}
              customInput={hobbyCustomInput}
              onCustomInputChange={value => { if (!savingRef.current) { setHobbyCustomInput(value); setIsDirty(true); } }}
              onCustomInputConfirm={addHobbyCustomTag}
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">性格</label>
            <TagSelector
              options={PERSONALITY_OPTIONS}
              selected={form.personality}
              onChange={(personality) => updateForm({ ...form, personality })}
              customInput={personalityCustomInput}
              onCustomInputChange={value => { if (!savingRef.current) { setPersonalityCustomInput(value); setIsDirty(true); } }}
              onCustomInputConfirm={addPersonalityCustomTag}
            />
          </div>

          <div>
            <label htmlFor={`${formId}-goals`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">目标</label>
            <textarea id={`${formId}-goals`}
              value={form.goals}
              onChange={(e) => updateForm({ ...form, goals: e.target.value })}
              placeholder="描述你的目标..."
              rows={2}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label htmlFor={`${formId}-bio`} className="block text-caption text-text-secondary dark:text-gray-400 mb-1">自我介绍</label>
            <textarea id={`${formId}-bio`}
              value={form.bio}
              onChange={(e) => updateForm({ ...form, bio: e.target.value })}
              placeholder="介绍一下自己..."
              rows={3}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>
        </fieldset>
        </div>

        <div data-profile-actions className="relative shrink-0 flex flex-wrap gap-2 px-6 py-4 border-t border-border-subtle bg-bg-surface dark:bg-gray-800" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}>
          {validationError && (
            <div role="alert" className="w-full p-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs text-red-600 dark:text-red-400 mb-2">
              {validationError}
            </div>
          )}
          <button
            onClick={() => void handleCloseWithDirtyCheck()}
            disabled={saving}
            className="min-h-11 flex-1 px-4 py-2 border border-border dark:border-gray-600 rounded-lg text-text-secondary dark:text-gray-400 hover:bg-bg-surface2 dark:hover:bg-gray-700 transition-all duration-200"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving || avatarReading}
            className="min-h-11 flex-1 px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all duration-200"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
    {ConfirmModal}
    {Toast}
    </>, document.body
  );
}
