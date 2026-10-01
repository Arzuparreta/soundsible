/** Resources belong to the authenticated client, not to a mounted route. */
export class RuntimeLifetime {
  private epoch = 0;
  private active = true;
  private cleanups = new Set<() => void>();
  private timeouts = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();

  capture(): () => boolean {
    const epoch = this.epoch;
    return () => this.active && this.epoch === epoch;
  }

  start(): void {
    if (!this.active) { this.active = true; this.epoch++; }
  }

  own(cleanup: () => void): void { this.cleanups.add(cleanup); }

  guard<F extends (...args: never[]) => unknown>(callback: F): F {
    const current = this.capture();
    return ((...args: Parameters<F>) => current() ? callback(...args) : undefined) as F;
  }

  listen<E extends Event>(target: EventTarget, type: string, callback: (event: E) => void, options?: AddEventListenerOptions): void {
    const current = this.capture();
    const guarded: EventListener = event => { if (current()) callback(event as E); };
    target.addEventListener(type, guarded, options);
    this.own(() => target.removeEventListener(type, guarded, options));
  }

  setTimeout(callback: () => void, delay = 0): ReturnType<typeof setTimeout> {
    const current = this.capture();
    const timer = setTimeout(() => {
      this.timeouts.delete(timer);
      if (current()) callback();
    }, delay);
    this.timeouts.add(timer);
    return timer;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer !== null) { clearTimeout(timer); this.timeouts.delete(timer); }
  }

  setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
    const current = this.capture();
    const timer = setInterval(() => { if (current()) callback(); }, delay);
    this.intervals.add(timer);
    return timer;
  }

  clearInterval(timer: ReturnType<typeof setInterval> | null): void {
    if (timer !== null) { clearInterval(timer); this.intervals.delete(timer); }
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch++;
    for (const timer of this.timeouts) clearTimeout(timer);
    for (const timer of this.intervals) clearInterval(timer);
    this.timeouts.clear();
    this.intervals.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }
}
