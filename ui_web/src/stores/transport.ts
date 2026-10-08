import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { PodcastProgress } from "../lib/podcastProgress";
import { user } from "../lib/session";
import { api } from "../lib/api";
import { audioService, type ProgramTransportOrigin } from "../lib/audio";
import { type MediaSessionSyncReason } from "../lib/mediaSession";
import { recordPlaybackDiagnostic } from "../lib/playbackDiagnostics";
import { streamUrl, previewUrl, podcastStreamUrl, playbackYoutubeId } from "../lib/media";
import { createPreparationOwner, previewPreparation, previewPreparationState } from "../lib/prefetch";
import { toast } from "../lib/toast";
import { vibrate } from "../lib/haptics";
import { isPodcastTrack } from "../lib/track";
import { queueIdentity, queueIndexOf } from "../lib/queueDiscovery";
import { GeneratedQueueController } from "../lib/generatedQueue";
import { t as tr } from "../lib/i18n";
import { ListeningLearning } from "../lib/listeningLearning";
import { createQueueEntry, defaultContext, futureEntries, isPendingEntry, contextSource, type ContextTrack, type PlaybackContextDescriptor, type PlaybackQueueEntry, type QueueSource } from "../lib/playbackQueue";
import { shuffled } from "../lib/shuffle";
import type { Track } from "../types/music";
import { levelFor as levelForTrack } from "../lib/loudness";
import { state, setState, setNowPlayingOpen, randomId, VOLUME_LEVELING_KEY, DJ_MIXING_KEY, type PlaybackState, type RepeatMode } from "./core";
import type { PlayerActions, PlaybackTrigger, PlaybackSourceKind, PlaybackAttempt, ContextMatchOutcome, LoadOptions, CommittedTransition, PublishedPlaybackState } from "./contracts";
export interface TransportPorts {
  releasePreparation: () => void;
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  matchContextEntry: (queueId: string) => Promise<ContextMatchOutcome>;
  podcastProgressOwner: string | undefined;
  podcastSourcePending: boolean;
  stagedEntry: {
    queueId: string;
    attemptId: string;
    url: string;
  } | null;
  currentPreparation: ReturnType<typeof createPreparationOwner>;
  podcastProgress: PodcastProgress;
  prefetchUpcoming: () => void;
  ensureAutoplay: (force?: boolean) => Promise<boolean>;
  generatedQueue: GeneratedQueueController | null;
  savePodcastProgress: (completed?: boolean, position?: number) => void;
  actions: Pick<PlayerActions, 'addAutoSource' | 'exitAutoMode' | 'next' | 'pausePlayback' | 'playFrom' | 'playNow' | 'playTrack' | 'resumePlayback' | 'retryCurrent' | 'seek'>;
  pushEmptyPlaybackState: (opts?: {
    keepalive?: boolean;
  }) => void;
  boundaryFacts: () => Record<string, boolean>;
  playingDuration: () => number;
  PREMATURE_END_SECONDS: number;
  promotePreparedAutoSuccessor: () => boolean;
  nextEntry: () => PlaybackQueueEntry | undefined;
  enterStarved: () => void;
  resumeFromStarved: () => void;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  confirmNormalMode: (kind: 'podcast' | 'radio', proceed: () => void | Promise<void>) => Promise<void>;
  mixAutoTrackNow: (track: Track) => void;
  abandonContextMatches: (keep?: (queueId: string) => boolean) => void;
  ensureGeneratedQueue: () => GeneratedQueueController;
  commitSeq: number;
  committedTransition: CommittedTransition | null;
  repeatCycle: (queue: PlaybackQueueEntry[]) => PlaybackQueueEntry[];
  pushPlaybackState: (opts?: {
    keepalive?: boolean;
    body?: PublishedPlaybackState;
  }) => void;
}

/** Owns transport behaviour; cross-domain work enters through explicit ports. */
export function createTransport(ports: TransportPorts, lifetime: RuntimeLifetime) {
  let userPlaybackStartedThisSession = false;
  const STALL_RECOVERY_MS = 3000;
  const STARTUP_RECOVERY_MS = 12000;
  const MAX_PROGRESS_REPRIEVES = 3;
  let activeAttempt: PlaybackAttempt | null = null;
  let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let stallBufferedEnd = 0;
  function playbackSourceKind(track: Track): PlaybackSourceKind {
    if (isPodcastTrack(track)) return 'podcast';
    return track.source === 'preview' ? 'preview' : 'local';
  }
  function trackUrl(track: Track): string {
    const previewId = playbackYoutubeId(track);
    return track.source === 'preview' && previewId ? previewUrl(previewId) : streamUrl(track.id);
  }
  function trackPrepared(track: Track): boolean {
    if (isPendingEntry(track)) return false;
    if (track.source !== 'preview' || isPodcastTrack(track)) return true;
    const videoId = playbackYoutubeId(track);
    return !!videoId && previewPreparationState?.(videoId) === 'ready';
  }
  function measuredTrack<T extends Track>(entry: T): T | Track {
    return entry.loudness_lufs == null ? state.library.find(track => track.id === entry.id) ?? entry : entry;
  }
  function levelFor(entry: PlaybackQueueEntry | Track | null | undefined): number {
    if (!entry || !state.playback.volumeLeveling) return 1;
    const facts = measuredTrack(entry);
    const context = (entry as PlaybackQueueEntry).queueContext;
    // Resolved through the library like the entry itself. Without this an album
    // queued before the sweep reached it would look wholly unmeasured, and album
    // levelling would silently never engage.
    const siblings = context?.kind === 'album' ? state.playback.queue.filter(item => item.queueContext?.id === context.id).map(measuredTrack) : undefined;
    return levelForTrack(facts, {
      enabled: true,
      shuffle: state.playback.shuffle,
      siblings,
      contextKind: context?.kind ?? null,
      contextId: context?.id ?? null
    });
  }
  function applyVolumeLeveling(enabled: boolean): void {
    setState('playback', 'volumeLeveling', enabled);
    try {
      localStorage.setItem(VOLUME_LEVELING_KEY, enabled ? 'on' : 'off');
    } catch {
      /* private mode / storage disabled */
    }
    audioService.setLevelingEnabled(enabled);
  }
  function applyDjMixing(enabled: boolean): void {
    setState('playback', 'djMixing', enabled);
    try {
      localStorage.setItem(DJ_MIXING_KEY, enabled ? 'on' : 'off');
    } catch {
      /* private mode / storage disabled */
    }
  }
  const loudnessAsked = new Set<string>();
  function requestUpcomingLoudness(fromIndex: number): void {
    if (!state.playback.volumeLeveling) return;
    const ids = state.playback.queue.slice(fromIndex, fromIndex + 5)
    // Through the library, not the queue entry. An entry is a snapshot taken
    // when the track was enqueued, so a song measured since then still looks
    // unmeasured here — and asking again for something the engine has already
    // answered is work nobody is waiting for.
    .filter(entry => measuredTrack(entry).loudness_lufs == null && entry.source !== 'preview' && !isPodcastTrack(entry) && !loudnessAsked.has(entry.id)).map(entry => entry.id);
    if (!ids.length) return;
    // The engine only announces new measurements every few minutes, so without
    // this the same five ids would be re-sent on every track change until it does.
    for (const id of ids) loudnessAsked.add(id);
    try {
      // Advisory only, and guarded rather than awaited: an older engine or a test
      // double may not expose this at all, and nothing about starting a track is
      // allowed to depend on it.
      void api.requestLoudness?.(ids)?.catch(() => {});
    } catch {
      /* the sweep will reach these on its own */
    }
  }
  function clearStallTimer(): void {
    if (stallRecoveryTimer) lifetime.clearTimeout(stallRecoveryTimer);
    stallRecoveryTimer = null;
  }
  function emitAttempt(attempt: PlaybackAttempt, phase: string, terminalState: string, extra: Record<string, number | boolean> = {}, failureReason?: string): void {
    void api.sendPlayTiming({
      v: 2,
      attempt_id: attempt.id,
      track_id: attempt.trackId,
      device_id: state.device.device_id,
      phase,
      source_kind: attempt.sourceKind,
      cache_state: 'unknown',
      trigger: attempt.trigger,
      queue_lane: attempt.queueLane,
      terminal_state: terminalState,
      egress: 'unknown',
      failure_reason: failureReason,
      segments: extra
    }).catch(lifetime.guard(() => {}));
  }
  function emitPlaybackEvent(phase: string, extra: Record<string, number | boolean> = {}, strings: {
    failure_reason?: string;
    context_state?: string;
    display_mode?: string;
    transport_action?: string;
    transport_origin?: string;
    mix_phase?: string;
    output_mode?: string;
    output_event?: string;
    media_session_state?: string;
    sync_reason?: string;
    video_id?: string;
    queue_lane?: string;
    queue_source?: string;
  } = {}): void {
    recordPlaybackDiagnostic(`store.${phase}`, {
      mode: state.autoMode.active ? 'dj' : 'normal',
      phase: state.playback.phase,
      origin: strings.transport_origin ?? '',
      action: strings.transport_action ?? '',
      syncReason: strings.sync_reason ?? ''
    });
    void api.sendPlayTiming({
      v: 2,
      attempt_id: activeAttempt?.id,
      track_id: state.playback.currentTrack?.id,
      device_id: state.device.device_id,
      phase,
      trigger: activeAttempt?.trigger,
      terminal_state: state.playback.phase,
      // Every one of these events reads differently depending on whether the
      // decks were routed through the mixing graph at the time, so it travels
      // with all of them rather than only with the graph's own report.
      segments: {
        graph: audioService.graphReady(),
        ...extra
      },
      ...strings
    }).catch(lifetime.guard(() => {}));
  }
  function concludeAttempt(attempt: PlaybackAttempt | null, outcome: string): void {
    if (!attempt || attempt.concluded || attempt.audibleAt === null) return;
    attempt.concluded = true;
    const now = performance.now();
    // A spell still open at this point ended the play — the track was cut off while
    // buffering. Counting it needs doing here or it is lost.
    const pending = attempt.bufferStartedAt === null ? 0 : Math.max(0, now - attempt.bufferStartedAt);
    attempt.bufferStartedAt = null;
    emitAttempt(attempt, 'ui_play_delivery', outcome, {
      audible_ms: Math.round(now - attempt.audibleAt),
      startup_stall_ms: Math.round(attempt.startupStallMs),
      rebuffer_count: attempt.rebufferCount,
      rebuffer_ms: Math.round(attempt.rebufferMs + pending),
      seek_rebuffer_count: attempt.seekRebufferCount,
      recovery_count: attempt.recoveryCount
    });
  }
  function cancelActiveAttempt(reason = 'superseded'): void {
    clearStallTimer();
    const attempt = activeAttempt;
    if (!attempt) return;
    if (attempt.audibleAt === null) {
      emitAttempt(attempt, 'ui_attempt_cancelled', 'cancelled', {
        elapsed_ms: Math.round(performance.now() - attempt.startedAt)
      }, reason);
    } else {
      concludeAttempt(attempt, reason);
    }
    activeAttempt = null;
  }
  function createPlaybackAttempt(track: Track, generation: number, trigger: PlaybackTrigger, id = randomId()): PlaybackAttempt {
    cancelActiveAttempt();
    const attempt: PlaybackAttempt = {
      id,
      trackId: track.id,
      sourceKind: playbackSourceKind(track),
      trigger,
      queueLane: 'queueLane' in track && typeof track.queueLane === 'string' ? track.queueLane : 'context',
      startedAt: performance.now(),
      loadedMetadataAt: null,
      canPlayAt: null,
      audibleAt: null,
      bufferStartedAt: null,
      startupStallMs: 0,
      rebufferCount: 0,
      rebufferMs: 0,
      seekRebufferCount: 0,
      seekPending: false,
      stallReprieves: 0,
      spoolBytes: 0,
      recoveryCount: 0,
      reportedRecoveryCount: 0,
      concluded: false,
      generation
    };
    activeAttempt = attempt;
    return attempt;
  }
  let unmatchedSelection: {
    queueId: string;
    paused: boolean;
  } | null = null;
  function loadUnmatchedIndex(i: number, opts: LoadOptions): void {
    const entry = state.playback.queue[i];
    if (!entry) return;
    userPlaybackStartedThisSession = true;
    ports.releasePreparation();
    beginLoad();
    cancelActiveAttempt('superseded');
    runWhenAudible = null;
    const selection = {
      queueId: entry.queueId,
      paused: false
    };
    unmatchedSelection = selection;
    setState('playback', {
      currentTrack: entry,
      index: i,
      isPlaying: true,
      isLoading: true,
      loadError: false,
      needsGesture: false,
      phase: 'loading',
      previewPreparation: null,
      currentTime: 0,
      duration: entry.duration ?? 0
    });
    ports.updateMediaSession(entry);
    audioService.pause();
    void ports.matchContextEntry(entry.queueId).then(lifetime.guard(outcome => {
      if (unmatchedSelection !== selection || selection.paused) return;
      const pb = state.playback;
      const at = pb.queue.findIndex(row => row.queueId === selection.queueId);
      if (at === -1 || at !== pb.index) {
        unmatchedSelection = null;
        return;
      }
      if (outcome !== 'unavailable') {
        loadIndex(at, {
          ...opts,
          restart: true
        });
        return;
      }
      unmatchedSelection = null;
      consecutiveLoadFailures += 1;
      emitPlaybackEvent('ui_context_unmatched', {
        position: 0
      });
      if (at < pb.queue.length - 1 && consecutiveLoadFailures <= MAX_CONSECUTIVE_SKIPS) {
        toast.error(tr('toast.trackUnavailableSkipping'));
        setState('playback', 'queue', pb.queue.filter(row => row.queueId !== selection.queueId));
        loadIndex(at, {
          ...opts,
          restart: true
        });
        return;
      }
      toast.error(tr('toast.trackUnavailable'));
      setState('playback', {
        isPlaying: false,
        isLoading: false,
        loadError: true,
        phase: 'failed'
      });
    }));
  }
  function loadIndex(i: number, opts: LoadOptions = {}): void {
    const track = state.playback.queue[i];
    if (!track) return;
    const pb = state.playback;
    if (opts.paused) {
      ports.releasePreparation();
      beginLoad();
      cancelActiveAttempt('paused_selection');
      runWhenAudible = null;
      audioService.stop();
      unmatchedSelection = { queueId: track.queueId, paused: true };
      setState('playback', {
        currentTrack: track, index: i, isPlaying: false, isLoading: false,
        loadError: false, needsGesture: false, phase: 'paused',
        previewPreparation: null, currentTime: 0, duration: track.duration ?? 0,
      });
      ports.updateMediaSession(track);
      return;
    }
    const deckHoldsIt = unmatchedSelection?.queueId !== track.queueId;
    if (!opts.restart && !pb.loadError && deckHoldsIt && i === pb.index && pb.currentTrack?.id === track.id) {
      if (pb.isLoading || pb.isPlaying) return; // already on its way / already sounding
      void audioService.resume().catch(lifetime.guard(() => {}));
      return;
    }
    if (isPendingEntry(track)) {
      loadUnmatchedIndex(i, opts);
      return;
    }
    unmatchedSelection = null;
    if (state.autoMode.active) {
      if (!state.autoMode.sources.length) setState('autoMode', 'sources', [{
        id: randomId(),
        label: track.title,
        tracks: [track],
        activation: 1
      }]);
      const identity = queueIdentity(track);
      if (!state.autoMode.heard.some(heard => queueIdentity(heard) === identity)) {
        setState('autoMode', 'heard', heard => [...heard, track].slice(-40));
      }
    }
    userPlaybackStartedThisSession = true;
    ports.releasePreparation();
    const generation = beginLoad();
    ports.podcastProgressOwner = user()?.id;
    ports.podcastSourcePending = track.source === 'preview' && isPodcastTrack(track) && Boolean(track.podcast_enclosure_url);
    // A deck already holding this exact stream takes over without a request and
    // without an `src` assignment. From `ended` that keeps the handover inside the
    // media event, which is what lets it continue at all on a locked phone.
    // Computed once and shared by both paths, so a handoff and a fresh load can
    // never disagree about how loud this track should be.
    const level = levelFor(track);
    const staged = ports.stagedEntry?.queueId === track.queueId ? audioService.takeStaged(ports.stagedEntry.url, level) : null;
    createPlaybackAttempt(track, generation, opts.trigger ?? 'selection', staged ? ports.stagedEntry!.attemptId : undefined);
    if (staged) ports.stagedEntry = null;
    setState('playback', {
      currentTrack: track,
      index: i,
      isPlaying: true,
      isLoading: true,
      loadError: false,
      needsGesture: false,
      phase: 'loading',
      previewPreparation: null,
      currentTime: 0,
      duration: staged ? audioService.snapshot().duration : 0
    });
    ports.updateMediaSession(track);
    const previewId = track.source === 'preview' ? playbackYoutubeId(track) : null;
    ports.currentPreparation.update(previewId ? [previewId] : []);
    const resumePosition = ports.podcastProgress.position(track, user()?.id);
    const start = track.source === 'preview' && isPodcastTrack(track) && track.podcast_enclosure_url ? api.podcastPeek(track.podcast_enclosure_url).then(lifetime.guard(({
      stream_token
    }) => {
      if (generation !== loadGeneration) return;
      if (!stream_token) throw new Error('no podcast stream token');
      ports.podcastSourcePending = false;
      return audioService.load(podcastStreamUrl(stream_token), 1, resumePosition);
    })) : staged ?? (opts.freshDeck ? audioService.recover(trackUrl(track), resumePosition, level) : isPodcastTrack(track) ? audioService.load(trackUrl(track), level, resumePosition) : audioService.load(trackUrl(track), level));
    void Promise.resolve(start).catch(lifetime.guard(() => onPlaybackFailed(generation, 'load')));
    // `waiting` is not guaranteed for a media element whose play promise never
    // settles. Arm startup supervision from the request itself so an infinite
    // 0:00 spinner has a bounded recovery path.
    scheduleStallRecovery(STARTUP_RECOVERY_MS);
    // Warming the next track is a second full-file GET and the loudness lookahead
    // is a POST that used to make the engine read the whole library. Firing them
    // in the tick of the click meant the song the listener is actually waiting for
    // competed with both — for the engine, and for Safari's load slots. Neither is
    // needed until this track is sounding; `watchRunway` re-stages a minute before
    // the end, so a load that never becomes audible loses nothing.
    runWhenAudible = () => {
      ports.prefetchUpcoming();
      // The live index, not the one this load was for: by the time a track is
      // audible it is the current one, and a captured index would look ahead from
      // wherever a superseded attempt happened to be.
      requestUpcomingLoudness(state.playback.index);
    };
    // Queue *depth*, on the other hand, cannot wait on audio: a lane that runs dry
    // because the track before it failed to start is the one case where refilling
    // matters most.
    queueMicrotask(() => {
      void ports.ensureAutoplay();
      if (state.playback.radioMode || state.autoMode.active) {
        void ports.generatedQueue?.ensureRunway();
      }
    });
  }
  let runWhenAudible: (() => void) | null = null;
  function flushWhenAudible(): void {
    const work = runWhenAudible;
    runWhenAudible = null;
    work?.();
  }
  let loadGeneration = 0;
  const beginLoad = (): number => {
    ports.savePodcastProgress();
    return ++loadGeneration;
  };
  let consecutiveLoadFailures = 0;
  const MAX_CONSECUTIVE_SKIPS = 3;
  function recoverCurrent(reason: 'load' | 'error' | 'stall'): boolean {
    const attempt = activeAttempt;
    const track = state.playback.currentTrack;
    if (!attempt || !track || attempt.recoveryCount >= 1) return false;
    attempt.recoveryCount += 1;
    clearStallTimer();
    if (attempt.bufferStartedAt !== null) {
      const spell = Math.max(0, performance.now() - attempt.bufferStartedAt);
      if (attempt.audibleAt === null) attempt.startupStallMs += spell;else attempt.rebufferMs += spell;
      attempt.bufferStartedAt = null;
    }
    const generation = beginLoad();
    attempt.generation = generation;
    setState('playback', {
      isPlaying: true,
      isLoading: true,
      loadError: false,
      phase: 'recovering'
    });
    emitAttempt(attempt, 'ui_recovery_started', 'recovering', {
      recovery_count: attempt.recoveryCount,
      position_ms: Math.round((state.playback.currentTime || 0) * 1000)
    }, reason);
    const position = state.playback.currentTime || 0;
    const recovery = attempt.sourceKind === 'podcast' && track.podcast_enclosure_url ? api.podcastPeek(track.podcast_enclosure_url).then(lifetime.guard(({
      stream_token
    }) => {
      if (!stream_token) throw new Error('no podcast stream token');
      return audioService.recover(podcastStreamUrl(stream_token), position, 1);
    })) : audioService.recover(trackUrl(track), position, levelFor(track));
    void recovery.catch(lifetime.guard(() => onPlaybackFailed(generation, reason)));
    scheduleStallRecovery(STARTUP_RECOVERY_MS);
    return true;
  }
  function scheduleStallRecovery(delayMs = STALL_RECOVERY_MS): void {
    clearStallTimer();
    const attempt = activeAttempt;
    if (!attempt) return;
    const bufferedAtArm = audioService.bufferedEnd();
    stallBufferedEnd = bufferedAtArm;
    stallRecoveryTimer = lifetime.setTimeout(() => {
      stallRecoveryTimer = null;
      if (activeAttempt !== attempt || !['loading', 'recovering', 'buffering'].includes(state.playback.phase)) return;
      // Recovery reloads the element, which drops every byte it has fetched and
      // starts the track again from nothing. Worth it for a load that has died;
      // ruinous for one that is merely slow — on a phone reaching the station
      // over a relay, a reload at twelve seconds was what turned a long start
      // into a much longer one. So: if the deck has buffered anything at all
      // since this timer was armed, it is working, and it is given more time.
      if (audioService.bufferedEnd() > stallBufferedEnd && attempt.stallReprieves < MAX_PROGRESS_REPRIEVES) {
        attempt.stallReprieves += 1;
        scheduleStallRecovery(delayMs);
        return;
      }
      const current = state.playback.currentTrack;
      const previewId = current?.source === 'preview' ? playbackYoutubeId(current) : null;
      const prep = previewId ? previewPreparation(previewId) : undefined;
      const spoolBytes = prep?.downloaded_bytes ?? 0;
      if (prep && (prep.state === 'pending' || prep.state === 'streamable') && spoolBytes > attempt.spoolBytes) {
        attempt.spoolBytes = spoolBytes;
        scheduleStallRecovery(delayMs);
        return;
      }
      if (!recoverCurrent('stall')) onPlaybackFailed(attempt.generation, 'stall');
    }, delayMs);
  }
  function onPlaybackFailed(generation: number, reason = 'media_error', media: Record<string, number | boolean> = {}): void {
    if (generation !== loadGeneration) return; // a later attempt already took over
    if (recoverCurrent(reason === 'stall' ? 'stall' : reason === 'load' ? 'load' : 'error')) return;
    loadGeneration += 1; // retire this attempt: further reports for it are stale
    const pb = state.playback;
    const attempt = activeAttempt;
    clearStallTimer();
    if (attempt) {
      emitAttempt(attempt, 'ui_attempt_failed', 'failed', {
        elapsed_ms: Math.round(performance.now() - attempt.startedAt),
        startup_stall_ms: Math.round(attempt.startupStallMs),
        rebuffer_count: attempt.rebufferCount,
        rebuffer_ms: Math.round(attempt.rebufferMs),
        recovery_count: attempt.recoveryCount,
        resource_generation: generation,
        runway_ready_depth: futureEntries(pb.queue, pb.index).slice(0, 3).filter(trackPrepared).length,
        ...media
      }, reason);
      // A failure after the music had started is still a play, and one that ended
      // badly is the most worth counting. `concludeAttempt` no-ops on an attempt
      // that never sounded, which is what the event above already covers.
      concludeAttempt(attempt, 'failed');
      activeAttempt = null;
    }
    setState('playback', {
      isPlaying: false,
      isLoading: false,
      loadError: true,
      phase: 'failed'
    });
    if (attempt?.sourceKind === 'preview' && (attempt.trigger === 'selection' || attempt.trigger === 'retry')) {
      // A listener explicitly chose this exact work. Keep it selected with the
      // retry affordance; skipping is appropriate only for unattended context.
      toast.error(tr('toast.trackUnavailable'));
      return;
    }
    if (state.autoMode.active) {
      // Once a handoff has made this the current track, a delivery failure is no
      // longer a failed *candidate*. Advancing here turned one station-wide 503
      // into a self-driving cascade: each new deck hit the same cooldown, failed
      // in a few hundred milliseconds, and recursively selected another song.
      // Keep the exact current occurrence stopped on Retry. A pre-handoff failure
      // is handled separately by `commitTransition.onError`, while an intentional
      // listener skip still goes through `autoSkip`.
      toast.error(tr('toast.trackUnavailable'));
      return;
    }
    consecutiveLoadFailures += 1;
    const hasNext = pb.index < pb.queue.length - 1 || pb.repeat === 'all' && pb.queue.length > 1;
    if (hasNext && consecutiveLoadFailures <= MAX_CONSECUTIVE_SKIPS) {
      toast.error(tr('toast.trackUnavailableSkipping'));
      ports.actions.next();
      return;
    }
    toast.error(tr('toast.trackUnavailable'));
  }
  function removeTrackReferences(id: string): void {
    setState('library', l => l.filter(t => t.id !== id));
    // Favourites are deliberately left alone: deleting the file is not
    // unfavouriting the song. The entry stops resolving to a library track and
    // degrades to a preview on its own — and re-downloading the same audio mints
    // the same content hash, so it silently becomes local again.
    setState('playlists', Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.filter(x => x !== id)])));
    const pb = state.playback;
    const nextQueue = pb.queue.filter(t => t.id !== id);
    if (nextQueue.length !== pb.queue.length) {
      const nextIndex = pb.currentTrack ? nextQueue.findIndex(t => t.id === pb.currentTrack?.id) : -1;
      setState('playback', {
        queue: nextQueue,
        index: nextIndex
      });
    }
    if (pb.currentTrack?.id === id) {
      ports.releasePreparation();
      cancelActiveAttempt('track_removed');
      audioService.stop();
      setState('playback', {
        currentTrack: null,
        isPlaying: false,
        isLoading: false,
        loadError: false,
        phase: 'idle',
        currentTime: 0,
        duration: 0,
        queue: nextQueue,
        index: -1
      });
      ports.updateMediaSession(null);
      ports.pushEmptyPlaybackState();
    }
    ports.prefetchUpcoming();
  }
  function restorePlaybackSnapshot(snapshot: PlaybackState): void {
    setState('playback', {
      ...snapshot,
      queue: snapshot.queue.slice()
    });
    ports.updateMediaSession(snapshot.currentTrack);
  }
  function onEnded(): void {
    // The track played to its end either way, so its delivery is reportable before
    // anything is decided about what follows.
    concludeAttempt(activeAttempt, 'ended');
    // A committed handoff owns the end of this track: the mixer starts the blend
    // off the same moment, and advancing the queue here would cancel it.
    if (audioService.mixPhase() !== 'idle') {
      emitPlaybackEvent('ui_track_ended', ports.boundaryFacts());
      return;
    }
    const snapshot = audioService.snapshot();
    const duration = ports.playingDuration();
    const position = snapshot.position;
    // The store's clock only advances while the page is awake, so after a spell
    // with the screen off it is stale. The element is the authority at this point.
    setState('playback', {
      currentTime: position,
      duration
    });
    const premature = duration > 0 && position < duration - ports.PREMATURE_END_SECONDS;
    // Seconds, not milliseconds: the endpoint drops any `_ms` value over five
    // minutes, which a podcast duration passes comfortably.
    emitPlaybackEvent('ui_track_ended', {
      position_sec: Math.round(position),
      duration_sec: Math.round(duration),
      premature,
      ...ports.boundaryFacts()
    });
    if (premature && recoverCurrent('stall')) {
      // A cut stream, not a finished song: reload and carry on from here rather
      // than skipping the rest of it.
      emitPlaybackEvent('ui_premature_end', {
        position_sec: Math.round(position)
      });
      return;
    }
    ports.savePodcastProgress(!premature, position);
    const pb = state.playback;
    if (pb.repeat === 'one') {
      audioService.seek(0);
      void audioService.resume().catch(lifetime.guard(() => {}));
      return;
    }
    // Whatever happens next, the track that just played is over: leave the
    // transport reading complete instead of frozen wherever the page last looked.
    if (duration > 0) setState('playback', 'currentTime', duration);
    listeningLearning.complete(pb.currentTrack, duration);
    if (pb.index < pb.queue.length - 1 || pb.repeat === 'all') {
      if (state.autoMode.active) ports.promotePreparedAutoSuccessor();
      const successor = ports.nextEntry();
      if (successor && !trackPrepared(successor)) {
        ports.prefetchUpcoming();
        ports.enterStarved();
        return;
      }
      ports.actions.next('ended');
      return;
    }
    const continuousIntent = pb.radioMode ? 'radio' : state.autoMode.active ? 'auto_mode' : null;
    if (!continuousIntent && !pb.autoplayEnabled) {
      // The listener turned continuous play off: the end of the queue is the end,
      // and saying "finding more music" would be a lie.
      setState('playback', {
        isPlaying: false,
        isLoading: false,
        phase: 'paused'
      });
      return;
    }
    const endedQueueId = pb.queue[pb.index]?.queueId;
    const extend = continuousIntent ? ports.generatedQueue?.refillNow() ?? Promise.resolve(false) : ports.ensureAutoplay(true);
    ports.enterStarved();
    void extend.then(lifetime.guard(ready => {
      const current = state.playback.queue[state.playback.index];
      if (state.playback.phase !== 'starved' || current?.queueId !== endedQueueId) return;
      if (continuousIntent && ports.generatedQueue?.activeIntent() !== continuousIntent) return;
      if (ready && state.playback.index < state.playback.queue.length - 1) ports.resumeFromStarved();
    }));
  }
  const listeningLearning = new ListeningLearning((event, payload) => {
    void api.emitDiscoveryEvent(event, payload).catch(lifetime.guard(() => {}));
  });
  const domainActions = {
    playFrom(tracks: ContextTrack[], i: number, opts?: {
      radio?: boolean;
      context?: PlaybackContextDescriptor;
      shuffled?: boolean;
      preserveManual?: boolean;
    }): void {
      if (!tracks[i]) return;
      ports.discardFutureAutoplay();
      const isRadio = opts?.radio === true;
      if (!isRadio) ports.cancelPendingRadio();
      if (!isRadio && state.autoMode.active) {
        const selected = tracks[i];
        if (isPodcastTrack(selected)) {
          void ports.confirmNormalMode('podcast', () => ports.actions.playFrom(tracks, i, opts));
        } else {
          ports.mixAutoTrackNow(selected);
        }
        return;
      }
      // A new context owns the continuation from here: matches asked for the old
      // one, and whatever the idle deck was holding for it, no longer apply.
      ports.abandonContextMatches();
      if (ports.stagedEntry) {
        ports.stagedEntry = null;
        audioService.clearStaged();
      }
      const context = opts?.context ?? defaultContext(tracks);
      const source: QueueSource = isRadio ? 'radio' : contextSource(context.kind);
      const contextQueue = tracks.map((track, contextIndex) => createQueueEntry(track, 'context', source, context, contextIndex));
      const preservedManual = opts?.preserveManual === false ? [] : futureEntries(state.playback.queue, state.playback.index, 'manual');
      const queue = [...contextQueue.slice(0, i + 1), ...preservedManual, ...contextQueue.slice(i + 1)];
      setState('playback', {
        queue,
        shuffle: opts?.shuffled === true,
        radioMode: isRadio,
        radioLoading: isRadio ? state.playback.radioLoading : false,
        radioSeedId: isRadio ? tracks[i]?.id ?? null : null
      });
      loadIndex(i);
    },
    playTrack(track: Track): void {
      ports.actions.playFrom([track], 0);
    },
    playShuffled(tracks: Track[], context?: PlaybackContextDescriptor): void {
      if (tracks.length === 0) return;
      if (state.autoMode.active) {
        ports.actions.addAutoSource(tracks, context?.label || tr('autoMode.source.selection'));
        return;
      }
      ports.actions.playFrom(shuffled(tracks), 0, {
        context,
        shuffled: true
      });
    },
    togglePlay(): void {
      const pb = state.playback;
      if (!pb.currentTrack) return;
      // A failed track's transport button is a retry, not a play button — and it
      // is that whichever way the state happens to be leaning.
      if (pb.loadError) {
        vibrate();
        ports.actions.retryCurrent();
        return;
      }
      if (pb.isPlaying) ports.actions.pausePlayback();else ports.actions.resumePlayback();
    },
    resumePlayback(origin: ProgramTransportOrigin = 'ui'): void {
      const pb = state.playback;
      if (!pb.currentTrack) return;
      setState('playback', 'needsGesture', false);
      userPlaybackStartedThisSession = true;
      vibrate();
      // A failed track's transport button is a retry, not a play button.
      if (pb.loadError) {
        ports.actions.retryCurrent();
        return;
      }
      // The track this deck holds is over. Play means "carry on", not "hear that
      // one again" — and this is also the gesture a platform may have been waiting
      // for, so it is the moment to reclaim the audio session.
      if (pb.phase === 'starved') {
        audioService.unlockAudio();
        setState('playback', 'needsGesture', false);
        ports.resumeFromStarved();
        return;
      }
      if (ports.podcastSourcePending && isPodcastTrack(pb.currentTrack)) {
        loadIndex(pb.index, {
          restart: true,
          trigger: 'resume'
        });
        return;
      }
      // Paused before its match came back: the deck is still holding whatever
      // played before it, so carrying on means loading this one.
      if (unmatchedSelection && unmatchedSelection.queueId === pb.queue[pb.index]?.queueId) {
        loadIndex(pb.index, {
          restart: true,
          trigger: 'resume'
        });
        return;
      }
      // The song this deck holds played to its end and nothing took over —
      // inside DJ that is a stalled handoff, never a request to hear it again.
      if (state.autoMode.active && pb.repeat !== 'one' && audioService.snapshot().ended) {
        audioService.unlockAudio();
        if (pb.index < pb.queue.length - 1) ports.actions.next('ended');else {
          ports.enterStarved();
          void ports.ensureGeneratedQueue().refillNow();
        }
        return;
      }
      // An Auto session with nobody planning for it: the workspace was entered
      // before there was anything to plan from, or it was restored from another
      // device, which brings the route and the sources but no planner behind
      // them. Pressing play is what starts one.
      if (state.autoMode.active && ports.generatedQueue?.activeIntent() !== 'auto_mode') {
        if (state.autoMode.sources.length === 0) {
          setState('autoMode', {
            sources: [{
              id: randomId(),
              label: pb.currentTrack.title,
              tracks: [pb.currentTrack],
              activation: 1
            }],
            heard: [pb.currentTrack],
            phase: 'planning'
          });
        }
        void ports.ensureGeneratedQueue().start('auto_mode', pb.currentTrack, state.autoMode.profile);
      }
      const generation = beginLoad();
      const attempt = createPlaybackAttempt(pb.currentTrack, generation, 'resume');
      setState('playback', {
        isLoading: true,
        phase: 'loading'
      });
      void audioService.resume(origin).catch(lifetime.guard(() => onPlaybackFailed(attempt.generation, 'load')));
    },
    pausePlayback(origin: ProgramTransportOrigin = 'ui'): void {
      const pb = state.playback;
      if (!pb.currentTrack) return;
      setState('playback', 'needsGesture', false);
      beginLoad();
      vibrate();
      if (pb.loadError) return;
      if (unmatchedSelection) unmatchedSelection.paused = true;
      if (pb.phase === 'loading' || pb.phase === 'recovering') {
        cancelActiveAttempt('user_pause');
        setState('playback', {
          isPlaying: false,
          isLoading: false,
          phase: 'paused'
        });
        const previewId = pb.currentTrack.source === 'preview' && !isPendingEntry(pb.currentTrack) ? playbackYoutubeId(pb.currentTrack) : null;
        if (previewId) void api.cancelPreview(previewId).catch(lifetime.guard(() => {}));
      }
      audioService.pause(origin);
    },
    dismissPlayback(): void {
      const track = state.playback.currentTrack;
      const previewId = track?.source === 'preview' && !isPendingEntry(track) ? playbackYoutubeId(track) : null;
      userPlaybackStartedThisSession = true;
      ports.releasePreparation();
      beginLoad(); // Late load failures must not revive the dismissed session.
      cancelActiveAttempt('user_dismiss');
      unmatchedSelection = null;
      ports.abandonContextMatches();
      ports.commitSeq += 1; // Invalidate callbacks from an in-flight handoff.
      ports.actions.exitAutoMode();
      ports.generatedQueue?.stop();
      runWhenAudible = null;
      ports.stagedEntry = null;
      ports.committedTransition = null;
      consecutiveLoadFailures = 0;
      audioService.stop();
      setState('playback', {
        currentTrack: null,
        queue: [],
        index: -1,
        isPlaying: false,
        isLoading: false,
        loadError: false,
        needsGesture: false,
        previewPreparation: null,
        phase: 'idle',
        currentTime: 0,
        duration: 0,
        radioMode: false,
        radioLoading: false,
        radioSeedId: null,
        autoplayLoading: false
      });
      ports.releasePreparation();
      setState('autoMode', {
        activity: null,
        transition: {
          status: 'idle'
        }
      });
      setNowPlayingOpen(false);
      ports.updateMediaSession(null);
      ports.pushEmptyPlaybackState();
      if (previewId) void api.cancelPreview(previewId).catch(lifetime.guard(() => {}));
    },
    retryCurrent(): void {
      const pb = state.playback;
      if (!pb.currentTrack || pb.index < 0) return;
      consecutiveLoadFailures = 0;
      loadIndex(pb.index, {
        restart: true,
        trigger: 'retry',
        freshDeck: true
      });
    },
    next(trigger: PlaybackTrigger = 'next', preservePaused = false): void {
      // Every path out of here either loads a deck or does nothing; loading
      // cancels the mixer, which reports back and clears the DJ state itself.
      if (audioService.mixPhase() !== 'idle') audioService.cancelMix('load');
      const pb = state.playback;
      if (pb.queue.length === 0) return;
      if (pb.index < pb.queue.length - 1) loadIndex(pb.index + 1, {
        trigger, paused: preservePaused && !pb.isPlaying
      });else if (pb.repeat === 'all') {
        const cycle = ports.repeatCycle(pb.queue);
        if (cycle.length > 0) {
          setState('playback', {
            queue: cycle,
            index: 0
          });
          loadIndex(0, {
            trigger, paused: preservePaused && !pb.isPlaying
          });
        }
      }
    },
    prev(preservePaused = false): void {
      if (state.playback.currentTime > 3) {
        ports.actions.seek(0);
        return;
      }
      const pb = state.playback;
      if (pb.index > 0) loadIndex(pb.index - 1, { paused: preservePaused && !pb.isPlaying });else ports.actions.seek(0);
    },
    seekBy(delta: number): void {
      ports.actions.seek(audioService.snapshot().position + delta);
    },
    seek(t: number): void {
      if (!Number.isFinite(t) || ports.podcastSourcePending && state.playback.currentTrack && isPodcastTrack(state.playback.currentTrack)) return;
      const duration = audioService.snapshot().duration || state.playback.duration;
      const target = Math.max(0, duration > 0 ? Math.min(t, duration) : t);
      audioService.seek(target);
      setState('playback', 'currentTime', target);
      ports.savePodcastProgress(false, target);
      ports.pushPlaybackState();
    },
    jumpTo(i: number): void {
      loadIndex(i);
    },
    playNow(track: Track): void {
      const pb = state.playback;
      if (pb.queue.length === 0 && !state.autoMode.active) {
        ports.actions.playTrack(track);
        return;
      }
      if (pb.currentTrack && queueIndexOf([pb.currentTrack], track) === 0) {
        if (pb.isLoading || pb.isPlaying) return;
        if (pb.loadError) ports.actions.retryCurrent();else void audioService.resume();
        return;
      }
      if (state.autoMode.active) {
        if (isPodcastTrack(track)) void ports.confirmNormalMode('podcast', () => ports.actions.playNow(track));else ports.mixAutoTrackNow(track);
        return;
      }
      // Playing a song on its own is choosing what comes after it: the context
      // it interrupts does not resume, the listener's requests still play first,
      // and Autoplay follows when it is on. Asking for a song to be *added* is
      // `enqueue` / `playNext`, which keep the context.
      ports.actions.playTrack(track);
    },
    setVolume(v: number): void {
      const clamped = Math.min(1, Math.max(0, v));
      audioService.setVolume(clamped);
      setState('playback', 'volume', clamped);
      if (state.playback.muted && clamped > 0) {
        audioService.setMuted(false);
        setState('playback', 'muted', false);
      }
    },
    toggleMute(): void {
      const muted = !state.playback.muted;
      audioService.setMuted(muted);
      setState('playback', 'muted', muted);
    },
    cycleRepeat(): void {
      const next: RepeatMode = state.playback.repeat === 'off' ? 'all' : state.playback.repeat === 'all' ? 'one' : 'off';
      if (next !== 'off') ports.discardFutureAutoplay();
      setState('playback', 'repeat', next);
      if (next === 'off') queueMicrotask(() => void ports.ensureAutoplay());
    },
    async setVolumeLeveling(enabled: boolean): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const previous = state.playback.volumeLeveling;
      if (enabled === previous) return true;
      applyVolumeLeveling(enabled);
      try {
        await api.setVolumeLeveling(enabled);
        if (!isCurrent()) {
          return false;
        }
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        applyVolumeLeveling(previous);
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    },
    async setDjMixing(enabled: boolean): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const previous = state.playback.djMixing;
      if (enabled === previous) return true;
      applyDjMixing(enabled);
      try {
        await api.setDjMixing(enabled);
        if (!isCurrent()) {
          return false;
        }
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        applyDjMixing(previous);
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    }
  };
  return {
    dispose() {
      ++loadGeneration;
      activeAttempt = null;
      runWhenAudible = null;
      clearStallTimer();
    },
    actions: domainActions,
    get runWhenAudible() {
      return runWhenAudible;
    },
    set runWhenAudible(value: (() => void) | null) {
      runWhenAudible = value;
    },
    trackPrepared,
    trackUrl,
    levelFor,
    emitPlaybackEvent,
    cancelActiveAttempt,
    loadIndex,
    get activeAttempt() {
      return activeAttempt;
    },
    set activeAttempt(value: PlaybackAttempt | null) {
      activeAttempt = value;
    },
    get userPlaybackStartedThisSession() {
      return userPlaybackStartedThisSession;
    },
    set userPlaybackStartedThisSession(value: boolean) {
      userPlaybackStartedThisSession = value;
    },
    get beginLoad() {
      return beginLoad;
    },
    createPlaybackAttempt,
    get loadGeneration() {
      return loadGeneration;
    },
    set loadGeneration(value: number) {
      loadGeneration = value;
    },
    onPlaybackFailed,
    get unmatchedSelection() {
      return unmatchedSelection;
    },
    set unmatchedSelection(value: {
      queueId: string;
      paused: boolean;
    } | null) {
      unmatchedSelection = value;
    },
    get listeningLearning() {
      return listeningLearning;
    },
    concludeAttempt,
    removeTrackReferences,
    restorePlaybackSnapshot,
    applyVolumeLeveling,
    applyDjMixing,
    clearStallTimer,
    onEnded,
    scheduleStallRecovery,
    get STARTUP_RECOVERY_MS() {
      return STARTUP_RECOVERY_MS;
    },
    get STALL_RECOVERY_MS() {
      return STALL_RECOVERY_MS;
    },
    get consecutiveLoadFailures() {
      return consecutiveLoadFailures;
    },
    set consecutiveLoadFailures(value: number) {
      consecutiveLoadFailures = value;
    },
    flushWhenAudible,
    emitAttempt,
    get loudnessAsked() {
      return loudnessAsked;
    }
  };
}
