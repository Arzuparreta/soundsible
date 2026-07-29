let el: HTMLAudioElement | null = null;

const VOLUME_KEY = 'volume';

/** Read the persisted volume without forcing the lazy element into existence. */
export function storedVolume(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Single shared audio element (lazy so it is never created during SSR/tests by accident). */
export function audioEl(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.volume = storedVolume();
  }
  return el;
}

/**
 * Monotonic load counter. Every `load`/`prime`/`stop` claims the next value, so
 * an async continuation can tell whether it still owns the element. Without it,
 * the `play()` promise of a superseded track rejects with AbortError *after* the
 * new track started, and whoever catches it reports the new track as failed.
 */
let loadSeq = 0;

/** True while `token` is still the most recent load claim. */
export function isCurrentLoad(token: number): boolean {
  return token === loadSeq;
}

/** Release the current stream. Clearing `src` (rather than just pausing) is what
 * makes the browser abort the in-flight request — for previews that request is a
 * proxied googlevideo stream, so leaving it open keeps the engine streaming
 * bytes nobody is listening to. */
function detach(a: HTMLAudioElement): void {
  a.pause();
  if (a.getAttribute('src') !== null || a.currentSrc) {
    a.removeAttribute('src');
    a.load();
  }
}

export const audioService = {
  /**
   * Point the element at `url` and start playing.
   *
   * Rejects only for failures that belong to *this* load: being interrupted by
   * a newer load — the shape of a listener tapping through several previews
   * before any of them starts — resolves quietly instead.
   */
  load(url: string): Promise<void> {
    const a = audioEl();
    const token = ++loadSeq;
    // Assigning src runs the media load algorithm, which aborts the previous
    // fetch. No explicit detach: it would emit a spurious `pause` between the
    // two tracks and flicker the transport controls.
    a.src = url;
    return a.play().catch((err: unknown) => {
      if (token !== loadSeq) return; // superseded — the newer load owns the element
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    });
  },
  /** Reload a stalled stream and resume from the last audible position. */
  recover(url: string, positionSec: number): Promise<void> {
    const a = audioEl();
    const token = ++loadSeq;
    a.src = url;
    const resumeAtPosition = async () => {
      if (token !== loadSeq) return;
      const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
      if (position > 0) {
        const duration = a.duration;
        a.currentTime = Number.isFinite(duration) && duration > 0
          ? Math.min(position, Math.max(0, duration - 0.05))
          : position;
      }
      try {
        await a.play();
      } catch (err: unknown) {
        if (token !== loadSeq) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }
    };
    if (a.readyState >= 1) return resumeAtPosition();
    return new Promise<void>((resolve, reject) => {
      const onMetadata = () => {
        a.removeEventListener('error', onError);
        void resumeAtPosition().then(resolve, reject);
      };
      const onError = () => {
        a.removeEventListener('loadedmetadata', onMetadata);
        reject(new Error('media recovery failed'));
      };
      a.addEventListener('loadedmetadata', onMetadata, { once: true });
      a.addEventListener('error', onError, { once: true });
    });
  },
  /** Load without playing, optionally cued to `positionSec` (cross-device resume). */
  prime(url: string, positionSec = 0): void {
    const a = audioEl();
    const token = ++loadSeq;
    a.src = url;
    a.load();
    const applyPosition = () => {
      if (token !== loadSeq) return;
      const pos = Math.max(0, positionSec);
      if (!Number.isFinite(pos) || pos <= 0) return;
      const dur = a.duration;
      a.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(pos, dur) : pos;
    };
    if (a.readyState >= 1) applyPosition();
    else a.addEventListener('loadedmetadata', applyPosition, { once: true });
  },
  resume(): Promise<void> {
    return audioEl().play();
  },
  pause(): void {
    audioEl().pause();
  },
  /** Stop and release the stream — for teardown (track deleted, queue emptied),
   * not for pausing. */
  stop(): void {
    loadSeq += 1;
    detach(audioEl());
  },
  seek(t: number): void {
    const a = audioEl();
    if (Number.isFinite(t)) a.currentTime = Math.max(0, t);
  },
  /** 0..1 — persisted so volume survives reloads. */
  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    audioEl().volume = clamped;
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      /* private mode / storage disabled */
    }
  },
  getVolume(): number {
    return audioEl().volume;
  },
  setMuted(muted: boolean): void {
    audioEl().muted = muted;
  },
};
