let el: HTMLAudioElement | null = null;

const VOLUME_KEY = 'volume';

function initialVolume(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

/** Single shared audio element (lazy so it is never created during SSR/tests by accident). */
export function audioEl(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.volume = initialVolume();
  }
  return el;
}

export const audioService = {
  load(url: string): Promise<void> {
    const a = audioEl();
    a.src = url;
    return a.play();
  },
  prime(url: string, positionSec = 0): void {
    const a = audioEl();
    a.src = url;
    a.load();
    const applyPosition = () => {
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
