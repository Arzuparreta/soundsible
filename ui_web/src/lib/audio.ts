let el: HTMLAudioElement | null = null;

/** Single shared audio element (lazy so it is never created during SSR/tests by accident). */
export function audioEl(): HTMLAudioElement {
  if (!el) el = new Audio();
  return el;
}

export const audioService = {
  load(url: string): Promise<void> {
    const a = audioEl();
    a.src = url;
    return a.play();
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
};
