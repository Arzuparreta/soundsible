/** One retry in flight, backoff while visible, immediate retry on network or
 * page restoration. Owned by its caller so logout/HMR cannot revive it. */
export function recoverConnection(attempt: () => Promise<boolean>): () => void {
  let stopped = false;
  let busy = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    if (stopped || busy) return;
    clearTimeout(timer);
    timer = undefined;
    busy = true;
    let connected = false;
    try { connected = await attempt(); } catch { /* transient transport failure */ }
    finally { busy = false; }
    if (stopped) return;
    if (connected) { stop(); return; }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
    if (document.visibilityState !== 'hidden') timer = setTimeout(() => { void run(); }, delay);
  };
  const wake = () => { if (document.visibilityState !== 'hidden') void run(); };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    window.removeEventListener('online', wake);
    window.removeEventListener('pageshow', wake);
    document.removeEventListener('visibilitychange', wake);
    document.removeEventListener('resume', wake);
  };
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
  document.addEventListener('visibilitychange', wake);
  document.addEventListener('resume', wake);
  void run();
  return stop;
}
