const VOLUME_KEY = 'volume';

/** Media-clock supervision. Audio gain itself is sample-accurate automation. */
const TICK_MS = 40;
/** Supervision rate during the long `armed` wait, where a tick only compares
 * the media clock against the preroll point. See `tickInterval`. */
const ARMED_TICK_MS = 250;
/** Runway left, in seconds, at which `armed` goes back to watching at TICK_MS. */
const ARMED_FINE_LEAD = 2;
/** Longest silent head start given to the incoming deck. */
const MAX_PREROLL = 4;
const MIN_OVERLAP = 1.2;
/** After a beatmatched blend the incoming deck drifts back to its own tempo. */
const RATE_RETURN_MS = 8_000;

let elements: HTMLAudioElement[] | null = null;
let activeIndex = 0;
/** Shadow of each deck's mix gain, so volume changes can be reapplied without
 * an AudioContext. */
const mixGains = [1, 0];
let audioContext: AudioContext | null = null;
let deckGains: GainNode[] | null = null;
interface DeckEffects {
  low?: BiquadFilterNode;
  filter?: BiquadFilterNode;
  /** Where the echo send taps the deck, kept so it can be built on demand. */
  source?: MediaElementAudioSourceNode;
  delay?: DelayNode;
  echoWet?: GainNode;
  echoFeedback?: GainNode;
}
let deckEffects: DeckEffects[] | null = null;
let masterGain: GainNode | null = null;
let masterVolume = storedVolume();
let allMuted = false;

/** Read the persisted volume without forcing the lazy elements into existence. */
export function storedVolume(): number {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VOLUME_KEY) : null;
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

function createDeck(): HTMLAudioElement {
  const deck = new Audio();
  deck.preload = 'auto';
  if ('preservesPitch' in deck) deck.preservesPitch = true;
  return deck;
}

/**
 * The two decks.
 *
 * They are symmetric on purpose: a DJ handoff makes the incoming deck the
 * active one and simply releases the other. The previous single-canonical-deck
 * arrangement had to copy the incoming position back into the canonical element
 * at the end of every transition, which meant re-assigning `src` and
 * re-buffering a stream that was already playing.
 */
function decks(): HTMLAudioElement[] {
  if (!elements) {
    elements = [createDeck(), createDeck()];
    applyDeckVolume();
  }
  return elements;
}

/** The deck that currently owns playback. Everything outside this module talks
 * to Soundsible's playback through this one element. */
export function audioEl(): HTMLAudioElement {
  return decks()[activeIndex];
}

/** Run `fn` for both decks — for binding listeners that have to survive a
 * handoff. Pair it with `isActiveDeck` to ignore the deck that is only being
 * prepared. */
export function eachDeck(fn: (deck: HTMLAudioElement, index: number) => void): void {
  decks().forEach(fn);
}

/** True when `target` is the deck that currently owns playback. */
export function isActiveDeck(target: EventTarget | null): boolean {
  return target === decks()[activeIndex];
}

function applyDeckVolume(): void {
  if (!elements) return;
  if (masterGain && audioContext) {
    masterGain.gain.value = masterVolume;
    for (const deck of elements) deck.volume = 1;
    return;
  }
  elements.forEach((deck, index) => {
    deck.volume = Math.min(1, Math.max(0, mixGains[index] * masterVolume));
  });
}

/**
 * Set one deck's mix gain.
 *
 * This is for discrete deck state changes. Audible crossfades bypass it and use
 * one scheduled AudioParam curve, because repeatedly cancelling short ramps is
 * exactly what made the old mixer crackle when a timer arrived late.
 */
function setDeckGain(index: number, value: number): void {
  const clamped = Math.min(1, Math.max(0, value));
  mixGains[index] = clamped;
  if (deckGains && audioContext) {
    const param = deckGains[index].gain;
    const now = audioContext.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(clamped, now);
    return;
  }
  const deck = decks()[index];
  deck.volume = Math.min(1, Math.max(0, clamped * masterVolume));
}

/**
 * Build the mixing graph.
 *
 * Called from the gesture that opens Auto Mode, never from a timer: once an
 * element is routed through an AudioContext its output only exists inside the
 * graph, so a context that cannot leave `suspended` would silence playback
 * outright. Inside a user gesture `resume()` is reliable, and a context that
 * still refuses to run leaves the elements untouched and the mixer falls back
 * to element volume.
 */
export function ensureMixGraph(): boolean {
  if (audioContext && deckGains && masterGain) return true;
  const Context = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return false;
  try {
    const list = decks();
    const context = new Context();
    void context.resume?.().catch(() => {});
    const master = context.createGain();
    // Reach the speakers before anything is routed in: a graph that throws
    // halfway would otherwise leave a deck connected to nothing audible.
    if (typeof context.createDynamicsCompressor === 'function') {
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 8;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;
      master.connect(limiter).connect(context.destination);
    } else {
      master.connect(context.destination);
    }
    master.gain.value = masterVolume;
    const effects: DeckEffects[] = [];
    const gains = list.map((deck, index) => {
      const gain = context.createGain();
      gain.gain.value = mixGains[index];
      const source = context.createMediaElementSource(deck);
      if (typeof context.createBiquadFilter === 'function') {
        const low = context.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 220;
        low.gain.value = 0;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 22000;
        filter.Q.value = 0.7;
        source.connect(low).connect(filter).connect(gain).connect(master);
        // No echo send here: see `ensureEcho`.
        effects.push({ low, filter, source });
      } else {
        source.connect(gain).connect(master);
        effects.push({});
      }
      return gain;
    });
    for (const deck of list) deck.volume = 1;
    audioContext = context;
    deckGains = gains;
    deckEffects = effects;
    masterGain = master;
    return true;
  } catch {
    audioContext = null;
    deckGains = null;
    deckEffects = null;
    masterGain = null;
    applyDeckVolume();
    return false;
  }
}

export interface LiveTransitionPlan {
  technique: 'long_blend' | 'bass_swap' | 'filter_blend' | 'echo_cut' | 'structural_fade' | 'safe_fade';
  /** Position in the *outgoing* deck at which the blend begins. */
  out_cue: number;
  in_cue: number;
  overlap_seconds: number;
  overlap_bars: number;
  playback_rate: number;
  confidence: number;
  sync?: { phase_tolerance_ms?: number };
  automation?: { eq?: 'bass_swap' | 'neutral'; filter?: boolean; echo_out?: boolean };
}

export type MixPhase = 'idle' | 'armed' | 'prerolling' | 'crossfading';
export type MixCancelReason = 'superseded' | 'load' | 'seek' | 'stop' | 'exit' | 'failed';

export interface MixCallbacks {
  /** The incoming deck is loaded and cued; the handoff is now committed. */
  onArmed?(): void;
  /** The incoming deck owns playback from this moment. */
  onDominant(): void;
  onComplete(position: number): void;
  onCancel(reason: MixCancelReason): void;
  onError(error: unknown): void;
}

interface ActiveMix {
  phase: Exclude<MixPhase, 'idle'>;
  fromIndex: number;
  toIndex: number;
  outCue: number;
  inCue: number;
  /** Overlap in wall seconds. */
  overlap: number;
  rate: number;
  preroll: number;
  /** Incoming media position at which the crossfade started. */
  mixStart: number | null;
  technique: LiveTransitionPlan['technique'];
  phaseTolerance: number;
  phaseCorrected: boolean;
  dominant: boolean;
  /** A listener-requested skip: hand over as soon as the blend begins. */
  manual: boolean;
  callbacks: MixCallbacks;
}

let mix: ActiveMix | null = null;
let mixGeneration = 0;
let mixTimer: ReturnType<typeof setTimeout> | null = null;
let rateTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Build the echo send for a deck, if it does not have one.
 *
 * Only `echo_cut` ever uses this, and only on the outgoing deck — but a delay
 * line inside a feedback loop can never be proved silent, so Web Audio has to
 * render it regardless of the send being at zero. Built up front, that was two
 * permanently running delay lines for every session that so much as opened Auto
 * Mode. Built here and torn down in `resetDeckEffects`, it only costs the audio
 * thread anything during the blend that asked for it.
 */
function ensureEcho(index: number): void {
  const effect = deckEffects?.[index];
  if (!effect || effect.echoWet || !audioContext || !masterGain) return;
  const source = effect.source;
  if (!source || typeof audioContext.createDelay !== 'function') return;
  const delay = audioContext.createDelay(1);
  delay.delayTime.value = 0.28;
  const wet = audioContext.createGain();
  wet.gain.value = 0;
  const feedback = audioContext.createGain();
  feedback.gain.value = 0.32;
  source.connect(delay).connect(wet).connect(masterGain);
  delay.connect(feedback).connect(delay);
  effect.delay = delay;
  effect.echoWet = wet;
  effect.echoFeedback = feedback;
}

/** Break the feedback loop so the graph can drop it. The send is already at
 * zero by the time this runs, so nothing audible is being cut. */
function disposeEcho(effect: DeckEffects): void {
  if (!effect.echoWet) return;
  effect.echoFeedback?.disconnect();
  effect.echoWet.disconnect();
  effect.delay?.disconnect();
  effect.delay = undefined;
  effect.echoWet = undefined;
  effect.echoFeedback = undefined;
}

function resetDeckEffects(index: number): void {
  const effect = deckEffects?.[index];
  if (!effect || !audioContext) return;
  const now = audioContext.currentTime;
  const params = [
    effect.low?.gain,
    effect.filter?.frequency,
    effect.echoWet?.gain,
    effect.echoFeedback?.gain,
  ];
  for (const param of params) param?.cancelScheduledValues(now);
  effect.low?.gain.setValueAtTime(0, now);
  effect.filter?.frequency.setValueAtTime(22000, now);
  effect.echoWet?.gain.setValueAtTime(0, now);
  disposeEcho(effect);
}

function scheduleCurve(param: AudioParam | undefined, values: number[], duration: number): void {
  if (!param || !audioContext) return;
  const now = audioContext.currentTime;
  const span = Math.max(0.05, duration);
  param.cancelScheduledValues(now);
  param.setValueAtTime(values[0], now);
  if (typeof param.setValueCurveAtTime === 'function') {
    param.setValueCurveAtTime(Float32Array.from(values), now, span);
  } else {
    param.linearRampToValueAtTime(values[values.length - 1], now + span);
  }
}

/** Schedule one continuous curve; the supervisory timer never rewrites it. */
function scheduleCrossfade(current: ActiveMix): void {
  if (!deckGains || !audioContext) return;
  const points = 96;
  const incoming = Array.from(
    { length: points },
    (_, index) => Math.sin((index / (points - 1)) * Math.PI * 0.5),
  );
  const outgoing = Array.from(
    { length: points },
    (_, index) => Math.cos((index / (points - 1)) * Math.PI * 0.5),
  );
  scheduleCurve(deckGains[current.toIndex].gain, incoming, current.overlap);
  scheduleCurve(deckGains[current.fromIndex].gain, outgoing, current.overlap);

  const outEffect = deckEffects?.[current.fromIndex];
  const inEffect = deckEffects?.[current.toIndex];
  if (current.technique === 'bass_swap' || current.technique === 'long_blend') {
    scheduleCurve(outEffect?.low?.gain, [0, 0, -4, -12, -18, -18], current.overlap);
    scheduleCurve(inEffect?.low?.gain, [-18, -18, -12, -4, 0, 0], current.overlap);
  }
  if (current.technique === 'filter_blend' || current.technique === 'long_blend') {
    scheduleCurve(outEffect?.filter?.frequency, [22000, 18000, 9000, 3500, 1200, 700], current.overlap);
    scheduleCurve(inEffect?.filter?.frequency, [900, 1600, 4200, 10000, 18000, 22000], current.overlap);
  }
  if (current.technique === 'echo_cut') {
    ensureEcho(current.fromIndex);
    scheduleCurve(outEffect?.echoWet?.gain, [0, 0.05, 0.12, 0.24, 0.32, 0.18], current.overlap);
  }
}

/**
 * How long the supervisor waits before looking at the media clock again.
 *
 * `armed` is a long wait: the DJ commits a transition COMMIT_LEAD_SECONDS (45)
 * before the out-cue, and every look until the preroll point does nothing but
 * compare two numbers. Watching that at mix resolution is ~1100 timer wakeups
 * per track, which on a low-power laptop is enough on its own to keep the CPU
 * out of its deeper idle states for most of the song. The coarse rate still
 * lands far inside the head start the preroll allows (MIN_OVERLAP is 1.2s), and
 * a late start is what `prerolling`'s phase correction exists to absorb —
 * everything that actually needs resolution runs from that phase on.
 */
function tickInterval(): number {
  const current = mix;
  if (!current || current.phase !== 'armed') return TICK_MS;
  const from = decks()[current.fromIndex];
  const runway = current.outCue - current.preroll - (from.currentTime || 0);
  return runway > ARMED_FINE_LEAD ? ARMED_TICK_MS : TICK_MS;
}

/** Bumped by every stop, so a timeout already in flight cannot re-arm itself. */
let tickerToken = 0;

function startTicker(): void {
  stopTicker();
  const token = tickerToken;
  const run = () => {
    mixTimer = null;
    tick();
    // tick() may have finished, failed or cancelled the mix, each of which
    // stops the ticker. Reviving it here would outlive the transition.
    if (token !== tickerToken) return;
    mixTimer = setTimeout(run, tickInterval());
  };
  mixTimer = setTimeout(run, tickInterval());
}

function stopTicker(): void {
  tickerToken += 1;
  if (mixTimer) clearTimeout(mixTimer);
  mixTimer = null;
}

function stopRateReturn(): void {
  if (rateTimer) clearInterval(rateTimer);
  rateTimer = null;
}

/** Walk a beatmatched deck back to its own tempo once the blend is over. Over
 * eight seconds, with pitch preserved, this is inaudible — and leaving the deck
 * permanently detuned is not. */
function scheduleRateReturn(index: number): void {
  stopRateReturn();
  const deck = decks()[index];
  const from = deck.playbackRate;
  if (Math.abs(from - 1) < 0.001) {
    deck.playbackRate = 1;
    return;
  }
  const startedAt = Date.now();
  rateTimer = setInterval(() => {
    if (decks()[activeIndex] !== deck) {
      stopRateReturn();
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / RATE_RETURN_MS);
    deck.playbackRate = from + (1 - from) * progress;
    if (progress >= 1) stopRateReturn();
  }, 200);
}

/** Release a stream. Clearing `src` (rather than just pausing) is what makes the
 * browser abort the in-flight request — for previews that request is a proxied
 * googlevideo stream, so leaving it open keeps the engine streaming bytes nobody
 * is listening to. */
function detach(deck: HTMLAudioElement): void {
  deck.pause();
  deck.playbackRate = 1;
  if (deck.getAttribute('src') !== null || deck.currentSrc) {
    deck.removeAttribute('src');
    deck.load();
  }
}

/**
 * Tear down the running transition.
 *
 * Whichever deck currently owns playback keeps it; the other is released. That
 * single rule is what keeps audio and UI from disagreeing: before the handoff a
 * cancel means "stay on the outgoing track", after it a cancel means "the
 * incoming track is simply the current track now".
 */
function cancelMix(reason: MixCancelReason): void {
  const current = mix;
  mixGeneration += 1;
  stopTicker();
  mix = null;
  if (!current) return;
  const keep = current.dominant ? current.toIndex : current.fromIndex;
  const drop = 1 - keep;
  activeIndex = keep;
  setDeckGain(keep, 1);
  setDeckGain(drop, 0);
  resetDeckEffects(keep);
  resetDeckEffects(drop);
  detach(decks()[drop]);
  if (current.dominant) scheduleRateReturn(keep);
  current.callbacks.onCancel(reason);
}

function finishMix(): void {
  const current = mix;
  if (!current) return;
  const incoming = decks()[current.toIndex];
  stopTicker();
  mix = null;
  setDeckGain(current.toIndex, 1);
  setDeckGain(current.fromIndex, 0);
  resetDeckEffects(current.toIndex);
  resetDeckEffects(current.fromIndex);
  if (!current.dominant) {
    activeIndex = current.toIndex;
    current.callbacks.onDominant();
  }
  detach(decks()[current.fromIndex]);
  scheduleRateReturn(current.toIndex);
  current.callbacks.onComplete(incoming.currentTime);
}

function failMix(error: unknown): void {
  const current = mix;
  if (!current) return;
  mixGeneration += 1;
  stopTicker();
  mix = null;
  const keep = current.dominant ? current.toIndex : current.fromIndex;
  activeIndex = keep;
  setDeckGain(keep, 1);
  setDeckGain(1 - keep, 0);
  resetDeckEffects(keep);
  resetDeckEffects(1 - keep);
  detach(decks()[1 - keep]);
  current.callbacks.onError(error);
}

/**
 * One tick of the mixer.
 *
 * Every decision reads a *media* clock — `deck.currentTime` — rather than wall
 * time. A buffering outgoing deck therefore delays its own transition instead of
 * being mixed out of at the wrong musical moment, and a pause freezes the blend
 * exactly where it was.
 */
function tick(): void {
  const current = mix;
  if (!current) {
    stopTicker();
    return;
  }
  const from = decks()[current.fromIndex];
  const to = decks()[current.toIndex];

  if (current.phase === 'armed') {
    if (from.paused && !from.ended) return;
    const due = from.ended || from.currentTime >= current.outCue - current.preroll;
    if (!due) return;
    // Invariant: nothing fades until the incoming deck can actually sound.
    if (to.readyState < 3 && !from.ended) return;
    current.phase = 'prerolling';
    void to.play().catch((error) => failMix(error));
    // A requested skip has no head start to wait out: fall straight through.
    if (!current.manual) return;
  }

  // A pause anywhere holds the blend where it is; the gains stay put because
  // the incoming media clock is what drives them.
  if (to.paused || (from.paused && !from.ended)) return;

  if (current.phase === 'prerolling') {
    const outRemaining = current.outCue - from.currentTime;
    const inRemaining = (current.inCue - to.currentTime) / current.rate;
    const phaseError = inRemaining - outRemaining;
    if (
      !current.manual
      && !current.phaseCorrected
      && outRemaining > 0.15
      && Math.abs(phaseError) > current.phaseTolerance
    ) {
      // The incoming deck is silent. Correcting its playhead here prevents a
      // flam instead of trying to hide one after both tracks are audible.
      to.currentTime = Math.max(0, current.inCue - outRemaining * current.rate);
      current.phaseCorrected = true;
      return;
    }
    const due = current.manual || from.ended
      || (outRemaining <= current.phaseTolerance && inRemaining <= current.phaseTolerance);
    if (!due) return;
    if (!from.ended && !current.manual) {
      const target = current.inCue + Math.max(0, from.currentTime - current.outCue) * current.rate;
      if (Math.abs(to.currentTime - target) > current.phaseTolerance * current.rate) {
        to.currentTime = Math.max(0, target);
      }
    }
    current.mixStart = to.currentTime;
    current.phase = 'crossfading';
    scheduleCrossfade(current);
  }

  const span = Math.max(0.05, current.overlap * current.rate);
  const elapsed = to.currentTime - (current.mixStart ?? to.currentTime);
  const progress = Math.min(1, Math.max(0, elapsed / span));
  // Equal-power curves keep the perceived loudness steadier than linear gain,
  // especially on long blends.
  if (!deckGains || !audioContext) {
    setDeckGain(current.toIndex, Math.sin(progress * Math.PI * 0.5));
    setDeckGain(current.fromIndex, Math.cos(progress * Math.PI * 0.5));
  }
  if (!current.dominant && (current.manual || progress >= 0.5)) {
    current.dominant = true;
    activeIndex = current.toIndex;
    current.callbacks.onDominant();
  }
  if (progress >= 1) finishMix();
}

/**
 * Monotonic load counter. Every `load`/`prime`/`stop` claims the next value, so
 * an async continuation can tell whether it still owns the deck. Without it,
 * the `play()` promise of a superseded track rejects with AbortError *after* the
 * new track started, and whoever catches it reports the new track as failed.
 */
let loadSeq = 0;

/** True while `token` is still the most recent load claim. */
export function isCurrentLoad(token: number): boolean {
  return token === loadSeq;
}

export const audioService = {
  /**
   * Point the active deck at `url` and start playing.
   *
   * Rejects only for failures that belong to *this* load: being interrupted by
   * a newer load — the shape of a listener tapping through several previews
   * before any of them starts — resolves quietly instead.
   */
  load(url: string): Promise<void> {
    cancelMix('load');
    const a = audioEl();
    const token = ++loadSeq;
    stopRateReturn();
    a.playbackRate = 1;
    // Assigning src runs the media load algorithm, which aborts the previous
    // fetch. No explicit detach: it would emit a spurious `pause` between the
    // two tracks and flicker the transport controls.
    a.src = url;
    return a.play().catch((err: unknown) => {
      if (token !== loadSeq) return; // superseded — the newer load owns the deck
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    });
  },
  /** Reload a stalled stream and resume from the last audible position. */
  recover(url: string, positionSec: number): Promise<void> {
    cancelMix('load');
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
    cancelMix('load');
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
  /** Resume playback. A frozen blend resumes on both decks together. */
  resume(): Promise<void> {
    // Once the decks are routed through the graph, their output only exists
    // inside it. Resuming here costs nothing and means any play gesture can
    // recover a context the browser suspended behind our back.
    if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});
    const current = mix;
    if (current && current.phase !== 'armed') {
      const partner = decks()[current.dominant ? current.fromIndex : current.toIndex];
      void partner.play().catch(() => {});
    }
    return audioEl().play();
  },
  /** Pause playback. During a blend both decks stop together and the crossfade
   * freezes where it stands, because it advances on the media clock. */
  pause(): void {
    if (mix) {
      for (const deck of decks()) deck.pause();
      if (audioContext?.state === 'running') void audioContext.suspend().catch(() => {});
      return;
    }
    audioEl().pause();
  },
  /** Stop and release the stream — for teardown (track deleted, queue emptied),
   * not for pausing. */
  stop(): void {
    loadSeq += 1;
    cancelMix('stop');
    detach(audioEl());
  },
  seek(t: number): void {
    cancelMix('seek');
    const a = audioEl();
    if (Number.isFinite(t)) a.currentTime = Math.max(0, t);
  },
  /** 0..1 — persisted so volume survives reloads. */
  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    masterVolume = clamped;
    if (masterGain) masterGain.gain.value = clamped;
    else applyDeckVolume();
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
    allMuted = muted;
    for (const deck of decks()) deck.muted = muted;
  },
  ensureMixGraph,
  mixPhase(): MixPhase {
    return mix?.phase ?? 'idle';
  },
  /** True once the incoming deck owns playback — the point past which cancelling
   * would mean reviving a track the listener already stopped hearing. */
  mixIsDominant(): boolean {
    return mix?.dominant ?? false;
  },
  cancelMix,
  /**
   * Bring a prepared blend forward because the listener asked for the next
   * track now. The incoming deck keeps whatever it has already buffered — a
   * skip should not pay for a fresh seek.
   */
  startMixNow(overlapSeconds = 1.6): boolean {
    const current = mix;
    if (!current || current.phase === 'crossfading') return false;
    current.manual = true;
    current.preroll = 0;
    current.overlap = Math.max(MIN_OVERLAP, overlapSeconds);
    current.outCue = decks()[current.fromIndex].currentTime;
    tick();
    return true;
  },

  /**
   * Commit to a transition: load the incoming deck, cue it, and hold.
   *
   * Nothing sounds until the outgoing deck's own clock reaches the cue, so
   * arming early is free. `manual` is a listener-requested skip: the blend
   * starts at once and the handoff is reported immediately, because the
   * listener already knows they changed the track.
   */
  armTransition(
    url: string,
    plan: LiveTransitionPlan,
    callbacks: MixCallbacks,
    options: { manual?: boolean } = {},
  ): void {
    cancelMix('superseded');
    const generation = ++mixGeneration;
    ensureMixGraph();
    // Deliberately not awaited: the mix has to be armed before this function
    // returns, or the caller's own "is a handoff prepared?" check races it. The
    // graph is only touched later, by which point the context has resumed.
    if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});

    const fromIndex = activeIndex;
    const toIndex = 1 - activeIndex;
    const from = decks()[fromIndex];
    const to = decks()[toIndex];
    const manual = options.manual === true;
    const rate = Math.min(1.06, Math.max(0.94, Number(plan.playback_rate) || 1));
    const overlap = manual
      ? Math.max(MIN_OVERLAP, Math.min(1.8, Number(plan.overlap_seconds) || 4))
      : Math.max(MIN_OVERLAP, Number(plan.overlap_seconds) || 6);
    const inCue = Math.max(0, Number(plan.in_cue) || 0);
    const preroll = manual ? 0 : Math.min(MAX_PREROLL, inCue / rate);
    const startPosition = Math.max(0, inCue - preroll * rate);
    const outCue = manual ? from.currentTime : Math.max(0, Number(plan.out_cue) || 0);

    setDeckGain(toIndex, 0);
    resetDeckEffects(toIndex);
    resetDeckEffects(fromIndex);
    to.muted = allMuted;
    to.src = url;
    to.load();
    to.playbackRate = rate;
    const cue = () => {
      if (generation !== mixGeneration) return;
      to.currentTime = startPosition;
    };
    if (to.readyState >= 1) cue();
    else to.addEventListener('loadedmetadata', cue, { once: true });
    const onDeckError = () => {
      if (generation !== mixGeneration) return;
      failMix(new Error('incoming deck failed to load'));
    };
    to.addEventListener('error', onDeckError, { once: true });

    mix = {
      phase: 'armed',
      fromIndex,
      toIndex,
      outCue,
      inCue,
      overlap,
      rate,
      preroll,
      mixStart: null,
      technique: plan.technique,
      phaseTolerance: Math.max(
        0.001,
        Math.min(0.012, Number(plan.sync?.phase_tolerance_ms || 5) / 1000),
      ),
      phaseCorrected: false,
      dominant: false,
      manual,
      callbacks,
    };
    callbacks.onArmed?.();
    stopTicker();
    // A manual skip should not wait a whole tick to become audible. Running it
    // before the ticker starts also means the first interval is picked from the
    // phase the skip left behind rather than from `armed`.
    if (manual) tick();
    if (mix) startTicker();
  },
};
