import { useState, useEffect, useCallback, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export type Platform = 'android' | 'ios' | 'desktop-chrome' | 'desktop-edge' | 'unknown';

export function usePWAInstall() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [platform, setPlatform] = useState<Platform>('unknown');
  const installPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const dismissedCountRef = useRef(0);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (registration) {
        setInterval(() => {
          registration.update();
        }, 60 * 60 * 1000);
      }
    },
    onRegisterError(error) {
      console.error('SW registration error:', error);
    },
  });

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as any).standalone === true ||
      document.referrer.includes('android-app://');

    setIsStandalone(standalone);
    setIsInstalled(standalone || localStorage.getItem('pwa-installed') === 'true');

    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      setPlatform('ios');
    } else if (/Android/.test(ua)) {
      setPlatform('android');
    } else if (/Chrome/.test(ua) && !/Edge/.test(ua)) {
      setPlatform('desktop-chrome');
    } else if (/Edge/.test(ua)) {
      setPlatform('desktop-edge');
    } else {
      setPlatform('unknown');
    }

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      const promptEvent = e as BeforeInstallPromptEvent;
      installPromptRef.current = promptEvent;
      setInstallPrompt(promptEvent);
    };

    const handleAppInstalled = () => {
      localStorage.setItem('pwa-installed', 'true');
      localStorage.removeItem('pwa-install-dismissed');
      localStorage.removeItem('pwa-install-dismissed-count');
      installPromptRef.current = null;
      setInstallPrompt(null);
      setIsInstalled(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const canShowInstallPrompt = useCallback((): boolean => {
    if (isStandalone || isInstalled) return false;
    if (installPrompt) return true;

    if (platform === 'ios') return true;

    return false;
  }, [isStandalone, isInstalled, installPrompt, platform]);

  const shouldAutoShowInstallPrompt = useCallback((): boolean => {
    if (!canShowInstallPrompt()) return false;

    const dismissedCount = parseInt(localStorage.getItem('pwa-install-dismissed-count') || '0', 10);
    const lastDismissed = parseInt(localStorage.getItem('pwa-install-dismissed') || '0', 10);

    if (dismissedCount === 0) return true;

    const hoursSinceDismissed = (Date.now() - lastDismissed) / (1000 * 60 * 60);
    if (dismissedCount === 1 && hoursSinceDismissed >= 24) return true;
    if (dismissedCount >= 2 && hoursSinceDismissed >= 168) return true;

    return false;
  }, [canShowInstallPrompt]);

  const install = useCallback(async (): Promise<boolean> => {
    const prompt = installPromptRef.current || installPrompt;
    if (!prompt) return false;

    try {
      await prompt.prompt();
      const choiceResult = await prompt.userChoice;

      if (choiceResult.outcome === 'accepted') {
        localStorage.setItem('pwa-installed', 'true');
        installPromptRef.current = null;
        setInstallPrompt(null);
        setIsInstalled(true);
        return true;
      } else {
        const newCount = dismissedCountRef.current + 1;
        localStorage.setItem('pwa-install-dismissed', Date.now().toString());
        localStorage.setItem('pwa-install-dismissed-count', newCount.toString());
        dismissedCountRef.current = newCount;
        return false;
      }
    } catch {
      return false;
    }
  }, [installPrompt]);

  const dismissInstallPrompt = useCallback(() => {
    const newCount = dismissedCountRef.current + 1;
    localStorage.setItem('pwa-install-dismissed', Date.now().toString());
    localStorage.setItem('pwa-install-dismissed-count', newCount.toString());
    dismissedCountRef.current = newCount;
  }, []);

  const acceptUpdate = useCallback(async () => {
    await updateServiceWorker(true);
    setNeedRefresh(false);
  }, [updateServiceWorker, setNeedRefresh]);

  const dismissUpdate = useCallback(() => {
    setNeedRefresh(false);
  }, [setNeedRefresh]);

  const getInstallGuidance = useCallback((): { platform: Platform; steps: string[]; icon: string } | null => {
    if (platform === 'ios') {
      return {
        platform: 'ios',
        icon: 'safari',
        steps: [
          '点击底部工具栏的分享按钮（方框+向上箭头）',
          '在弹出菜单中向下滚动，找到"添加到主屏幕"',
          '点击"添加"，然后点击右上角"添加"确认',
          '返回主屏幕，即可看到"群想"图标'
        ]
      };
    }

    if (platform === 'desktop-chrome') {
      return {
        platform: 'desktop-chrome',
        icon: 'chrome',
        steps: [
          '点击地址栏右侧的安装图标（⊕或电脑显示器+箭头）',
          '或者在菜单中选择"安装群想"',
          '在弹出的确认对话框中点击"安装"'
        ]
      };
    }

    if (platform === 'desktop-edge') {
      return {
        platform: 'desktop-edge',
        icon: 'edge',
        steps: [
          '点击地址栏右侧的安装图标，或在菜单中选择"应用"',
          '选择"将此站点作为应用安装"',
          '在弹出的确认对话框中点击"安装"'
        ]
      };
    }

    if (platform === 'android' && !installPrompt) {
      return {
        platform: 'android',
        icon: 'browser',
        steps: [
          '点击浏览器右上角的菜单按钮（⋮）',
          '找到并点击"添加到主屏幕"或"安装应用"',
          '在弹出的确认对话框中点击"添加"或"安装"'
        ]
      };
    }

    return null;
  }, [platform, installPrompt]);

  return {
    isInstalled,
    isStandalone,
    isOnline,
    platform,
    installPrompt,
    canInstall: canShowInstallPrompt(),
    shouldAutoShow: shouldAutoShowInstallPrompt(),
    isUpdateAvailable: needRefresh,
    install,
    dismissInstallPrompt,
    acceptUpdate,
    dismissUpdate,
    getInstallGuidance,
  };
}
