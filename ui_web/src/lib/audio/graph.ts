import type { RuntimeLifetime } from '../runtimeLifetime';
import { MAX_LINEAR as MAX_LEVEL, MIN_LINEAR as MIN_LEVEL } from "../loudness";
import { recordPlaybackDiagnostic } from "../playbackDiagnostics";
import { ProgramOutput, type ProgramOutputEvent } from "./programOutput";
import { storedVolume } from "../audioPreferences";
import type { DeckEffects, GraphState, BroadcastCapture } from "./contracts";
export interface GraphPorts {
  elements: HTMLAudioElement[] | null;
  applyDeckMute: (deck: HTMLAudioElement) => void;
  pendingSeeks: WeakMap<HTMLAudioElement, {
    settled: boolean;
  }>;
  decks: () => HTMLAudioElement[];
  configurePlaybackSession: () => void;
  reconcilePlatformPlayback: () => void;
  playbackRequested: boolean;
  unlockDecks: () => void;
  deckIsPlaying: (deck: HTMLAudioElement) => boolean;
  audioEl: () => HTMLAudioElement;
  outputRecovering: boolean;
  resetClockSample: () => void;
  broadcastCapture: BroadcastCapture | null;
  releaseBroadcastCapture: () => void;
  broadcastLostReporter: (() => void) | null;
  VOLUME_KEY: string;
  activeIndex: number;
}

/** Owns the graph resources of the page's audio service. */
export function createGraph(ports: GraphPorts, lifetime: RuntimeLifetime) {
  const mixGains = [1, 0];
  const levelGains = [1, 1];
  let levelNodes: GainNode[] | null = null;
  let levelingEnabled = true;
  const LEVEL_RAMP_SEC = 0.15;
  let audioContext: AudioContext | null = null;
  let deckGains: GainNode[] | null = null;
  let deckEffects: DeckEffects[] | null = null;
  let masterGain: GainNode | null = null;
  let monitorGain: GainNode | null = null;
  let programCarrier: ProgramOutput | null = null;
  let programOutputReporter: ((event: ProgramOutputEvent) => void) | null = null;
  let masterVolume = storedVolume();
  let allMuted = false;
  let limiter: DynamicsCompressorNode | null = null;
  let programOutput: AudioNode | null = null;
  let graphState: GraphState = 'untested';
  function setProgramOutputReporter(fn: ((event: ProgramOutputEvent) => void) | null): void {
    programOutputReporter = fn;
  }
  function applyDeckVolume(): void {
    if (!ports.elements) return;
    if (monitorGain && audioContext) {
      monitorGain.gain.value = allMuted ? 0 : masterVolume;
      for (const deck of ports.elements) {
        deck.volume = 1;
        ports.applyDeckMute(deck);
      }
      return;
    }
    ports.elements.forEach((deck, index) => {
      deck.volume = Math.min(1, Math.max(0, mixGains[index] * masterVolume * fallbackLevel(index)));
      ports.applyDeckMute(deck);
    });
  }
  function appliedLevel(index: number): number {
    return levelingEnabled ? levelGains[index] : 1;
  }
  function fallbackLevel(index: number): number {
    return Math.min(1, appliedLevel(index));
  }
  function setDeckGain(index: number, value: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    mixGains[index] = clamped;
    if (deckGains && audioContext) {
      const param = deckGains[index].gain;
      const now = audioContext.currentTime;
      param.cancelScheduledValues(now);
      param.setValueAtTime(ports.pendingSeeks.has(ports.decks()[index]) ? 0 : clamped, now);
      return;
    }
    const deck = ports.decks()[index];
    deck.volume = Math.min(1, Math.max(0, clamped * masterVolume * fallbackLevel(index)));
  }
  function setDeckLevel(index: number, linear: number, ramp = false): void {
    const safe = Number.isFinite(linear) ? Math.min(Math.max(linear, MIN_LEVEL), MAX_LEVEL) : 1;
    levelGains[index] = safe;
    const node = levelNodes?.[index];
    if (node && audioContext) {
      const target = appliedLevel(index);
      const now = audioContext.currentTime;
      const param = node.gain;
      param.cancelScheduledValues(now);
      if (ramp && typeof param.linearRampToValueAtTime === 'function') {
        // Never a step: this is the one path that can run while a deck is
        // already sounding, when the listener toggles the setting mid-track.
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(target, now + LEVEL_RAMP_SEC);
      } else {
        param.setValueAtTime(target, now);
      }
      return;
    }
    applyDeckVolume();
  }
  function unlockAudio(): boolean {
    ports.configurePlaybackSession();
    if (graphState !== 'untested') {
      ports.reconcilePlatformPlayback();
      if (!ports.playbackRequested) return graphState === 'ready';
      ports.unlockDecks();
      if (graphState === 'ready') {
        void programCarrier?.retryFromGesture(ports.deckIsPlaying(ports.audioEl()));
      }
      return graphState === 'ready';
    }
    const Context = globalThis.AudioContext ?? (globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!Context) {
      graphState = 'unavailable';
      ports.unlockDecks();
      return false;
    }
    try {
      const list = ports.decks();
      const context = new Context();
      void context.resume?.().catch(() => {});
      primeAudioSession(context);
      const master = context.createGain();
      master.gain.value = 1;
      const monitor = context.createGain();
      monitor.gain.value = allMuted ? 0 : masterVolume;
      // Reach the speakers before anything is routed in: a graph that throws
      // halfway would otherwise leave a deck connected to nothing audible.
      if (typeof context.createDynamicsCompressor === 'function') {
        const peak = context.createDynamicsCompressor();
        // Idle threshold is 0 dBFS — nothing below full scale is touched, so
        // ordinary playback sounds exactly as it does with no graph at all. Only
        // a blend, where two tracks sum, pulls it down to catch the overshoot.
        peak.threshold.value = 0;
        peak.knee.value = 8;
        peak.ratio.value = 6;
        peak.attack.value = 0.003;
        peak.release.value = 0.18;
        master.connect(peak);
        peak.connect(monitor);
        limiter = peak;
        programOutput = peak;
      } else {
        master.connect(monitor);
        programOutput = master;
      }
      const effects: DeckEffects[] = [];
      const levels: GainNode[] = [];
      const gains = list.map((deck, index) => {
        const gain = context.createGain();
        gain.gain.value = mixGains[index];
        // Volume levelling sits upstream of `master`, so it reaches the broadcast
        // tap as well as the speakers — a Live listener hears the same levelled
        // programme the broadcaster does. Seeded from the shadow so a level set
        // before the first gesture survives into the graph.
        const level = context.createGain();
        level.gain.value = appliedLevel(index);
        levels.push(level);
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
          source.connect(low).connect(filter).connect(level).connect(gain).connect(master);
          // No echo send here: see `ensureEcho`.
          effects.push({
            low,
            filter,
            source,
            level
          });
        } else {
          source.connect(level).connect(gain).connect(master);
          effects.push({
            source,
            level
          });
        }
        return gain;
      });
      for (const deck of list) deck.volume = 1;
      audioContext = context;
      deckGains = gains;
      levelNodes = levels;
      deckEffects = effects;
      masterGain = master;
      monitorGain = monitor;
      programCarrier = new ProgramOutput(context, monitor);
      programCarrier.subscribe(event => programOutputReporter?.(event));
      programCarrier.initialize();
      graphState = 'ready';
      watchContextState(context);
      // Routed and never played: now the sample can be spent, still inside the
      // gesture that owes the decks their playback permission.
      ports.unlockDecks();
      return true;
    } catch {
      discardGraph();
      graphState = 'unavailable';
      applyDeckVolume();
      ports.unlockDecks();
      return false;
    }
  }
  function primeAudioSession(context: AudioContext): void {
    if (typeof context.createBuffer !== 'function' || typeof context.createBufferSource !== 'function') return;
    try {
      const buffer = context.createBuffer(1, 1, context.sampleRate || 44100);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.start(0);
    } catch {
      /* a context that refuses a one-sample buffer is caught by the probe */
    }
  }
  const pendingContextResumes = new WeakMap<AudioContext, object>();
  function resumeContext(): void {
    const context = audioContext;
    if (!ports.playbackRequested || ports.outputRecovering || !context || context.state === 'running' || context.state === 'closed' || pendingContextResumes.has(context)) return;
    const request = {};
    pendingContextResumes.set(context, request);
    const finish = () => {
      if (pendingContextResumes.get(context) === request) pendingContextResumes.delete(context);
    };
    const deadline = lifetime.setTimeout(() => {
      recordPlaybackDiagnostic('context.resume_result', {
        state: context.state,
        error: 'resume_timeout'
      });
      finish(); // A later Play may retry; this timeout never retries by itself.
    }, 5000);
    recordPlaybackDiagnostic('context.resume_request', {
      state: context.state
    });
    // Keep the native request in the activation turn. Statechange can fire before
    // its promise resolves; the guard prevents recursive requests.
    try {
      void context.resume().then(lifetime.guard(() => {
        recordPlaybackDiagnostic('context.resume_result', {
          state: context.state
        });
      }), lifetime.guard(() => {
        recordPlaybackDiagnostic('context.resume_result', {
          state: context.state,
          error: 'resume_failed'
        });
      })).finally(lifetime.guard(() => {
        lifetime.clearTimeout(deadline);
        finish();
      }));
    } catch {
      lifetime.clearTimeout(deadline);
      finish();
      recordPlaybackDiagnostic('context.resume_result', {
        error: 'resume_failed'
      });
    }
  }
  function watchContextState(context: AudioContext): void {
    if (typeof context.addEventListener !== 'function') return;
    lifetime.listen(context, 'statechange', () => {
      recordPlaybackDiagnostic('context.statechange', {
        state: context.state
      });
      if (audioContext !== context || graphState !== 'ready') return;
      ports.resetClockSample();
      // Locking iOS can interrupt Web Audio before visibility changes. This is
      // not a transport Pause. A real pause independently revokes permission.
      resumeContext();
    });
  }
  function discardGraph(): void {
    const context = audioContext;
    const lostBroadcast = ports.broadcastCapture?.kind === 'program';
    ports.releaseBroadcastCapture();
    programCarrier?.destroy();
    programCarrier = null;
    audioContext = null;
    deckGains = null;
    // The nodes go; `levelGains` stays, so the levels survive into whatever
    // replaces the graph.
    levelNodes = null;
    deckEffects = null;
    masterGain = null;
    monitorGain = null;
    limiter = null;
    programOutput = null;
    if (context && typeof context.close === 'function') void context.close().catch(lifetime.guard(() => {}));
    if (lostBroadcast) ports.broadcastLostReporter?.();
  }
  function graphReady(): boolean {
    return graphState === 'ready' && Boolean(audioContext && deckGains && masterGain && monitorGain);
  }
  function setBlendLimiter(active: boolean): void {
    if (!limiter || !audioContext) return;
    const now = audioContext.currentTime;
    const target = active ? -6 : 0;
    const param = limiter.threshold;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    if (typeof param.linearRampToValueAtTime === 'function') {
      param.linearRampToValueAtTime(target, now + 0.25);
    } else {
      param.value = target;
    }
  }
  function ensureEcho(index: number): void {
    const effect = deckEffects?.[index];
    if (!effect || effect.echoWet || !audioContext || !masterGain) return;
    // Tapped after levelling, not at the raw element: an echo tail returns
    // straight into `masterGain`, so tapping `source` would put an un-levelled
    // copy of the track under a levelled programme.
    const source = effect.level ?? effect.source;
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
    const params = [effect.low?.gain, effect.filter?.frequency, effect.echoWet?.gain, effect.echoFeedback?.gain];
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
  const actions = {
    setVolume(v: number): void {
      const clamped = Math.min(1, Math.max(0, v));
      masterVolume = clamped;
      if (monitorGain) monitorGain.gain.value = allMuted ? 0 : clamped;else applyDeckVolume();
      recordPlaybackDiagnostic('volume.local_applied');
      try {
        localStorage.setItem(ports.VOLUME_KEY, String(clamped));
      } catch {
        /* private mode / storage disabled */
      }
    },
    getVolume(): number {
      return masterVolume;
    },
    setMuted(muted: boolean): void {
      allMuted = muted;
      applyDeckVolume();
      recordPlaybackDiagnostic('volume.local_mute_applied');
    },
    setLevels(activeLevel: number, idleLevel: number): void {
      setDeckLevel(ports.activeIndex, activeLevel, true);
      setDeckLevel(1 - ports.activeIndex, idleLevel, true);
    },
    setLevelingEnabled(enabled: boolean): void {
      if (levelingEnabled === enabled) return;
      levelingEnabled = enabled;
      // Re-assert both decks so the change is heard now, ramped rather than
      // stepped. The desired levels are untouched, so switching back on restores
      // what each deck was already meant to be at.
      setDeckLevel(ports.activeIndex, levelGains[ports.activeIndex], true);
      setDeckLevel(1 - ports.activeIndex, levelGains[1 - ports.activeIndex], true);
    },
    levelingEnabled(): boolean {
      return levelingEnabled;
    },
    unlockAudio,
    graphReady
  };
  return {
    dispose() {
      discardGraph();
    },
    actions,
    setDeckGain,
    get mixGains() {
      return mixGains;
    },
    get monitorGain() {
      return monitorGain;
    },
    set monitorGain(value: GainNode | null) {
      monitorGain = value;
    },
    get audioContext() {
      return audioContext;
    },
    set audioContext(value: AudioContext | null) {
      audioContext = value;
    },
    get allMuted() {
      return allMuted;
    },
    set allMuted(value: boolean) {
      allMuted = value;
    },
    applyDeckVolume,
    setDeckLevel,
    graphReady,
    get programCarrier() {
      return programCarrier;
    },
    set programCarrier(value: ProgramOutput | null) {
      programCarrier = value;
    },
    primeAudioSession,
    resumeContext,
    get programOutput() {
      return programOutput;
    },
    set programOutput(value: AudioNode | null) {
      programOutput = value;
    },
    get deckGains() {
      return deckGains;
    },
    set deckGains(value: GainNode[] | null) {
      deckGains = value;
    },
    setBlendLimiter,
    scheduleCurve,
    get deckEffects() {
      return deckEffects;
    },
    set deckEffects(value: DeckEffects[] | null) {
      deckEffects = value;
    },
    ensureEcho,
    resetDeckEffects,
    get masterVolume() {
      return masterVolume;
    },
    set masterVolume(value: number) {
      masterVolume = value;
    },
    setProgramOutputReporter,
    unlockAudio
  };
}
