import { useState, useEffect } from 'react';
import { useProfileStore, UserProfile } from '../../stores/profileStore';

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
  const [form, setForm] = useState<UserProfile>(profile);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hobbyCustomInput, setHobbyCustomInput] = useState('');
  const [personalityCustomInput, setPersonalityCustomInput] = useState('');

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
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setValidationError(null);
    if (!form.nickname?.trim()) {
      setValidationError('昵称不能为空');
      return;
    }
    if (form.age !== null && form.age !== undefined && (form.age < 1 || form.age > 150)) {
      setValidationError('年龄需在1-150之间');
      return;
    }
    if (form.height !== null && form.height !== undefined && (form.height < 30 || form.height > 300)) {
      setValidationError('身高需在30-300cm之间');
      return;
    }
    if (form.weight !== null && form.weight !== undefined && (form.weight < 10 || form.weight > 500)) {
      setValidationError('体重需在10-500kg之间');
      return;
    }
    setSaving(true);
    try {
      await updateProfile(form);
      onClose();
    } catch (error) {
      console.error('Failed to save profile:', error);
    } finally {
      setSaving(false);
    }
  };

  const addHobbyCustomTag = () => {
    const tag = hobbyCustomInput.trim();
    if (tag && !form.hobbies.includes(tag)) {
      setForm({ ...form, hobbies: [...form.hobbies, tag] });
    }
    setHobbyCustomInput('');
  };

  const addPersonalityCustomTag = () => {
    const tag = personalityCustomInput.trim();
    if (tag && !form.personality.includes(tag)) {
      setForm({ ...form, personality: [...form.personality, tag] });
    }
    setPersonalityCustomInput('');
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-surface dark:bg-gray-800 rounded-lg p-6 w-full max-w-[480px] shadow-xl animate-fade-in max-h-[85vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-text-primary dark:text-white mb-4">编辑用户画像</h3>

        <div className="space-y-4">
          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">昵称</label>
            <input
              type="text"
              value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
              placeholder="输入昵称..."
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">性别</label>
            <select
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
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
                onChange={(e) => setForm({ ...form, age: e.target.value ? Number(e.target.value) : null })}
                placeholder="年龄"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">身高(cm)</label>
              <input
                type="number"
                value={form.height ?? ''}
                onChange={(e) => setForm({ ...form, height: e.target.value ? Number(e.target.value) : null })}
                placeholder="身高"
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">体重(kg)</label>
              <input
                type="number"
                value={form.weight ?? ''}
                onChange={(e) => setForm({ ...form, weight: e.target.value ? Number(e.target.value) : null })}
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
                onChange={(e) => setForm({ ...form, occupation: e.target.value })}
                placeholder="输入职业..."
                className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
              />
            </div>
            <div>
              <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">学历</label>
              <select
                value={form.education}
                onChange={(e) => setForm({ ...form, education: e.target.value })}
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
              onChange={(hobbies) => setForm({ ...form, hobbies })}
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
              onChange={(personality) => setForm({ ...form, personality })}
              customInput={personalityCustomInput}
              onCustomInputChange={setPersonalityCustomInput}
              onCustomInputConfirm={addPersonalityCustomTag}
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">目标</label>
            <textarea
              value={form.goals}
              onChange={(e) => setForm({ ...form, goals: e.target.value })}
              placeholder="描述你的目标..."
              rows={2}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>

          <div>
            <label className="block text-caption text-text-secondary dark:text-gray-400 mb-1">自我介绍</label>
            <textarea
              value={form.bio}
              onChange={(e) => setForm({ ...form, bio: e.target.value })}
              placeholder="介绍一下自己..."
              rows={3}
              className="w-full px-3 py-2 border border-border dark:border-gray-600 rounded-lg focus:outline-none focus:border-user focus:ring-1 focus:ring-user/20 resize-none bg-bg-surface dark:bg-gray-700 text-text-primary dark:text-gray-200"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          {validationError && (
            <div className="w-full p-2 bg-red-50 dark:bg-red-900/20 rounded-lg text-xs text-red-600 dark:text-red-400 mb-2">
              {validationError}
            </div>
          )}
          <button
            onClick={onClose}
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
