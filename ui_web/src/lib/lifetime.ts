/** Ownership for timers, subscriptions and async work belonging to one session. */
export class Lifetime {
  private cleanups = new Set<() => void>();
  private timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly controller = new AbortController();
  get disposed(): boolean { return this.controller.signal.aborted; }

  add(cleanup: (() => void) | void): void {
    if (!cleanup) return;
    if (this.disposed) cleanup();
    else this.cleanups.add(cleanup);
  }

  listen<E extends Event>(target: EventTarget, event: string, handler: (event: E) => void, options?: AddEventListenerOptions): void {
    if (this.disposed) return;
    target.addEventListener(event, handler as EventListener, options);
    this.add(() => target.removeEventListener(event, handler as EventListener, options));
  }

  timeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) callback();
    }, delay);
    if (this.disposed) clearTimeout(id);
    else this.timers.set(id, () => clearTimeout(id));
    return id;
  }

  clearTimeout(id: ReturnType<typeof setTimeout>): void {
    clearTimeout(id);
    this.timers.delete(id);
  }

  interval(callback: () => void, delay: number): void {
    if (this.disposed) return;
    const id = setInterval(() => { if (!this.disposed) callback(); }, delay);
    this.add(() => clearInterval(id));
  }

  dispose(): void {
    if (this.disposed) return;
    this.controller.abort();
    for (const cleanup of this.cleanups) cleanup();
    for (const cleanup of this.timers.values()) cleanup();
    this.cleanups.clear();
    this.timers.clear();
  }
}

/** Cancellation settles the caller even when a dependency ignores its signal. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
