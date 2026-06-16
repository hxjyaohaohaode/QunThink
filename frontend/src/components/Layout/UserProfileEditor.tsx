import { useState, useEffect, useCallback } from 'react';
import { useProfileStore, UserProfile } from '../../stores/profileStore';
import { useModalAnimation } from '../../hooks/useModalAnimation';
import { useToast } from '../Common';

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
  const { profile, fetchProfile, updateProfile } = useProfileStore();
  const { isVisible, close: handleClose, overlayClass, contentClass, sheetClass } = useModalAnimation(isOpen, onClose);
  const { showToast } = useToast();
  const [form, setForm] = useState<UserProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hobbyCustomInput, setHobbyCustomInput] = useState('');
  const [personalityCustomInput, setPersonalityCustomInput] = useState('');

  // 关闭时脏数据检查
  const handleCloseWithDirtyCheck = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm('有未保存的更改，确定离开吗？');
      if (!confirmed) return;
    }
    handleClose();
  }, [isDirty, handleClose]);

  // 包装 setForm，任何用户编辑都标记为脏数据
  const updateForm = useCallback((updater: UserProfile | ((prev: UserProfile) => UserProfile)) => {
    setForm(updater);
    setIsDirty(true);
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchProfile();
    }
  }, [isOpen, fetchProfile]);

  useEffect(() => {
    setForm(profile);
  }, [profile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleCloseWithDirtyCheck();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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
      handleClose();
    }
    setDragStartY(null);
    setDragOffsetY(0);
  }, [dragOffsetY, onClose]);

  if (!isVisible) return null;

  const handleSave = async () => {
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
    setSaving(true);
    try {
      await updateProfile(form);
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存个人资料失败';
      showToast({ message, type: 'error' });
    } finally {
      setSaving(false);
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

  return (
    <div className={`fixed inset-0 bg-black/50 flex items-end md:items-center justify-center z-[70] ${overlayClass}`} onClick={handleCloseWithDirtyCheck}>
      <div
        className={`bg-bg-surface dark:bg-gray-800 w-full md:max-w-[480px] md:rounded-lg rounded-t-2xl shadow-xl max-h-[100dvh] md:max-h-[85vh] flex flex-col overflow-hidden ${sheetClass} md:${contentClass}`}
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
          <h3 className="text-lg font-semibold text-text-primary dark:text-white">编辑用户画像</h3>
          <button onClick={handleCloseWithDirtyCheck} className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-bg-surface2 hover:text-text-primary">关闭</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4" style={{ paddingBottom: 'max(1.5rem, calc(env(safe-area-inset-bottom, 0px) + 60px))' }}>
          <div className="flex items-center gap-4">
            <div className="relative group">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold overflow-hidden border-2 border-border-subtle"
                style={{
                  backgroundColor: form.avatar_url ? 'transparent' : 'var(--accent-color, #4f46e5)',
                  backgroundImage: form.avatar_url ? `url(${form.avatar_url})` : 'none',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {!form.avatar_url && (form.nickname?.charAt(0) || 'U')}
              </div>
              <label className="absolute inset-0 flex items-center justify-center rounded-full bg-black/0 group-hover:bg-black/40 transition-colors cursor-pointer">
                <svg className="w-5 h-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 015.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 00-1.134-.175 2.31 2.31 0 01-1.64-1.055l-.822-1.316a2.192 2.192 0 00-1.736-1.039 48.774 48.774 0 00-5.232 0 2.192 2.192 0 00-1.736 1.039l-.821 1.316z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 11-9 0 4.5 4.5 0 019 0z" />
                </svg>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) {
                      setValidationError('头像图片不能超过2MB');
                      return;
                    }
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                      const result = ev.target?.result as string;
                      updateForm({ ...form, avatar_url: result });
                    };
                    reader.onerror = () => {
                      showToast({ message: '头像读取失败，请重试', type: 'error' });
                    };
                    reader.readAsDataURL(file);
                  }}
                />
              </label>
            </div>
            <div className="flex-1">
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">头像</label>
              <p className="text-[11px] text-text-muted">点击更换头像，支持 JPG/PNG，不超过 2MB</p>
              {form.avatar_url && (
                <button
                  type="button"
                  onClick={() => updateForm({ ...form, avatar_url: '' })}
                  className="text-[11px] text-red-400 hover:text-red-500 mt-1"
                >
                  移除头像
                </button>
              )}
            </div>
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">昵称</label>
            <input
              type="text"
              value={form.nickname}
              onChange={(e) => updateForm({ ...form, nickname: e.target.value })}
              placeholder="输入昵称..."
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">性别</label>
            <select
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
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">年龄</label>
              <input
                type="number"
                value={form.age ?? ''}
                onChange={(e) => updateForm({ ...form, age: e.target.value ? Number(e.target.value) : null })}
                placeholder="年龄"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">身高(cm)</label>
              <input
                type="number"
                value={form.height ?? ''}
                onChange={(e) => updateForm({ ...form, height: e.target.value ? Number(e.target.value) : null })}
                placeholder="身高"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">体重(kg)</label>
              <input
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
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">职业</label>
              <input
                type="text"
                value={form.occupation}
                onChange={(e) => updateForm({ ...form, occupation: e.target.value })}
                placeholder="输入职业..."
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">学历</label>
              <select
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
              onCustomInputChange={setHobbyCustomInput}
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
              onCustomInputChange={setPersonalityCustomInput}
              onCustomInputConfirm={addPersonalityCustomTag}
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">目标</label>
            <textarea
              value={form.goals}
              onChange={(e) => updateForm({ ...form, goals: e.target.value })}
              placeholder="描述你的目标..."
              rows={2}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">自我介绍</label>
            <textarea
              value={form.bio}
              onChange={(e) => updateForm({ ...form, bio: e.target.value })}
              placeholder="介绍一下自己..."
              rows={3}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>
        </div>

        <div className="flex shrink-0 gap-2 px-6 py-4 border-t border-border-subtle" style={{ paddingBottom: 'max(1rem, calc(env(safe-area-inset-bottom, 0px) + 60px))' }}>
          {validationError && (
            <div className="w-full p-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs text-red-600 dark:text-red-400 mb-2">
              {validationError}
            </div>
          )}
          <button
            onClick={handleClose}
            className="flex-1 px-4 py-2 border border-border dark:border-gray-600 rounded-lg text-text-secondary dark:text-gray-400 hover:bg-bg-surface2 dark:hover:bg-gray-700 transition-all duration-200"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 px-4 py-2 bg-user text-white rounded-lg hover:opacity-90 disabled:opacity-50 transition-all duration-200"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
