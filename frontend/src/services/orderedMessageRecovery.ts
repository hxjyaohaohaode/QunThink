/** One active page, one timer and one in-flight read round per document. */
export function createOrderedMessageRecovery(options: {
  eligible: () => boolean;
  nextAllowedAt: () => number;
  run: () => Promise<void>;
  now?: () => number;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let listening = false;
  let stopped = false;
  const now = () => options.now ? options.now() : Date.now();
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const wake = (): Promise<void> => {
    clear();
    if (stopped || !options.eligible()) return inFlight || Promise.resolve();
    if (inFlight) return inFlight;
    const remaining = options.nextAllowedAt() - now();
    if (remaining > 0) {
      timer = setTimeout(() => { timer = undefined; void wake(); }, Math.min(remaining, 2147483647));
      return Promise.resolve();
    }
    const task = Promise.resolve().then(() => { if (!stopped && options.eligible()) return options.run(); }).then(() => undefined);
    inFlight = task;
    void task.finally(() => { if (inFlight === task) inFlight = undefined; void wake(); }).catch(() => {});
    return task;
  };
  const onEvent = () => { void wake(); };
  return {
    wake,
    start() {
      stopped = false;
      if (!listening) {
        if (typeof window !== 'undefined') for (const name of ['focus', 'online', 'offline']) window.addEventListener(name, onEvent);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onEvent);
        listening = true;
      }
      return wake();
    },
    stop() {
      stopped = true; clear();
      if (listening) {
        if (typeof window !== 'undefined') for (const name of ['focus', 'online', 'offline']) window.removeEventListener(name, onEvent);
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onEvent);
      }
      listening = false;
    },
  };
}

export const orderedReadEnvironmentReady = () =>
  (typeof document === 'undefined' || document.visibilityState !== 'hidden') &&
  (typeof navigator === 'undefined' || navigator.onLine !== false);
