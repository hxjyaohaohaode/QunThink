import { useState, useEffect, useCallback } from 'react';
import { usePWAInstall } from '../../hooks/usePWAInstall';
import { motion, AnimatePresence } from 'framer-motion';

export function PWAInstallPrompt() {
  const {
    canInstall,
    shouldAutoShow,
    isInstalled,
    isStandalone,
    isOnline,
    isUpdateAvailable,
    install,
    dismissInstallPrompt,
    acceptUpdate,
    dismissUpdate,
    getInstallGuidance,
    platform,
  } = usePWAInstall();

  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [showManualGuide, setShowManualGuide] = useState(false);
  const [showOfflineBanner, setShowOfflineBanner] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (isStandalone || isInstalled) return;

    if (shouldAutoShow) {
      const timer = setTimeout(() => {
        setShowInstallBanner(true);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [shouldAutoShow, isStandalone, isInstalled]);

  useEffect(() => {
    if (!isOnline) {
      setWasOffline(true);
      setShowOfflineBanner(true);
    } else if (wasOffline) {
      setShowOfflineBanner(false);
      setWasOffline(false);
    }
  }, [isOnline, wasOffline]);

  const handleInstall = useCallback(async () => {
    const success = await install();
    if (success) {
      setShowInstallBanner(false);
    }
  }, [install]);

  const handleDismissInstall = useCallback(() => {
    dismissInstallPrompt();
    setShowInstallBanner(false);
  }, [dismissInstallPrompt]);

  const handleShowManualGuide = useCallback(() => {
    setShowManualGuide(true);
  }, []);

  const handleAcceptUpdate = useCallback(async () => {
    await acceptUpdate();
  }, [acceptUpdate]);

  const handleDismissUpdate = useCallback(() => {
    dismissUpdate();
  }, [dismissUpdate]);

  const guidance = getInstallGuidance();

  if (isStandalone && isInstalled && !isUpdateAvailable && isOnline) return null;

  return (
    <>
      <AnimatePresence>
        {!isOnline && showOfflineBanner && (
          <motion.div
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed top-0 left-0 right-0 z-[70] safe-area-top"
          >
            <div className="bg-amber-500/95 backdrop-blur-sm px-4 py-2 flex items-center justify-center gap-2">
              <svg className="w-4 h-4 text-amber-900 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-2.829-2.829a5 5 0 000-7.07m-4.243 4.243a1.5 1.5 0 010-2.122" />
              </svg>
              <span className="text-xs font-medium text-amber-900">网络已断开，部分功能不可用</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isUpdateAvailable && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 md:w-96 z-[60]"
          >
            <div className="bg-bg-surface border border-accent/30 rounded-2xl shadow-xl overflow-hidden">
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                    <svg className="w-5 h-5 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">发现新版本</h3>
                    <p className="text-xs text-text-secondary mt-0.5">更新后可获得最新功能和修复</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={handleAcceptUpdate}
                    className="flex-1 py-2 text-sm font-semibold text-white rounded-xl transition-all duration-200 active:scale-[0.98]"
                    style={{ backgroundColor: '#6C5CE7' }}
                  >
                    立即更新
                  </button>
                  <button
                    onClick={handleDismissUpdate}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary rounded-xl hover:bg-bg-surface2 transition-colors"
                  >
                    稍后
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showInstallBanner && !isInstalled && !isStandalone && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-20 md:bottom-6 left-4 right-4 md:left-auto md:right-6 md:w-96 z-[59]"
          >
            <div className="bg-bg-surface border border-border-subtle rounded-2xl shadow-xl overflow-hidden">
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-12 h-12 rounded-xl overflow-hidden">
                    <img src="/pwa/icon-192x192.png" alt="群想" className="w-full h-full" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-semibold text-text-primary">安装「群想」到桌面</h3>
                    <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                      {platform === 'ios'
                        ? '添加到主屏幕，像原生应用一样使用'
                        : '快速访问，离线可用，享受原生应用般的体验'}
                    </p>
                  </div>
                  <button
                    onClick={handleDismissInstall}
                    className="flex-shrink-0 p-1 rounded-lg hover:bg-bg-surface2 transition-colors"
                  >
                    <svg className="w-4 h-4 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {showManualGuide && guidance && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-3 p-3 bg-bg-primary rounded-xl">
                      <ol className="space-y-2">
                        {guidance.steps.map((step, index) => (
                          <li key={index} className="flex items-start gap-2">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-accent/10 text-accent text-[10px] font-bold flex items-center justify-center mt-0.5">
                              {index + 1}
                            </span>
                            <span className="text-xs text-text-secondary leading-relaxed">{step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </motion.div>
                )}

                <div className="mt-3 flex gap-2">
                  {canInstall && !showManualGuide ? (
                    <>
                      <button
                        onClick={handleInstall}
                        className="flex-1 py-2.5 text-sm font-semibold text-white rounded-xl transition-all duration-200 active:scale-[0.98]"
                        style={{ backgroundColor: '#6C5CE7' }}
                      >
                        立即安装
                      </button>
                      {guidance && (
                        <button
                          onClick={handleShowManualGuide}
                          className="px-4 py-2.5 text-sm text-text-secondary hover:text-text-primary rounded-xl hover:bg-bg-surface2 transition-colors"
                        >
                          其他方式
                        </button>
                      )}
                    </>
                  ) : guidance && !showManualGuide ? (
                    <button
                      onClick={handleShowManualGuide}
                      className="flex-1 py-2.5 text-sm font-semibold text-white rounded-xl transition-all duration-200 active:scale-[0.98]"
                      style={{ backgroundColor: '#6C5CE7' }}
                    >
                      查看安装步骤
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
