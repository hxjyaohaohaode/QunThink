import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../services/api';
import { useToast } from '../Common';

interface LoginPageProps {
  onLoginSuccess?: () => Promise<void> | void;
}

const logoVariants = {
  hidden: { scale: 0, opacity: 0 },
  visible: {
    scale: 1,
    opacity: 1,
    transition: { type: 'spring' as const, stiffness: 260, damping: 20, duration: 0.5 },
  },
};

const titleContainerVariants = {
  hidden: { opacity: 1 },
  visible: { opacity: 1, transition: { delayChildren: 0.3, staggerChildren: 0.05 } },
};

const titleCharVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 24 } },
};

const subtitleVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { delay: 0.8, duration: 0.4, ease: 'easeOut' as const } },
};

const formContainerVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { delay: 1, duration: 0.3, ease: 'easeOut' as const } },
};

const formElementVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 1.1 + i * 0.08, duration: 0.3, ease: 'easeOut' as const },
  }),
};

const buttonContentVariants = {
  initial: { opacity: 1, scale: 1 },
  loading: { opacity: 0, scale: 0.8 },
  success: { opacity: 1, scale: 1 },
};

const spinnerVariants = {
  initial: { opacity: 0, scale: 0.5 },
  loading: { opacity: 1, scale: 1, transition: { duration: 0.2 } },
  success: { opacity: 0, scale: 0.5 },
};

const successIconVariants = {
  hidden: { scale: 0, opacity: 0 },
  visible: { scale: 1, opacity: 1, transition: { type: 'spring' as const, stiffness: 300, damping: 20 } },
};

const checkmarkVariants = {
  hidden: { pathLength: 0 },
  visible: { pathLength: 1, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

function AnimatedTitle({ text }: { text: string }) {
  return (
    <motion.h1
      className="text-2xl font-bold text-text-primary"
      variants={titleContainerVariants}
      initial="hidden"
      animate="visible"
    >
      {text.split('').map((char, index) => (
        <motion.span key={index} variants={titleCharVariants}>
          {char}
        </motion.span>
      ))}
    </motion.h1>
  );
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { showToast, Toast } = useToast();

  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, []);

  useEffect(() => {
    if (countdown > 0) {
      countdownRef.current = setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [countdown > 0]);

  const validatePhone = (value: string) => {
    if (!value) return '请输入手机号';
    if (!/^1[3-9]\d{9}$/.test(value)) return '手机号格式不正确';
    return null;
  };

  const completeAuthFlow = async (successMessage: string) => {
    setSuccess(true);
    try {
      if (onLoginSuccess) {
        await onLoginSuccess();
      }
      showToast({ message: successMessage, type: 'success' });
    } catch (err: any) {
      setSuccess(false);
      const errorMsg = err?.message || '登录后初始化失败，请重试';
      setError(errorMsg);
      showToast({ message: errorMsg, type: 'error' });
      throw err;
    }
  };

  const handleSendSmsCode = async () => {
    const phoneError = validatePhone(phone);
    if (phoneError) {
      setError(phoneError);
      showToast({ message: phoneError, type: 'error' });
      return;
    }

    setSendingCode(true);
    setError(null);
    try {
      await api.sendSmsCode(phone);
      setCountdown(60);
      showToast({ message: '验证码已发送', type: 'success' });
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || '验证码发送失败';
      setError(errorMsg);
      showToast({ message: errorMsg, type: 'error' });
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const phoneError = validatePhone(phone);
    if (phoneError) {
      setError(phoneError);
      showToast({ message: phoneError, type: 'error' });
      return;
    }

    if (!smsCode || !/^\d{4,8}$/.test(smsCode)) {
      setError('请输入正确的验证码');
      showToast({ message: '请输入正确的验证码', type: 'error' });
      return;
    }

    setLoading(true);
    try {
      const result = await api.verifySmsCode(phone, smsCode);
      if (result.isNewUser) {
        await completeAuthFlow('注册成功！');
      } else {
        await completeAuthFlow('登录成功！');
      }
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || '验证失败';
      setError(errorMsg);
      showToast({ message: errorMsg, type: 'error' });
      setLoading(false);
    }
  };

  const isSubmitDisabled = () => {
    if (loading || success) return true;
    return !phone || !smsCode;
  };

  return (
    <div className="min-h-screen bg-bg-primary flex items-center justify-center p-4">
      {Toast}
      <div className="w-full max-w-md">
        <motion.div
          className="bg-bg-surface rounded-2xl shadow-sm overflow-hidden border border-border-subtle"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="px-8 py-10 text-center border-b border-border-subtle">
            <motion.div
              className="w-16 h-16 mx-auto mb-4 flex items-center justify-center"
              variants={logoVariants}
              initial="hidden"
              animate="visible"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" className="w-16 h-16">
                <defs>
                  <linearGradient id="main" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#6C5CE7"/>
                    <stop offset="100%" stopColor="#A29BFE"/>
                  </linearGradient>
                  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="4" stdDeviation="8" floodColor="#1A1A2E" floodOpacity="0.25"/>
                  </filter>
                </defs>
                <g filter="url(#shadow)">
                  <rect x="55" y="50" width="85" height="85" rx="20" fill="#1A1A2E" opacity="0.9" transform="rotate(-12, 97, 92)"/>
                  <rect x="70" y="48" width="85" height="85" rx="20" fill="#6C5CE7" opacity="0.6" transform="rotate(8, 112, 90)"/>
                  <rect x="82" y="58" width="85" height="85" rx="20" fill="url(#main)"/>
                </g>
              </svg>
            </motion.div>

            <AnimatedTitle text="群想" />

            <motion.p
              className="text-accent mt-1 text-sm font-medium tracking-[3px]"
              variants={subtitleVariants}
              initial="hidden"
              animate="visible"
            >
              Muse aloud
            </motion.p>

            <motion.p
              className="text-text-muted mt-2 text-xs tracking-[3px]"
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1, duration: 0.4 }}
            >
              想，就聊出来
            </motion.p>
          </div>

          <motion.div
            className="px-8 py-8"
            variants={formContainerVariants}
            initial="hidden"
            animate="visible"
          >
            <motion.form
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
              className="space-y-5"
              onSubmit={handleSubmit}
            >
              <motion.div custom={1} variants={formElementVariants} initial="hidden" animate="visible">
                <label className="block text-sm font-medium text-text-secondary mb-2">手机号</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
                  required
                  className="w-full px-4 py-3 border border-border-subtle rounded-xl focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent bg-bg-surface2 text-text-primary"
                  placeholder="请输入手机号"
                  autoComplete="tel"
                  maxLength={11}
                />
              </motion.div>

              <motion.div custom={2} variants={formElementVariants} initial="hidden" animate="visible">
                <label className="block text-sm font-medium text-text-secondary mb-2">验证码</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={smsCode}
                    onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required
                    className="flex-1 px-4 py-3 border border-border-subtle rounded-xl focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent bg-bg-surface2 text-text-primary tracking-[0.5em] text-center text-lg font-mono"
                    placeholder="6位验证码"
                    maxLength={6}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                  />
                  <button
                    type="button"
                    onClick={handleSendSmsCode}
                    disabled={countdown > 0 || sendingCode || !/^1[3-9]\d{9}$/.test(phone)}
                    className="px-4 py-3 bg-accent hover:bg-accent-hover disabled:bg-bg-surface4 text-white rounded-xl text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed transition-colors min-w-[110px]"
                  >
                    {sendingCode ? '发送中...' : countdown > 0 ? `${countdown}s` : '获取验证码'}
                  </button>
                </div>
              </motion.div>

              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl text-sm text-red-600 dark:text-red-400"
                  >
                    {error}
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.div custom={3} variants={formElementVariants} initial="hidden" animate="visible">
                <button
                  type="submit"
                  disabled={isSubmitDisabled()}
                  className="w-full py-3 bg-accent hover:bg-accent-hover text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-all relative overflow-hidden"
                >
                  <AnimatePresence mode="wait">
                    {success ? (
                      <motion.div
                        key="success"
                        className="flex items-center justify-center gap-2"
                        variants={successIconVariants}
                        initial="hidden"
                        animate="visible"
                      >
                        <svg className="w-5 h-5 text-green-500" viewBox="0 0 24 24" fill="none">
                          <motion.circle
                            cx="12" cy="12" r="10"
                            stroke="currentColor" strokeWidth="2"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.2 }}
                          />
                          <motion.path
                            d="M8 12l3 3 5-6"
                            stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round"
                            variants={checkmarkVariants}
                            initial="hidden"
                            animate="visible"
                          />
                        </svg>
                        <span>成功！</span>
                      </motion.div>
                    ) : loading ? (
                      <motion.div
                        key="loading"
                        className="flex items-center justify-center gap-2"
                        variants={spinnerVariants}
                        initial="initial"
                        animate="loading"
                      >
                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span>验证中...</span>
                      </motion.div>
                    ) : (
                      <motion.span
                        key="idle"
                        variants={buttonContentVariants}
                        initial="initial"
                        animate="initial"
                        exit="loading"
                      >
                        登录 / 注册
                      </motion.span>
                    )}
                  </AnimatePresence>
                </button>
              </motion.div>

              <motion.p
                custom={4}
                variants={formElementVariants}
                initial="hidden"
                animate="visible"
                className="text-center text-xs text-text-muted"
              >
                新用户将自动注册，无需单独操作
              </motion.p>
            </motion.form>
          </motion.div>
        </motion.div>
      </div>
    </div>
  );
}
