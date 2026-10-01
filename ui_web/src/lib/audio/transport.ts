import type { RuntimeLifetime } from '../runtimeLifetime';
import { diagnosticLoad, diagnosticPause, diagnosticPlay, diagnosticSource, observeDiagnosticMedia, recordPlaybackDiagnostic } from "../playbackDiagnostics";
import { ProgramOutput } from "./programOutput";
import type { AudioService, DeckBinding, ProgramMediaEventName, ProgramPlaybackSnapshot, OutputHealth, MixPhase, MixCancelReason, ProgramTransportOrigin, ProgramTransportEvent, ActiveMix } from "./contracts";
export interface TransportPorts {
  setDeckGain: (index: number, value: number) => void;
  mixGains: number[];
  monitorGain: GainNode | null;
  audioContext: AudioContext | null;
  allMuted: boolean;
  applyDeckVolume: () => void;
  settleEndedEvent: (event: Event) => 'consumed' | 'forward';
  setDeckLevel: (index: number, linear: number, ramp?: boolean) => void;
  graphReady: () => boolean;
  audioService: Pick<AudioService, 'pause'>;
  mix: ActiveMix | null;
  cancelMix: (reason: MixCancelReason) => void;
  programCarrier: ProgramOutput | null;
  primeAudioSession: (context: AudioContext) => void;
  resumeContext: () => void;
  tick: () => void;
  reportProgramTransport: (kind: ProgramTransportEvent['kind'], origin: ProgramTransportOrigin, phase: MixPhase, dominant: boolean) => void;
  stopRateReturn: () => void;
}

/** Owns the transport resources of the page's audio service. */
export function createTransport(ports: TransportPorts, lifetime: RuntimeLifetime) {
  const VOLUME_KEY = 'volume';
  const NETWORK_NO_SOURCE = 3;
  const RECOVERY_METADATA_TIMEOUT_MS = 12_000;
  function pageHidden(): boolean {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }
  let elements: HTMLAudioElement[] | null = null;
  let activeIndex = 0;
  let playbackRequested = false;
  let seekGeneration = 0;
  const expectedPauses = new WeakSet<HTMLAudioElement>();
  const pendingStarts = new WeakMap<HTMLAudioElement, object>();
  const pendingSeeks = new WeakMap<HTMLAudioElement, {
    settled: boolean;
  }>();
  function applySeekGate(deck: HTMLAudioElement): void {
    const index = elements?.indexOf(deck) ?? -1;
    if (index >= 0) ports.setDeckGain(index, ports.mixGains[index]);
    applyDeckMute(deck);
  }
  function clearSeekGate(deck: HTMLAudioElement): void {
    if (!pendingSeeks.delete(deck)) return;
    applySeekGate(deck);
  }
  function finishSeek(deck: HTMLAudioElement): void {
    const pending = pendingSeeks.get(deck);
    // canplay can precede seeked, or a queued event can belong to a previous
    // tap. Neither permits the old position to reach the programme output.
    if (!pending?.settled || deck.seeking || deck.readyState < 3) return;
    clearSeekGate(deck);
  }
  function pauseDeck(deck: HTMLAudioElement): void {
    pendingStarts.delete(deck);
    if (!deck.paused) expectedPauses.add(deck);
    diagnosticPause(deck);
  }
  const participatingDecks = new WeakSet<HTMLAudioElement>();
  let sourcesSettledPending = false;
  function applyDeckMute(deck: HTMLAudioElement): void {
    deck.muted = !participatingDecks.has(deck) || !(ports.monitorGain && ports.audioContext) && (ports.allMuted || pendingSeeks.has(deck));
  }
  function setDeckParticipation(deck: HTMLAudioElement, participating: boolean): void {
    if (participating) participatingDecks.add(deck);else participatingDecks.delete(deck);
    applyDeckMute(deck);
  }
  function notifySourcesSettled(): void {
    if (sourcesSettledPending) return;
    sourcesSettledPending = true;
    queueMicrotask(() => {
      sourcesSettledPending = false;
      audioEl().dispatchEvent(new Event('sourcesettled'));
    });
  }
  const deckBindings: DeckBinding[] = [];
  function onDeckEvent(type: string, handler: (event: Event) => void): () => void {
    const guarded = lifetime.guard(handler);
    const binding = {
      type,
      handler: guarded
    };
    deckBindings.push(binding);
    if (elements) for (const deck of elements) deck.addEventListener(type, guarded);
    const unsubscribe = () => {
      const index = deckBindings.indexOf(binding);
      if (index < 0) return;
      deckBindings.splice(index, 1);
      if (elements) for (const deck of elements) deck.removeEventListener(type, guarded);
    };
    lifetime.own(unsubscribe);
    return unsubscribe;
  }
  function createDeck(index: number): HTMLAudioElement {
    const deck = new Audio();
    deck.muted = true;
    lifetime.own(observeDiagnosticMedia(deck, 'deck', index));
    deck.preload = 'auto';
    if ('preservesPitch' in deck) deck.preservesPitch = true;
    lifetime.listen(deck, 'seeked', () => {
      const pending = pendingSeeks.get(deck);
      if (pending && !deck.seeking) pending.settled = true;
      finishSeek(deck);
    });
    lifetime.listen(deck, 'canplay', () => finishSeek(deck));
    lifetime.listen(deck, 'error', () => clearSeekGate(deck));
    lifetime.listen(deck, 'emptied', () => clearSeekGate(deck));
    for (const binding of deckBindings) deck.addEventListener(binding.type, binding.handler);
    return deck;
  }
  function decks(): HTMLAudioElement[] {
    if (!elements) {
      elements = [createDeck(0), createDeck(1)];
      ports.applyDeckVolume();
      bindLifecycle();
    }
    return elements;
  }
  function audioEl(): HTMLAudioElement {
    return decks()[activeIndex];
  }
  function isActiveDeck(target: EventTarget | null): boolean {
    return target === decks()[activeIndex];
  }
  function onProgramEvent(type: ProgramMediaEventName, handler: (snapshot: ProgramPlaybackSnapshot, event: Event) => void): () => void {
    return onDeckEvent(type, event => {
      // A deck ending inside a mix is the mixer's to resolve, whichever listener
      // hears it first. What it resolved by itself never reaches the store as a
      // second track boundary.
      if (type === 'ended' && ports.settleEndedEvent(event) === 'consumed') return;
      if (!isActiveDeck(event.currentTarget)) return;
      if (type === 'pause' && (outputRecovering || !audioEl().paused)) return;
      if ((type === 'play' || type === 'playing') && (!playbackRequested || outputRecovering) && !holdsUnlockSample(audioEl())) {
        if (!audioEl().paused) recordPlaybackDiagnostic('transport.rejected_native_play');
        pauseDeck(audioEl());
        return;
      }
      handler(programPlaybackSnapshot(), event);
    });
  }
  function releaseDeck(index: number): void {
    recordPlaybackDiagnostic('deck.release', {
      index
    });
    detach(decks()[index]);
    ports.setDeckLevel(index, 1);
    notifySourcesSettled();
  }
  function configurePlaybackSession(): void {
    const session = (navigator as Navigator & {
      audioSession?: {
        type: string;
      };
    }).audioSession;
    if (!session) return;
    try {
      if (session.type !== 'playback') session.type = 'playback';
    } catch {
      recordPlaybackDiagnostic('audio_session.configuration', {
        state: 'unsupported'
      });
    }
  }
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
  const unlockedDecks = new WeakSet<HTMLAudioElement>();
  function holdsUnlockSample(deck: HTMLAudioElement): boolean {
    return (deck.currentSrc || deck.getAttribute('src') || '') === SILENT_WAV;
  }
  function unlockDecks(): void {
    for (const deck of decks()) {
      // Once per element, and never over a deck that is holding a track: this is
      // called from every gesture, including typing in a search field. A deck only
      // counts as unlocked once a play actually succeeded, so a call that was not
      // really a gesture leaves it to be retried by the next one.
      if (unlockedDecks.has(deck)) continue;
      if (deck.getAttribute('src') !== null || deck.currentSrc) continue;
      deck.muted = true;
      diagnosticSource(deck, () => {
        deck.src = SILENT_WAV;
      });
      const release = () => {
        if (deck.src !== SILENT_WAV) return; // a real track claimed this deck
        setDeckParticipation(deck, false);
        pauseDeck(deck);
        diagnosticSource(deck, () => deck.removeAttribute('src'));
        diagnosticLoad(deck);
      };
      void diagnosticPlay(deck).then(lifetime.guard(() => {
        unlockedDecks.add(deck);
        release();
      }), release);
    }
  }
  let outputHealth: OutputHealth = 'healthy';
  let outputRecovering = false;
  let recoveryAttempted = false;
  let recoveryGeneration = 0;
  let clockTimer: ReturnType<typeof setTimeout> | null = null;
  let clockSample: {
    wall: number;
    context: number;
    position: number;
    deck: HTMLAudioElement;
    since: number;
    startPosition: number;
  } | null = null;
  function resetClockSample(): void {
    clockSample = null;
  }
  function publishOutputHealth(health: OutputHealth): void {
    outputHealth = health;
    recordPlaybackDiagnostic('output.health', {
      state: health
    });
    audioEl().dispatchEvent(new Event('outputhealth'));
  }
  function cancelOutputRecovery(): void {
    recoveryGeneration += 1;
    outputRecovering = false;
    outputHealth = 'healthy';
    recoveryAttempted = false;
    resetClockSample();
    if (clockTimer !== null) lifetime.clearTimeout(clockTimer);
    clockTimer = null;
  }
  function observeClock(): void {
    const context = ports.audioContext;
    const deck = audioEl();
    if (!playbackRequested || outputRecovering || !context || !ports.graphReady() || !deckIsPlaying(deck) || deck.seeking || deck.readyState < 3 || context.state !== 'running') {
      resetClockSample();
      return;
    }
    const wall = performance.now();
    const previous = clockSample;
    const position = deck.currentTime;
    const clock = context.currentTime;
    const continuous = previous && previous.deck === deck && wall - previous.wall <= 1000 && position >= previous.position && position - previous.position <= 2;
    const frozen = continuous && clock === previous.context;
    clockSample = {
      wall,
      context: clock,
      position,
      deck,
      since: frozen ? previous.since : wall,
      startPosition: frozen ? previous.startPosition : position
    };
    if (frozen && wall - previous.since >= 1000 && position - previous.startPosition >= (wall - previous.since) / 2000) {
      void recoverProgramOutput();
    }
  }
  function superviseClock(): void {
    if (clockTimer !== null || !playbackRequested || outputRecovering || !ports.graphReady()) return;
    clockTimer = lifetime.setTimeout(() => {
      clockTimer = null;
      observeClock();
      if (deckIsPlaying(audioEl())) superviseClock();
    }, 250);
  }
  async function recoverProgramOutput(): Promise<void> {
    const isCurrent = lifetime.capture();
    const context = ports.audioContext;
    if (!context || outputRecovering || !playbackRequested) return;
    if (recoveryAttempted) {
      ports.audioService.pause('recovery', 'output_recovery_failed');
      publishOutputHealth('needs_play');
      return;
    }
    recoveryAttempted = true;
    outputRecovering = true;
    const generation = ++recoveryGeneration;
    const current = () => generation === recoveryGeneration && playbackRequested && ports.audioContext === context;
    if (clockTimer !== null) lifetime.clearTimeout(clockTimer);
    clockTimer = null;
    if (ports.mix && ports.mix.phase !== 'armed') ports.cancelMix('transport_pause');
    const deck = audioEl();
    const position = deck.currentTime;
    const seek = seekGeneration;
    for (const participant of decks()) pauseDeck(participant);
    ports.programCarrier?.pause();
    publishOutputHealth('recovering');
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        const isCurrent = lifetime.capture();
        await context.suspend();
        if (!isCurrent()) {
          return;
        }
        if (!current()) return;
        await context.resume();
        if (!isCurrent()) {
          return;
        }
        if (!current()) return;
        ports.primeAudioSession(context);
        const before = context.currentTime;
        // Route activation may settle after resume() resolves. The shared
        // deadline bounds this wait without mistaking a slow restart for death.
        while (current() && (context.state !== 'running' || context.currentTime <= before)) {
          await new Promise<void>(resolve => lifetime.setTimeout(resolve, 250));
          if (!isCurrent()) {
            return;
          }
        }
        if (!current()) return;
        if (seek === seekGeneration) deck.currentTime = position;
        outputRecovering = false;
        resetClockSample();
        await playProgramDeck(deck);
        if (!isCurrent()) {
          return;
        }
      })(), new Promise<never>((_, reject) => {
        deadline = lifetime.setTimeout(() => reject(new Error('clock_timeout')), 5000);
      })]);
      if (!isCurrent()) {
        return;
      }
      if (!current()) return;
      if (current()) publishOutputHealth('healthy');
    } catch {
      if (!isCurrent()) {
        return;
      }
      if (!current()) return;
      ports.audioService.pause('recovery', 'output_recovery_failed');
      publishOutputHealth('needs_play');
    } finally {
      if (deadline !== undefined) lifetime.clearTimeout(deadline);
    }
  }
  function deckIsPlaying(deck: HTMLAudioElement): boolean {
    return !deck.paused && !deck.ended && Boolean(deck.currentSrc || deck.getAttribute('src')) && !holdsUnlockSample(deck);
  }
  function playProgramDeck(deck: HTMLAudioElement): Promise<void> {
    if (!playbackRequested) return Promise.resolve();
    ports.resumeContext();
    superviseClock();
    setDeckParticipation(deck, true);
    const start = {};
    pendingStarts.set(deck, start);
    const started = diagnosticPlay(deck);
    void ports.programCarrier?.play();
    return started.finally(lifetime.guard(() => {
      if (pendingStarts.get(deck) === start) pendingStarts.delete(deck);
    }));
  }
  function deckBufferedEnd(deck: HTMLAudioElement): number {
    let furthest = 0;
    for (let i = 0; i < deck.buffered.length; i += 1) {
      const end = deck.buffered.end(i);
      if (Number.isFinite(end) && end > furthest) furthest = end;
    }
    return furthest;
  }
  function programPlaybackSnapshot(): ProgramPlaybackSnapshot {
    const deck = audioEl();
    const output = ports.programCarrier?.snapshot();
    const outputMode = output?.mode ?? 'direct_fallback';
    const sourcePlaying = deckIsPlaying(deck);
    const carrierPlaying = output?.carrierPlaying ?? false;
    return {
      outputMode,
      playing: sourcePlaying && !outputRecovering && (outputMode === 'carrier' ? carrierPlaying : true),
      sourcePlaying,
      carrierPlaying,
      position: Number.isFinite(deck.currentTime) ? deck.currentTime : 0,
      duration: Number.isFinite(deck.duration) ? deck.duration : 0,
      playbackRate: Number.isFinite(deck.playbackRate) && deck.playbackRate > 0 ? deck.playbackRate : 1,
      ended: deck.ended,
      readyState: deck.readyState,
      networkState: deck.networkState,
      mediaErrorCode: deck.error?.code ?? 0,
      hasSource: Boolean(deck.getAttribute('src') || deck.currentSrc),
      bufferedEnd: deckBufferedEnd(deck),
      activeIndex,
      mixPhase: ports.mix?.phase ?? 'idle',
      dominant: ports.mix?.dominant ?? false,
      contextState: ports.audioContext?.state ?? 'unavailable'
    };
  }
  function detach(deck: HTMLAudioElement): void {
    // Stop competing for Now Playing before the native pause can publish a
    // stopped source as the programme. Audio gain alone does not exclude it.
    setDeckParticipation(deck, false);
    clearSeekGate(deck);
    pauseDeck(deck);
    deck.playbackRate = 1;
    if (deck.getAttribute('src') === null && !deck.currentSrc) return;
    // Not while the page is in the background. This runs the instant a handoff
    // completes, before the incoming deck has produced a single sample, and
    // `load()` is what resets a media element — on iOS that is enough to hand the
    // audio session back and end playback for a phone that is locked in a pocket.
    // Holding the stream costs nothing until then: `stage` assigns this same deck
    // a new `src` milliseconds later, which aborts the old request anyway.
    if (pageHidden()) {
      pendingDetach.add(deck);
      return;
    }
    diagnosticSource(deck, () => deck.removeAttribute('src'));
    diagnosticLoad(deck);
  }
  const pendingDetach = new Set<HTMLAudioElement>();
  function flushDeferredWork(): void {
    for (const deck of pendingDetach) {
      // Skip a deck that has been handed a real track in the meantime — `stage`
      // and `load` both assign `src` without going through `detach`.
      if (deck.paused && (deck.getAttribute('src') !== null || deck.currentSrc)) {
        diagnosticSource(deck, () => deck.removeAttribute('src'));
        diagnosticLoad(deck);
      }
    }
    pendingDetach.clear();
  }
  function reconcilePlatformPlayback(): void {
    if (!playbackRequested || outputRecovering) return;
    // A song that played to its end is paused by definition. That is a track
    // boundary for `ended` to settle, not the platform taking the music away —
    // revoking playback here is what left a drive on a finished song, with the
    // next one already loaded and released.
    if (audioEl().paused && !audioEl().ended && !pendingStarts.has(audioEl())) {
      ports.audioService.pause('platform', 'native_paused_on_restore');
      return;
    }
    ports.resumeContext();
  }
  let lifecycleBound = false;
  function bindLifecycle(): void {
    if (lifecycleBound) return;
    lifecycleBound = true;
    if (typeof document !== 'undefined') {
      lifetime.listen(document, 'visibilitychange', () => {
        recordPlaybackDiagnostic('lifecycle.visibility');
        resetClockSample();
        if (document.visibilityState !== 'hidden') {
          flushDeferredWork();
          reconcilePlatformPlayback();
          if (playbackRequested) superviseClock();
        }
      });
    }
    lifetime.listen(document, 'resume', reconcilePlatformPlayback);
    lifetime.listen(window, 'pageshow', reconcilePlatformPlayback);
    // A blend is driven by a chain of timeouts, and a backgrounded page does not
    // get to keep its timers: iOS throttles them to whatever it likes and stops
    // them altogether once the page is frozen. `timeupdate` and `ended` come from
    // the media element itself and keep arriving for as long as it is sounding,
    // which on a locked phone is the only clock left. `tick` reads media clocks
    // and compares them, so being called twice for the same moment costs nothing
    // and being called at all is the difference between a handoff and silence.
    onDeckEvent('timeupdate', () => {
      observeClock();
      if (ports.mix && !outputRecovering) ports.tick();
    });
    onDeckEvent('ended', event => {
      ports.settleEndedEvent(event);
      queueMicrotask(() => {
        if (!ports.mix && !deckIsPlaying(audioEl())) ports.programCarrier?.pause();
      });
    });
    onDeckEvent('pause', event => {
      const deck = event.currentTarget as HTMLAudioElement;
      // A queued system pause still revokes intent if WebKit has already
      // restarted the source before delivering the event on unlock.
      if (expectedPauses.delete(deck) || outputRecovering || deck.ended || holdsUnlockSample(deck) || !participatingDecks.has(deck) || !playbackRequested) return;
      ports.audioService.pause('platform', 'native_pause');
    });
    const rejectOrphanedDeck = (event: Event) => {
      const deck = event.currentTarget as HTMLAudioElement | null;
      if (!deck || holdsUnlockSample(deck) || !deckIsPlaying(deck)) return;
      if (!playbackRequested || outputRecovering) {
        pauseDeck(deck);
        recordPlaybackDiagnostic('transport.rejected_native_play');
        return;
      }
      if (isActiveDeck(deck)) return;
      // Both decks are legitimate programme sources only while one live mix owns
      // them. Outside it, a non-active play is WebKit reviving an old media
      // session (most often after a Bluetooth/lock-screen command), never music
      // Soundsible asked to start.
      if (ports.mix && (deck === decks()[ports.mix.fromIndex] || deck === decks()[ports.mix.toIndex])) return;
      const index = decks().indexOf(deck);
      if (index < 0) return;
      releaseDeck(index);
      ports.reportProgramTransport('inactive_deck_play', 'media_session', 'idle', false);
    };
    onDeckEvent('play', rejectOrphanedDeck);
    onDeckEvent('playing', rejectOrphanedDeck);
    // Native fallout may arrive after the synchronous operation's publication.
    // Only reconcile inactive sources; active transport keeps its own handlers.
    for (const type of ['pause', 'emptied', 'loadedmetadata']) {
      onDeckEvent(type, event => {
        if (!isActiveDeck(event.currentTarget)) notifySourcesSettled();
      });
    }
  }
  let loadSeq = 0;
  function isCurrentLoad(token: number): boolean {
    return token === loadSeq;
  }
  let stagedUrl = '';
  const actions = {
    load(url: string, level: number, positionSec = 0): Promise<void> {
      cancelOutputRecovery();
      playbackRequested = true;
      ports.cancelMix('load');
      const a = audioEl();
      const token = ++loadSeq;
      pendingDetach.delete(a);
      ports.stopRateReturn();
      a.playbackRate = 1;
      // Before `src`, and required rather than defaulted: this deck is not
      // detached between tracks, so the only thing standing between a levelled
      // song and the podcast after it is that every caller passes its own level.
      ports.setDeckLevel(activeIndex, level);
      // Assigning src runs the media load algorithm, which aborts the previous
      // fetch. No explicit detach: it would emit a spurious `pause` between the
      // two tracks and flicker the transport controls.
      clearSeekGate(a);
      diagnosticSource(a, () => {
        a.src = url;
      });
      if (Number.isFinite(positionSec) && positionSec > 0) {
        const applyPosition = () => {
          if (token !== loadSeq) return;
          a.currentTime = Number.isFinite(a.duration) && a.duration > 0 ? Math.min(positionSec, a.duration) : positionSec;
        };
        if (a.readyState >= 1) applyPosition();else lifetime.listen(a, 'loadedmetadata', applyPosition, {
          once: true
        });
      }
      return playProgramDeck(a).catch(lifetime.guard((err: unknown) => {
        if (token !== loadSeq) return; // superseded — the newer load owns the deck
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }));
    },
    recover(url: string, positionSec: number, level: number): Promise<void> {
      if (!playbackRequested) return Promise.resolve();
      cancelOutputRecovery();
      ports.cancelMix('load');
      const fromIndex = activeIndex;
      const toIndex = 1 - fromIndex;
      const a = decks()[toIndex];
      const token = ++loadSeq;
      stagedUrl = '';
      ports.stopRateReturn();
      pendingDetach.delete(a);
      a.playbackRate = 1;
      ports.setDeckLevel(toIndex, level);
      // Ownership moves before either deck can emit fallout from replacing or
      // releasing its resource. Store listeners therefore ignore every late
      // event belonging to the failed resource by construction.
      activeIndex = toIndex;
      ports.setDeckGain(toIndex, 1);
      ports.setDeckGain(fromIndex, 0);
      clearSeekGate(a);
      diagnosticSource(a, () => {
        a.src = url;
      });
      releaseDeck(fromIndex);
      const resumeAtPosition = async () => {
        const isCurrent = lifetime.capture();
        if (token !== loadSeq) return;
        const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
        if (position > 0) {
          const duration = a.duration;
          a.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(position, Math.max(0, duration - 0.05)) : position;
        }
        try {
          await playProgramDeck(a);
          if (!isCurrent()) {
            return;
          }
        } catch (err: unknown) {
          if (!isCurrent()) {
            return;
          }
          if (token !== loadSeq) return;
          if (err instanceof Error && err.name === 'AbortError') return;
          throw err;
        }
      };
      if (a.readyState >= 1) return resumeAtPosition();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          if (timer) lifetime.clearTimeout(timer);
          timer = null;
          a.removeEventListener('loadedmetadata', onMetadata);
          a.removeEventListener('error', onError);
        };
        const onMetadata = () => {
          cleanup();
          void resumeAtPosition().then(resolve, reject);
        };
        const onError = () => {
          cleanup();
          reject(new Error('media recovery failed'));
        };
        lifetime.listen(a, 'loadedmetadata', onMetadata, {
          once: true
        });
        lifetime.listen(a, 'error', onError, {
          once: true
        });
        timer = lifetime.setTimeout(() => {
          if (token !== loadSeq) {
            cleanup();
            resolve();
            return;
          }
          cleanup();
          reject(new Error('media recovery metadata timeout'));
        }, RECOVERY_METADATA_TIMEOUT_MS);
      });
    },
    prime(url: string, positionSec: number, level: number): void {
      playbackRequested = false;
      cancelOutputRecovery();
      ports.cancelMix('load');
      const a = audioEl();
      const token = ++loadSeq;
      pendingDetach.delete(a);
      ports.setDeckLevel(activeIndex, level);
      // Explicitly, before the stream is handed over. A deck that is mid-`play()`
      // from `unlockDecks` — the silent sample every gesture spends on an empty
      // deck — would otherwise carry that play straight into the track being
      // primed, and a session put back on boot would start sounding on its own.
      pauseDeck(a);
      clearSeekGate(a);
      diagnosticSource(a, () => {
        a.src = url;
      });
      diagnosticLoad(a);
      setDeckParticipation(a, true);
      const applyPosition = () => {
        if (token !== loadSeq) return;
        const pos = Math.max(0, positionSec);
        if (!Number.isFinite(pos) || pos <= 0) return;
        const dur = a.duration;
        a.currentTime = Number.isFinite(dur) && dur > 0 ? Math.min(pos, dur) : pos;
      };
      if (a.readyState >= 1) applyPosition();else lifetime.listen(a, 'loadedmetadata', applyPosition, {
        once: true
      });
    },
    resume(origin: ProgramTransportOrigin = 'ui'): Promise<void> {
      recordPlaybackDiagnostic('transport.resume', {
        origin
      });
      if (outputRecovering) return Promise.resolve();
      playbackRequested = true;
      recoveryAttempted = false;
      outputHealth = 'healthy';
      configurePlaybackSession();
      const current = ports.mix;
      const phase = current?.phase ?? 'idle';
      const dominant = current?.dominant ?? false;
      const started = playProgramDeck(audioEl());
      ports.reportProgramTransport('resume', origin, phase, dominant);
      return started;
    },
    pause(origin: ProgramTransportOrigin = 'ui', reason = 'command'): void {
      recordPlaybackDiagnostic('transport.pause', {
        origin,
        reason
      });
      playbackRequested = false;
      loadSeq += 1;
      cancelOutputRecovery();
      const current = ports.mix;
      const phase = current?.phase ?? 'idle';
      const dominant = current?.dominant ?? false;
      ports.programCarrier?.pause();
      if (current && current.phase !== 'armed') ports.cancelMix('transport_pause');
      pauseDeck(audioEl());
      ports.reportProgramTransport('pause', origin, phase, dominant);
    },
    stop(): void {
      playbackRequested = false;
      cancelOutputRecovery();
      loadSeq += 1;
      ports.programCarrier?.pause();
      ports.cancelMix('stop');
      stagedUrl = '';
      releaseDeck(activeIndex);
      releaseDeck(1 - activeIndex);
    },
    seek(t: number): void {
      if (!Number.isFinite(t)) return;
      seekGeneration += 1;
      resetClockSample();
      ports.cancelMix('seek');
      const a = audioEl();
      const target = Math.max(0, t);
      if (target === a.currentTime) return;
      // Mute before assigning currentTime: seeking is delivered asynchronously,
      // and WebKit can keep rendering the old decoder buffer in that window.
      // Leave the source/context running and never issue a delayed play().
      if (a.readyState >= 1) {
        pendingSeeks.set(a, {
          settled: false
        });
        applySeekGate(a);
      }
      try {
        a.currentTime = target;
        // No seekable resource (or an effective no-op): no completion event is
        // owed by the browser, so do not leave the output gated forever.
        if (!a.seeking) clearSeekGate(a);
      } catch (error) {
        clearSeekGate(a);
        throw error;
      }
    },
    bufferedEnd(): number {
      return deckBufferedEnd(audioEl());
    },
    snapshot: programPlaybackSnapshot,
    outputHealth: () => outputHealth,
    stage(url: string, level: number): void {
      if (ports.mix || !url) return;
      const index = 1 - activeIndex;
      const idle = decks()[index];
      pendingDetach.delete(idle);
      setDeckParticipation(idle, false);
      // Above the early return on purpose: re-staging the same URL is how a
      // track that has only just been measured gets its level onto the silent
      // deck before it is promoted.
      ports.setDeckLevel(index, level);
      if (stagedUrl === url && (idle.getAttribute('src') !== null || idle.currentSrc)) return;
      stagedUrl = url;
      ports.setDeckGain(index, 0);
      if (!idle.paused) pauseDeck(idle);
      idle.playbackRate = 1;
      diagnosticSource(idle, () => {
        idle.src = url;
      });
      diagnosticLoad(idle);
      notifySourcesSettled();
    },
    clearStaged(): void {
      if (ports.mix || !stagedUrl) return;
      stagedUrl = '';
      releaseDeck(1 - activeIndex);
    },
    takeStaged(url: string, level: number): Promise<void> | null {
      if (ports.mix || !url || stagedUrl !== url) return null;
      const toIndex = 1 - activeIndex;
      const to = decks()[toIndex];
      pendingDetach.delete(to);
      // Deliberately not a `readyState` gate. Safari downgrades `preload="auto"`
      // to metadata-only — on cellular, and for a second media element, near
      // always — so an iPhone's staged deck sits at `HAVE_METADATA` however long
      // it has been cued. Refusing it there sent every track change back to the
      // network, which is precisely what a locked phone will not do. A deck that
      // is holding the right URL is always the better start: `play()` buffers what
      // it still needs, and the fallback would make the same request from scratch
      // and throw away everything this one already has.
      if (to.networkState === NETWORK_NO_SOURCE) return null;
      cancelOutputRecovery();
      playbackRequested = true;
      const fromIndex = activeIndex;
      const token = ++loadSeq;
      stagedUrl = '';
      ports.stopRateReturn();
      to.playbackRate = 1;
      // Already set by `stage`, but re-asserted because the caller may have a
      // fresher measurement than it had when the track was cued. Nothing moves
      // between decks here — only which deck is active.
      ports.setDeckLevel(toIndex, level);
      // Ownership moves first: the outgoing deck's `pause` and `error` from the
      // release below then belong to a deck the store is no longer listening to.
      activeIndex = toIndex;
      ports.setDeckGain(toIndex, 1);
      ports.setDeckGain(fromIndex, 0);
      const started = playProgramDeck(to).catch(lifetime.guard((err: unknown) => {
        if (token !== loadSeq) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }));
      recordPlaybackDiagnostic('handoff.retirement', {
        from: fromIndex,
        to: toIndex
      });
      releaseDeck(fromIndex);
      return started;
    }
  };
  return {
    dispose() {
      ++loadSeq;
      cancelOutputRecovery();
      for (const deck of elements ?? []) {
        pauseDeck(deck);
        diagnosticSource(deck, () => deck.removeAttribute('src'));
        diagnosticLoad(deck);
      }
      pendingDetach.clear();
      elements = null;
    },
    actions,
    get elements() {
      return elements;
    },
    set elements(value: HTMLAudioElement[] | null) {
      elements = value;
    },
    applyDeckMute,
    get pendingSeeks() {
      return pendingSeeks;
    },
    decks,
    configurePlaybackSession,
    reconcilePlatformPlayback,
    get playbackRequested() {
      return playbackRequested;
    },
    set playbackRequested(value: boolean) {
      playbackRequested = value;
    },
    unlockDecks,
    deckIsPlaying,
    audioEl,
    get outputRecovering() {
      return outputRecovering;
    },
    set outputRecovering(value: boolean) {
      outputRecovering = value;
    },
    resetClockSample,
    get VOLUME_KEY() {
      return VOLUME_KEY;
    },
    get activeIndex() {
      return activeIndex;
    },
    set activeIndex(value: number) {
      activeIndex = value;
    },
    programPlaybackSnapshot,
    pageHidden,
    releaseDeck,
    playProgramDeck,
    get NETWORK_NO_SOURCE() {
      return NETWORK_NO_SOURCE;
    },
    pauseDeck,
    setDeckParticipation,
    get stagedUrl() {
      return stagedUrl;
    },
    set stagedUrl(value: string) {
      stagedUrl = value;
    },
    notifySourcesSettled,
    get pendingDetach() {
      return pendingDetach;
    },
    onDeckEvent,
    isActiveDeck,
    onProgramEvent,
    isCurrentLoad
  };
}
