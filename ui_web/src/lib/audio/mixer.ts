import type { RuntimeLifetime } from '../runtimeLifetime';
import { diagnosticLoad, diagnosticPause, diagnosticSource, recordPlaybackDiagnostic } from "../playbackDiagnostics";
import type { DeckEffects, ProgramMixSnapshot, LiveTransitionPlan, MixPhase, MixCancelReason, ProgramTransportOrigin, ProgramTransportEvent, MixCallbacks, ActiveMix } from "./contracts";
export interface MixerPorts {
  decks: () => HTMLAudioElement[];
  mixGains: number[];
  audioContext: AudioContext | null;
  activeIndex: number;
  pageHidden: () => boolean;
  deckIsPlaying: (deck: HTMLAudioElement) => boolean;
  deckGains: GainNode[] | null;
  setBlendLimiter: (active: boolean) => void;
  scheduleCurve: (param: AudioParam | undefined, values: number[], duration: number) => void;
  deckEffects: DeckEffects[] | null;
  ensureEcho: (index: number) => void;
  setDeckGain: (index: number, value: number) => void;
  resetDeckEffects: (index: number) => void;
  releaseDeck: (index: number) => void;
  playProgramDeck: (deck: HTMLAudioElement) => Promise<void>;
  NETWORK_NO_SOURCE: number;
  pauseDeck: (deck: HTMLAudioElement) => void;
  setDeckParticipation: (deck: HTMLAudioElement, participating: boolean) => void;
  stagedUrl: string;
  notifySourcesSettled: () => void;
  outputRecovering: boolean;
  playbackRequested: boolean;
  resumeContext: () => void;
  pendingDetach: Set<HTMLAudioElement>;
  setDeckLevel: (index: number, linear: number, ramp?: boolean) => void;
}

/** Owns the mixer resources of the page's audio service. */
export function createMixer(ports: MixerPorts, lifetime: RuntimeLifetime) {
  const TICK_MS = 40;
  const ARMED_TICK_MS = 250;
  const ARMED_FINE_LEAD = 2;
  const MAX_PREROLL = 4;
  const MIN_OVERLAP = 1.2;
  const MIX_STALL_MS = 4_000;
  const RATE_RETURN_MS = 8_000;
  function programMixSnapshot(): ProgramMixSnapshot {
    const list = ports.decks();
    let progress = 0;
    if (mix?.mixStart != null) {
      const incoming = list[mix.toIndex];
      progress = Math.min(1, Math.max(0, (incoming.currentTime - mix.mixStart) / Math.max(0.001, mix.overlap * mix.rate)));
    }
    const liveGains = mix?.phase === 'crossfading' ? [mix.fromIndex === 0 ? Math.cos(progress * Math.PI * 0.5) : Math.sin(progress * Math.PI * 0.5), mix.fromIndex === 1 ? Math.cos(progress * Math.PI * 0.5) : Math.sin(progress * Math.PI * 0.5)] : ports.mixGains;
    return {
      contextTime: ports.audioContext?.currentTime ?? 0,
      activeIndex: ports.activeIndex,
      phase: mix?.phase ?? 'idle',
      technique: mix?.technique,
      progress,
      dominant: mix?.dominant ?? false,
      decks: list.map((deck, index) => ({
        index,
        position: Number.isFinite(deck.currentTime) ? deck.currentTime : 0,
        duration: Number.isFinite(deck.duration) ? deck.duration : 0,
        gain: liveGains[index]
      }))
    };
  }
  let programTransportReporter: ((event: ProgramTransportEvent) => void) | null = null;
  function setProgramTransportReporter(reporter: ((event: ProgramTransportEvent) => void) | null): void {
    programTransportReporter = reporter;
  }
  function reportProgramTransport(kind: ProgramTransportEvent['kind'], origin: ProgramTransportOrigin, phase: MixPhase, dominant: boolean): void {
    const list = ports.decks();
    programTransportReporter?.({
      kind,
      origin,
      mixPhase: phase,
      dominant,
      activeIndex: ports.activeIndex,
      hidden: ports.pageHidden(),
      deck0Playing: ports.deckIsPlaying(list[0]),
      deck1Playing: ports.deckIsPlaying(list[1])
    });
  }
  let mix: ActiveMix | null = null;
  let mixGeneration = 0;
  let mixTimer: ReturnType<typeof setTimeout> | null = null;
  let rateTimer: ReturnType<typeof setInterval> | null = null;
  function scheduleCrossfade(current: ActiveMix): void {
    if (!ports.deckGains || !ports.audioContext) return;
    ports.setBlendLimiter(true);
    const points = 96;
    const incoming = Array.from({
      length: points
    }, (_, index) => Math.sin(index / (points - 1) * Math.PI * 0.5));
    const outgoing = Array.from({
      length: points
    }, (_, index) => Math.cos(index / (points - 1) * Math.PI * 0.5));
    ports.scheduleCurve(ports.deckGains[current.toIndex].gain, incoming, current.overlap);
    ports.scheduleCurve(ports.deckGains[current.fromIndex].gain, outgoing, current.overlap);
    const outEffect = ports.deckEffects?.[current.fromIndex];
    const inEffect = ports.deckEffects?.[current.toIndex];
    if (current.technique === 'bass_swap' || current.technique === 'long_blend') {
      ports.scheduleCurve(outEffect?.low?.gain, [0, 0, -4, -12, -18, -18], current.overlap);
      ports.scheduleCurve(inEffect?.low?.gain, [-18, -18, -12, -4, 0, 0], current.overlap);
    }
    if (current.technique === 'filter_blend' || current.technique === 'long_blend') {
      ports.scheduleCurve(outEffect?.filter?.frequency, [22000, 18000, 9000, 3500, 1200, 700], current.overlap);
      ports.scheduleCurve(inEffect?.filter?.frequency, [900, 1600, 4200, 10000, 18000, 22000], current.overlap);
    }
    if (current.technique === 'echo_cut') {
      ports.ensureEcho(current.fromIndex);
      ports.scheduleCurve(outEffect?.echoWet?.gain, [0, 0.05, 0.12, 0.24, 0.32, 0.18], current.overlap);
    }
  }
  function tickInterval(): number {
    const current = mix;
    if (!current || current.phase !== 'armed') return TICK_MS;
    const from = ports.decks()[current.fromIndex];
    const runway = current.outCue - current.preroll - (from.currentTime || 0);
    return runway > ARMED_FINE_LEAD ? ARMED_TICK_MS : TICK_MS;
  }
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
      mixTimer = lifetime.setTimeout(run, tickInterval());
    };
    mixTimer = lifetime.setTimeout(run, tickInterval());
  }
  function stopTicker(): void {
    tickerToken += 1;
    if (mixTimer) lifetime.clearTimeout(mixTimer);
    mixTimer = null;
  }
  function stopRateReturn(): void {
    if (rateTimer) lifetime.clearInterval(rateTimer);
    rateTimer = null;
  }
  function scheduleRateReturn(index: number): void {
    stopRateReturn();
    const deck = ports.decks()[index];
    const from = deck.playbackRate;
    if (Math.abs(from - 1) < 0.001) {
      deck.playbackRate = 1;
      return;
    }
    const startedAt = Date.now();
    rateTimer = lifetime.setInterval(() => {
      if (ports.decks()[ports.activeIndex] !== deck) {
        stopRateReturn();
        return;
      }
      const progress = Math.min(1, (Date.now() - startedAt) / RATE_RETURN_MS);
      deck.playbackRate = from + (1 - from) * progress;
      if (progress >= 1) stopRateReturn();
    }, 200);
  }
  function cancelMix(reason: MixCancelReason): void {
    const current = mix;
    mixGeneration += 1;
    stopTicker();
    mix = null;
    ports.setBlendLimiter(false);
    if (!current) return;
    const keep = current.dominant ? current.toIndex : current.fromIndex;
    const drop = 1 - keep;
    ports.activeIndex = keep;
    ports.setDeckGain(keep, 1);
    ports.setDeckGain(drop, 0);
    ports.resetDeckEffects(keep);
    ports.resetDeckEffects(drop);
    ports.releaseDeck(drop);
    if (current.dominant) scheduleRateReturn(keep);
    current.callbacks.onCancel(reason);
  }
  function finishMix(): void {
    const current = mix;
    if (!current) return;
    const incoming = ports.decks()[current.toIndex];
    stopTicker();
    mix = null;
    ports.setBlendLimiter(false);
    ports.setDeckGain(current.toIndex, 1);
    ports.setDeckGain(current.fromIndex, 0);
    ports.resetDeckEffects(current.toIndex);
    ports.resetDeckEffects(current.fromIndex);
    if (!current.dominant) {
      ports.activeIndex = current.toIndex;
      current.callbacks.onDominant();
    }
    recordPlaybackDiagnostic('handoff.retirement', {
      from: current.fromIndex,
      to: current.toIndex
    });
    ports.releaseDeck(current.fromIndex);
    scheduleRateReturn(current.toIndex);
    current.callbacks.onComplete(incoming.currentTime);
  }
  function failMix(error: unknown): void {
    const current = mix;
    if (!current) return;
    mixGeneration += 1;
    stopTicker();
    mix = null;
    ports.setBlendLimiter(false);
    const keep = current.dominant ? current.toIndex : current.fromIndex;
    ports.activeIndex = keep;
    ports.setDeckGain(keep, 1);
    ports.setDeckGain(1 - keep, 0);
    ports.resetDeckEffects(keep);
    ports.resetDeckEffects(1 - keep);
    ports.releaseDeck(1 - keep);
    current.callbacks.onError(error);
  }
  function cutOver(current: ActiveMix): void {
    ports.setDeckGain(current.fromIndex, 0);
    ports.setDeckGain(current.toIndex, 1);
    void ports.playProgramDeck(ports.decks()[current.toIndex]).then(lifetime.guard(() => {
      if (mix === current) finishMix();
    }), lifetime.guard(error => {
      if (mix === current) failMix(error);
    }));
  }
  function deckIsDead(deck: HTMLAudioElement): boolean {
    return Boolean(deck.error) || deck.ended || deck.networkState === ports.NETWORK_NO_SOURCE;
  }
  function observeIncoming(current: ActiveMix, to: HTMLAudioElement): void {
    const position = Number.isFinite(to.currentTime) ? to.currentTime : 0;
    if (!to.paused && !to.seeking && position > current.inPosition + 0.01) {
      current.inAdvanced = true;
      current.inProgressAt = Date.now();
    }
    current.inPosition = position;
  }
  function incomingSounding(current: ActiveMix, to: HTMLAudioElement): boolean {
    return current.phase !== 'armed' && current.inAdvanced && !to.paused && !to.seeking && to.readyState >= 3;
  }
  function releaseToStaged(current: ActiveMix): void {
    mixGeneration += 1;
    stopTicker();
    mix = null;
    ports.setBlendLimiter(false);
    const to = ports.decks()[current.toIndex];
    ports.setDeckGain(current.fromIndex, 1);
    ports.setDeckGain(current.toIndex, 0);
    ports.resetDeckEffects(current.fromIndex);
    ports.resetDeckEffects(current.toIndex);
    if (!to.paused) ports.pauseDeck(to);
    ports.setDeckParticipation(to, false);
    to.playbackRate = 1;
    if (to.readyState >= 1) to.currentTime = 0;
    ports.stagedUrl = current.url;
    current.callbacks.onStaged?.();
    ports.notifySourcesSettled();
  }
  function settleOutgoingEnd(current: ActiveMix): 'consumed' | 'forward' {
    const to = ports.decks()[current.toIndex];
    observeIncoming(current, to);
    if (deckIsDead(to)) {
      failMix(new Error('incoming deck could not play at the boundary'));
      return 'consumed';
    }
    if (incomingSounding(current, to)) {
      finishMix();
      return 'consumed';
    }
    releaseToStaged(current);
    return 'forward';
  }
  function settleEndedDeck(deck: HTMLAudioElement): 'consumed' | 'forward' {
    const current = mix;
    if (!current) return 'forward';
    const from = ports.decks()[current.fromIndex];
    const to = ports.decks()[current.toIndex];
    if (deck === to) {
      // Before the handoff the incoming song is nobody's track yet, and a song
      // that "ends" seconds in is a broken stream: stay on the outgoing one.
      if (!current.dominant) {
        failMix(new Error('incoming deck ended before the handoff'));
        return 'consumed';
      }
      finishMix();
      return 'forward';
    }
    if (deck !== from) return 'forward';
    if (current.dominant) {
      finishMix();
      return 'consumed';
    }
    return settleOutgoingEnd(current);
  }
  const endedOutcomes = new WeakMap<Event, 'consumed' | 'forward'>();
  function settleEndedEvent(event: Event): 'consumed' | 'forward' {
    const known = endedOutcomes.get(event);
    if (known) return known;
    const deck = event.currentTarget as HTMLAudioElement | null;
    const outcome = deck ? settleEndedDeck(deck) : 'forward';
    endedOutcomes.set(event, outcome);
    return outcome;
  }
  function tick(): void {
    if (ports.outputRecovering || !ports.playbackRequested) return;
    const current = mix;
    if (!current) {
      stopTicker();
      return;
    }
    const from = ports.decks()[current.fromIndex];
    const to = ports.decks()[current.toIndex];

    // The end of the outgoing song is settled by its own `ended` event, which
    // also tells the store what happened. Settling it here, from whichever clock
    // noticed first, is how the store used to hear about the boundary twice — or
    // never.
    if (from.ended && !current.dominant) return;
    if (from.ended) {
      finishMix();
      return;
    }
    if (current.phase !== 'armed' && deckIsDead(to)) {
      if (current.dominant) finishMix();else failMix(new Error('incoming deck stopped during the handoff'));
      return;
    }
    observeIncoming(current, to);
    if (current.phase === 'armed') {
      if (from.paused) return;
      const due = from.currentTime >= current.outCue - current.preroll;
      if (!due) return;
      // A whole song ends on its own `ended`, which hands the next one over the
      // ordinary way. Cutting from a clock that merely reached the duration
      // first would start the next song only to restart it a moment later.
      if (current.technique === 'direct' && !current.manual) return;
      current.phase = 'prerolling';
      // Started silent even when it has not buffered yet. Safari keeps a cued
      // second element at metadata until somebody plays it, so waiting for it to
      // be ready first could wait for ever. Nothing fades until it is sounding:
      // the blend below waits for its clock to meet the cue.
      current.inProgressAt = Date.now();
      if (current.technique === 'direct') {
        cutOver(current);
        return;
      }
      void ports.playProgramDeck(to).catch(lifetime.guard(error => {
        if (mix === current) failMix(error);
      }));
      // A requested skip has no head start to wait out: fall straight through.
      if (!current.manual) return;
    }
    // A cut has nothing to supervise between starting the next song and handing
    // over to it: `cutOver` finishes it the moment that song is playing.
    if (current.technique === 'direct') return;

    // A pause anywhere holds the blend where it is; the gains stay put because
    // the incoming media clock is what drives them.
    if (to.paused || from.paused) return;
    if (current.phase === 'prerolling') {
      const outRemaining = current.outCue - from.currentTime;
      const inRemaining = (current.inCue - to.currentTime) / current.rate;
      const phaseError = inRemaining - outRemaining;
      if (!current.manual && !current.phaseCorrected && outRemaining > 0.15 && Math.abs(phaseError) > current.phaseTolerance) {
        // The incoming deck is silent. Correcting its playhead here prevents a
        // flam instead of trying to hide one after both tracks are audible.
        to.currentTime = Math.max(0, current.inCue - outRemaining * current.rate);
        current.inPosition = to.currentTime;
        current.phaseCorrected = true;
        return;
      }
      const due = current.manual || outRemaining <= current.phaseTolerance && inRemaining <= current.phaseTolerance;
      if (!due) return;
      if (!current.manual) {
        const target = current.inCue + Math.max(0, from.currentTime - current.outCue) * current.rate;
        if (Math.abs(to.currentTime - target) > current.phaseTolerance * current.rate) {
          to.currentTime = Math.max(0, target);
          current.inPosition = to.currentTime;
        }
      }
      current.mixStart = to.currentTime;
      current.phase = 'crossfading';
      current.inProgressAt = Date.now();
      scheduleCrossfade(current);
    }

    // The outgoing curve runs on the audio clock whatever the incoming deck is
    // doing. One whose clock has stopped is a fade into silence: hand over to it
    // if it already owns the programme (its own stall recovery takes it from
    // there), otherwise give the blend up and stay on the song that is sounding.
    if (Date.now() - current.inProgressAt > MIX_STALL_MS) {
      if (current.dominant) finishMix();else failMix(new Error('incoming deck stalled during the blend'));
      return;
    }
    const span = Math.max(0.05, current.overlap * current.rate);
    const elapsed = to.currentTime - (current.mixStart ?? to.currentTime);
    const progress = Math.min(1, Math.max(0, elapsed / span));
    // Equal-power curves keep the perceived loudness steadier than linear gain,
    // especially on long blends.
    if (!ports.deckGains || !ports.audioContext) {
      ports.setDeckGain(current.toIndex, Math.sin(progress * Math.PI * 0.5));
      ports.setDeckGain(current.fromIndex, Math.cos(progress * Math.PI * 0.5));
    }
    if (!current.dominant && (current.manual || progress >= 0.5)) {
      current.dominant = true;
      ports.activeIndex = current.toIndex;
      current.callbacks.onDominant();
    }
    if (progress >= 1) finishMix();
  }
  const actions = {
    programMixSnapshot,
    mixPhase(): MixPhase {
      return mix?.phase ?? 'idle';
    },
    mixIsDominant(): boolean {
      return mix?.dominant ?? false;
    },
    cancelMix,
    startMixNow(overlapSeconds = 1.6): 'finished' | 'blend' | 'staged' | 'failed' | false {
      const current = mix;
      if (!current) return false;
      if (current.phase === 'crossfading') {
        finishMix();
        return 'finished';
      }
      const to = ports.decks()[current.toIndex];
      if (deckIsDead(to)) {
        failMix(new Error('incoming deck could not play'));
        return 'failed';
      }
      if (to.readyState < 3) {
        releaseToStaged(current);
        return 'staged';
      }
      current.manual = true;
      current.preroll = 0;
      current.overlap = Math.max(MIN_OVERLAP, overlapSeconds);
      current.outCue = ports.decks()[current.fromIndex].currentTime;
      tick();
      return 'blend';
    },
    armTransition(url: string, plan: LiveTransitionPlan, callbacks: MixCallbacks, options: {
      manual?: boolean;
      level: number;
    }): void {
      cancelMix('superseded');
      const generation = ++mixGeneration;
      // No graph is built here. Routing an element into an AudioContext is
      // irreversible, and this runs from the mixer's ticker — a timer is the one
      // place it must never happen. `unlockAudio` owns that, from a gesture.
      // Deliberately not awaited: the mix has to be armed before this function
      // returns, or the caller's own "is a handoff prepared?" check races it.
      ports.resumeContext();
      ports.stagedUrl = '';
      const fromIndex = ports.activeIndex;
      const toIndex = 1 - ports.activeIndex;
      const from = ports.decks()[fromIndex];
      const to = ports.decks()[toIndex];
      ports.pendingDetach.delete(to);
      const manual = options.manual === true;
      const rate = Math.min(1.06, Math.max(0.94, Number(plan.playback_rate) || 1));
      const overlap = manual ? Math.max(MIN_OVERLAP, Math.min(1.8, Number(plan.overlap_seconds) || 4)) : Math.max(MIN_OVERLAP, Number(plan.overlap_seconds) || 6);
      const inCue = Math.max(0, Number(plan.in_cue) || 0);
      const preroll = manual ? 0 : Math.min(MAX_PREROLL, inCue / rate);
      const startPosition = Math.max(0, inCue - preroll * rate);
      const outCue = manual ? from.currentTime : Math.max(0, Number(plan.out_cue) || 0);
      ports.setDeckGain(toIndex, 0);
      // The incoming deck gets its own level; the outgoing one keeps its own,
      // because it is still playing its own track. Set before `src` and before
      // the manual `tick()` below, which can reach `crossfading` inside this call.
      ports.setDeckLevel(toIndex, options.level);
      ports.resetDeckEffects(toIndex);
      ports.resetDeckEffects(fromIndex);
      ports.setDeckParticipation(to, false);
      if (!to.paused) diagnosticPause(to);
      diagnosticSource(to, () => {
        to.src = url;
      });
      diagnosticLoad(to);
      to.playbackRate = rate;
      const cue = () => {
        if (generation !== mixGeneration) return;
        to.currentTime = startPosition;
      };
      if (to.readyState >= 1) cue();else lifetime.listen(to, 'loadedmetadata', cue, {
        once: true
      });
      const onDeckError = () => {
        if (generation !== mixGeneration) return;
        failMix(new Error('incoming deck failed to load'));
      };
      lifetime.listen(to, 'error', onDeckError, {
        once: true
      });
      mix = {
        phase: 'armed',
        fromIndex,
        toIndex,
        url,
        inPosition: startPosition,
        inProgressAt: Date.now(),
        inAdvanced: false,
        outCue,
        inCue,
        overlap,
        rate,
        preroll,
        mixStart: null,
        technique: plan.technique,
        phaseTolerance: Math.max(0.001, Math.min(0.012, Number(plan.sync?.phase_tolerance_ms || 5) / 1000)),
        phaseCorrected: false,
        dominant: false,
        manual,
        callbacks
      };
      callbacks.onArmed?.();
      ports.notifySourcesSettled();
      stopTicker();
      // A manual skip should not wait a whole tick to become audible. Running it
      // before the ticker starts also means the first interval is picked from the
      // phase the skip left behind rather than from `armed`.
      if (manual) tick();
      if (mix) startTicker();
    }
  };
  return {
    dispose() {
      stopTicker();
      stopRateReturn();
      mix = null;
    },
    actions,
    settleEndedEvent,
    get mix() {
      return mix;
    },
    set mix(value: ActiveMix | null) {
      mix = value;
    },
    cancelMix,
    tick,
    reportProgramTransport,
    stopRateReturn,
    programMixSnapshot,
    setProgramTransportReporter
  };
}
