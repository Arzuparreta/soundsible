const VOLUME_KEY = 'volume';

let el: HTMLAudioElement | null = null;
let djEl: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let mainGain: GainNode | null = null;
let djGain: GainNode | null = null;
let masterGain: GainNode | null = null;
let djTimer: ReturnType<typeof setInterval> | null = null;
let djGeneration = 0;
let masterVolume = storedVolume();

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

function auxiliaryEl(): HTMLAudioElement {
  if (!djEl) {
    djEl = new Audio();
    djEl.preload = 'auto';
    djEl.crossOrigin = 'anonymous';
    if ('preservesPitch' in djEl) djEl.preservesPitch = true;
  }
  return djEl;
}

function ensureGraph(): boolean {
  if (audioContext && mainGain && djGain && masterGain) return true;
  const Context = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return false;
  try {
    audioContext = new Context();
    mainGain = audioContext.createGain();
    djGain = audioContext.createGain();
    masterGain = audioContext.createGain();
    audioContext.createMediaElementSource(audioEl()).connect(mainGain).connect(masterGain);
    audioContext.createMediaElementSource(auxiliaryEl()).connect(djGain).connect(masterGain);
    masterGain.connect(audioContext.destination);
    mainGain.gain.value = 1;
    djGain.gain.value = 0;
    masterGain.gain.value = masterVolume;
    // The graph owns volume from this point on.
    audioEl().volume = 1;
    auxiliaryEl().volume = 1;
    return true;
  } catch {
    audioContext = null;
    mainGain = null;
    djGain = null;
    masterGain = null;
    return false;
  }
}

export interface LiveTransitionPlan {
  technique: 'long_blend' | 'bass_swap' | 'filter_blend' | 'echo_cut' | 'structural_fade' | 'safe_fade';
  out_cue: number;
  in_cue: number;
  overlap_seconds: number;
  overlap_bars: number;
  playback_rate: number;
  confidence: number;
}

export interface LiveTransitionCallbacks {
  onDominant(): void;
  onComplete(position: number): void;
  onError(error: unknown): void;
}

function cancelDjTransition(): void {
  djGeneration += 1;
  if (djTimer) clearInterval(djTimer);
  djTimer = null;
  const secondary = djEl;
  if (secondary) {
    secondary.pause();
    secondary.removeAttribute('src');
    secondary.load();
  }
  if (mainGain && djGain && audioContext) {
    mainGain.gain.cancelScheduledValues(audioContext.currentTime);
    djGain.gain.cancelScheduledValues(audioContext.currentTime);
    mainGain.gain.value = 1;
    djGain.gain.value = 0;
  } else {
    audioEl().volume = masterVolume;
    if (secondary) secondary.volume = 0;
  }
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
    cancelDjTransition();
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
    cancelDjTransition();
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
    cancelDjTransition();
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
    cancelDjTransition();
    detach(audioEl());
  },
  seek(t: number): void {
    cancelDjTransition();
    const a = audioEl();
    if (Number.isFinite(t)) a.currentTime = Math.max(0, t);
  },
  /** 0..1 — persisted so volume survives reloads. */
  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    masterVolume = clamped;
    if (masterGain) masterGain.gain.value = clamped;
    else audioEl().volume = clamped;
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
    } catch {
      /* private mode / storage disabled */
    }
  },
  getVolume(): number {
    return masterVolume;
  },
  setMuted(muted: boolean): void {
    audioEl().muted = muted;
    if (djEl) djEl.muted = muted;
  },
  cancelDjTransition,
  /**
   * Start the incoming deck early and perform the transition in the running
   * player.  At the end its exact position is copied back to the canonical
   * media element so all existing playback/MediaSession listeners continue to
   * observe one stable element.
   */
  async scheduleDjTransition(
    url: string,
    plan: LiveTransitionPlan,
    callbacks: LiveTransitionCallbacks,
  ): Promise<void> {
    cancelDjTransition();
    const generation = djGeneration;
    const primary = audioEl();
    const secondary = auxiliaryEl();
    const graph = ensureGraph();
    if (audioContext?.state === 'suspended') await audioContext.resume().catch(() => {});
    const waitSec = Math.max(0, Number(plan.out_cue || 0) - primary.currentTime);
    const rate = Math.min(1.12, Math.max(0.88, Number(plan.playback_rate || 1)));
    const preRoll = Math.min(waitSec, 8, Math.max(0, Number(plan.in_cue || 0) / rate));
    const scheduledAt = performance.now();
    secondary.src = url;
    secondary.playbackRate = rate;
    const seekToCue = () => {
      secondary.currentTime = Math.max(0, Number(plan.in_cue || 0) - preRoll * secondary.playbackRate);
    };
    if (secondary.readyState >= 1) seekToCue();
    else secondary.addEventListener('loadedmetadata', seekToCue, { once: true });
    const startDelayMs = Math.max(0, waitSec - preRoll) * 1000;
    if (startDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, startDelayMs));
    }
    if (generation !== djGeneration) return;
    try {
      await secondary.play();
    } catch (error) {
      if (generation === djGeneration) callbacks.onError(error);
      return;
    }
    if (generation !== djGeneration) return;
    const transitionAt = scheduledAt + waitSec * 1000;
    const overlapMs = Math.max(2500, Number(plan.overlap_seconds || 8) * 1000);
    let dominant = false;
    djTimer = setInterval(() => {
      if (generation !== djGeneration) return;
      const now = performance.now();
      if (now < transitionAt) return;
      const progress = Math.min(1, Math.max(0, (now - transitionAt) / overlapMs));
      // Equal-power curves keep the perceived loudness steadier than linear
      // gain, especially on long blends.
      const incoming = Math.sin(progress * Math.PI * 0.5);
      const outgoing = Math.cos(progress * Math.PI * 0.5);
      if (graph && mainGain && djGain && audioContext) {
        mainGain.gain.setValueAtTime(outgoing, audioContext.currentTime);
        djGain.gain.setValueAtTime(incoming, audioContext.currentTime);
      } else {
        primary.volume = masterVolume * outgoing;
        secondary.volume = masterVolume * incoming;
      }
      if (!dominant && progress >= 0.5) {
        dominant = true;
        callbacks.onDominant();
      }
      if (progress < 1) return;
      if (djTimer) clearInterval(djTimer);
      djTimer = null;
      const position = secondary.currentTime;
      const rate = secondary.playbackRate;
      primary.src = url;
      const resumeCanonical = async () => {
        if (generation !== djGeneration) return;
        primary.currentTime = position;
        primary.playbackRate = rate;
        try {
          await primary.play();
          if (graph && mainGain && djGain && audioContext) {
            mainGain.gain.value = 1;
            djGain.gain.value = 0;
          } else {
            primary.volume = masterVolume;
            secondary.volume = 0;
          }
          secondary.pause();
          secondary.removeAttribute('src');
          secondary.load();
          callbacks.onComplete(primary.currentTime);
        } catch (error) {
          callbacks.onError(error);
        }
      };
      if (primary.readyState >= 1) void resumeCanonical();
      else primary.addEventListener('loadedmetadata', () => void resumeCanonical(), { once: true });
    }, 50);
  },
};
