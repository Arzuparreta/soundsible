import { Lifetime } from '../lib/lifetime';

import { api, type PreviewPreparation } from '../lib/api';
import { audioService } from '../lib/audio';
import { ProgramMediaSession, type MediaSessionSyncReason } from '../lib/mediaSession';
import { streamUrl, previewUrl, podcastStreamUrl, playbackYoutubeId } from '../lib/media';
import { prefetchPreviews, previewPreparation, previewPreparationState, upcomingPreviewIds } from '../lib/prefetch';
import { toast } from '../lib/toast';

import { isPodcastTrack } from '../lib/track';
import { queueIdentity } from '../lib/queueDiscovery';

import { GeneratedQueueController } from '../lib/generatedQueue';

import { t as tr } from '../lib/i18n';

import { futureEntries, type PlaybackQueueEntry } from '../lib/playbackQueue';

import type { Track } from '../types/music';

import { levelFor as levelForTrack } from '../lib/loudness';

import { state, setState, randomId, VOLUME_LEVELING_KEY } from './core';

export type PlaybackTrigger = 'selection' | 'next' | 'ended' | 'retry' | 'resume' | 'recovery' | 'podcast';
export type PlaybackSourceKind = 'local' | 'preview' | 'podcast';
export interface PlaybackAttempt {
  id: string;
  trackId: string;
  sourceKind: PlaybackSourceKind;
  trigger: PlaybackTrigger;
  queueLane: string;
  startedAt: number;
  loadedMetadataAt: number | null;
  canPlayAt: number | null;
  audibleAt: number | null;
  /** When the current buffering spell began, or null between spells. */
  bufferStartedAt: number | null;
  /**
   * Buffering before the first sound, and buffering after it, kept apart.
   *
   * They used to be one counter reported on `ui_click_to_playing`, which fires at
   * the moment of first sound — so the only spell it could ever contain was the
   * opening one, which every cold start has. It read 1 on 56 of 58 plays before
   * the chunk change and 8 of 9 after, and a metric that cannot move is not
   * measuring anything. The opening wait is already `click_to_playing_ms`; what
   * `rebuffer` counts is playback that was running and stopped, which is the only
   * one of the two that means delivery failed.
   */
  startupStallMs: number;
  rebufferCount: number;
  rebufferMs: number;
  /**
   * Rebuffers that follow a seek the listener asked for.
   *
   * Dragging the scrubber into un-buffered audio stops the sound, and the element
   * reports that the same way it reports a stream that died. One is the listener
   * getting what they asked for and the other is a fault, so they are counted
   * apart rather than summed into a number that flatters or damns the change
   * depending on how much anyone scrubbed that day.
   */
  seekRebufferCount: number;
  seekPending: boolean;
  /** Times this attempt's stall timer found the deck still fetching and waited
   * again instead of reloading it. See `scheduleStallRecovery`. */
  stallReprieves: number;
  /** Last server spool position observed by startup supervision. */
  spoolBytes: number;
  recoveryCount: number;
  reportedRecoveryCount: number;
  concluded: boolean;
  generation: number;
}

export interface TransportHost {
  onPreviewPreparation: (videoId: string, status: PreviewPreparation) => void;
  generatedQueue: GeneratedQueueController | null;
  AUTOPLAY_PREPARE_THRESHOLD: number;
  AUTOPLAY_REFILL_THRESHOLD: number;
  AUTOPLAY_TARGET: number;
  ensureGeneratedQueue: () => GeneratedQueueController;
  userPlaybackStartedThisSession: boolean;
  actions: {
    next: (trigger?: PlaybackTrigger) => void;
  };
}

export function createTransport(host: TransportHost) {
  const lifetime = new Lifetime();

  const STALL_RECOVERY_MS = 3000;
  const STARTUP_RECOVERY_MS = 12000;
  /** How many times a startup that is still fetching may be given another
   * interval before it is treated as dead anyway. Bounded so a link slow enough
   * to never finish still fails visibly rather than spinning forever. */
  const MAX_PROGRESS_REPRIEVES = 3;
  let activeAttempt: PlaybackAttempt | null = null;
  let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  /** What the deck had buffered when the current stall timer was armed. */
  let stallBufferedEnd = 0;

  function playbackSourceKind(track: Track): PlaybackSourceKind {
    if (isPodcastTrack(track)) return 'podcast';
    return track.source === 'preview' ? 'preview' : 'local';
  }

  /** Where this entry's audio comes from. Stable per track — see `streamUrl`:
   * the URL is the browser's cache key, so it may not carry anything that
   * changes from one play to the next. */
  function trackUrl(track: Track): string {
    const previewId = playbackYoutubeId(track);
    return track.source === 'preview' && previewId
      ? previewUrl(previewId)
      : streamUrl(track.id);
  }

  /** A local file is already station-owned. An internet preview is viable for an
   * unattended boundary only after the engine confirms a complete disk copy. */
  function trackPrepared(track: Track): boolean {
    if (track.source !== 'preview' || isPodcastTrack(track)) return true;
    const videoId = playbackYoutubeId(track);
    return !!videoId && previewPreparationState?.(videoId) === 'ready';
  }

  /**
   * The volume levelling for one queue entry, as a linear gain.
   *
   * Always `1` unless there is a measurement to stand on: an unmeasured track, a
   * preview, a podcast or the setting switched off all play exactly as they
   * always did.
   *
   * The library lookup matters. A queue entry is a snapshot taken by
   * `createQueueEntry` when the track was enqueued, so a song measured *after*
   * that carries the numbers only on the library copy. Only unmeasured entries
   * pay for the search.
   */
  function measuredTrack<T extends Track>(entry: T): T | Track {
    return entry.loudness_lufs == null
      ? state.library.find((track) => track.id === entry.id) ?? entry
      : entry;
  }

  function levelFor(entry: PlaybackQueueEntry | Track | null | undefined): number {
    if (!entry || !state.playback.volumeLeveling) return 1;
    const facts = measuredTrack(entry);
    const context = (entry as PlaybackQueueEntry).queueContext;
    // Resolved through the library like the entry itself. Without this an album
    // queued before the sweep reached it would look wholly unmeasured, and album
    // levelling would silently never engage.
    const siblings = context?.kind === 'album'
      ? state.playback.queue
          .filter((item) => item.queueContext?.id === context.id)
          .map(measuredTrack)
      : undefined;
    return levelForTrack(facts, {
      enabled: true,
      shuffle: state.playback.shuffle,
      siblings,
      contextKind: context?.kind ?? null,
      contextId: context?.id ?? null,
    });
  }

  /**
   * Apply the levelling preference everywhere it is remembered, and re-level both
   * decks so the change is heard now rather than at the next track.
   *
   * The only place a sounding deck's gain is allowed to move — because it is the
   * listener asking for it — and the mixer ramps rather than steps it.
   */
  function applyVolumeLeveling(enabled: boolean): void {
    setState('playback', 'volumeLeveling', enabled);
    try {
      localStorage.setItem(VOLUME_LEVELING_KEY, enabled ? 'on' : 'off');
    } catch {
      /* private mode / storage disabled */
    }
    audioService.setLevelingEnabled(enabled);
  }

  /** Ids already sent to the engine. Cleared when it announces new measurements. */
  const loudnessAsked = new Set<string>();

  /** Ask the engine to measure what is coming up, so the next few songs are
   * levelled even on a library the sweep has not reached yet. Fire and forget:
   * playback never waits on it, and a late answer applies from the next track. */
  function requestUpcomingLoudness(fromIndex: number): void {
    if (!state.playback.volumeLeveling) return;
    const ids = state.playback.queue
      .slice(fromIndex, fromIndex + 5)
      // Through the library, not the queue entry. An entry is a snapshot taken
      // when the track was enqueued, so a song measured since then still looks
      // unmeasured here — and asking again for something the engine has already
      // answered is work nobody is waiting for.
      .filter(
        (entry) =>
          measuredTrack(entry).loudness_lufs == null
          && entry.source !== 'preview'
          && !isPodcastTrack(entry)
          && !loudnessAsked.has(entry.id),
      )
      .map((entry) => entry.id);
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

  function emitAttempt(
    attempt: PlaybackAttempt,
    phase: string,
    terminalState: string,
    extra: Record<string, number | boolean> = {},
    failureReason?: string,
  ): void {
    void api
      .sendPlayTiming({
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
        segments: extra,
      })
      .catch(() => {});
  }

  /**
   * Report a playback event that is not tied to a load attempt.
   *
   * `emitAttempt` needs one and most of these do not have one: a queue that ran
   * dry, an audio graph that stopped sounding, a page that came back from being
   * frozen. They go to the same place, so a drive that went wrong can be read back
   * afterwards instead of reconstructed from memory.
   */
  function emitPlaybackEvent(
    phase: string,
    extra: Record<string, number | boolean> = {},
    strings: {
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
    } = {},
  ): void {
    void api
      .sendPlayTiming({
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
        segments: { graph: audioService.graphReady(), ...extra },
        ...strings,
      })
      .catch(() => {});
  }

  /**
   * Close the books on a play that made a sound.
   *
   * `ui_click_to_playing` can only ever describe the start, because it is emitted at
   * the start. Whether the music then kept playing is a different question and it has
   * to be asked at a different time, which is here: once per audible attempt, however
   * it ended. An attempt that never sounded has nothing to report that
   * `ui_attempt_failed` and `ui_attempt_cancelled` do not already carry.
   */
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
      recovery_count: attempt.recoveryCount,
    });
  }

  function cancelActiveAttempt(reason = 'superseded'): void {
    clearStallTimer();
    const attempt = activeAttempt;
    if (!attempt) return;
    if (attempt.audibleAt === null) {
      emitAttempt(
        attempt,
        'ui_attempt_cancelled',
        'cancelled',
        { elapsed_ms: Math.round(performance.now() - attempt.startedAt) },
        reason,
      );
    } else {
      concludeAttempt(attempt, reason);
    }
    activeAttempt = null;
  }

  function createPlaybackAttempt(
    track: Track,
    generation: number,
    trigger: PlaybackTrigger,
    id = randomId(),
  ): PlaybackAttempt {
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
      generation,
    };
    activeAttempt = attempt;
    return attempt;
  }

  /**
   * The queue `actions.next` rebuilds when `repeat: 'all'` wraps.
   *
   * Shared so that the deck being warmed for the wrap and the track actually
   * played at it cannot disagree — staging a first entry that `next` then filters
   * out is worse than not staging at all.
   */
  function repeatCycle(queue: PlaybackQueueEntry[]): PlaybackQueueEntry[] {
    return queue.filter((entry) => entry.queueLane !== 'manual' && entry.queueSource !== 'autoplay');
  }

  /** Warm the tracks `actions.next` would reach so track changes start instantly.
   * Shuffle writes its chosen order into the queue, so its successors are just as
   * knowable — and just as important to prepare — as a linear context. */
  function prefetchUpcoming(): void {
    const pb = state.playback;
    // Acquisition may start here, but staging waits for the current track's
    // `playing` event and for the engine's complete-file readiness verdict.
    const ids = upcomingPreviewIds(pb.queue, pb.index, pb.repeat === 'all', 5);
    // Every unattended context needs alternatives, not one optimistic URL. The
    // download lane is serial, so this builds a small verified runway in order.
    const downloadCount = 3;
    const downloads = ids.slice(0, downloadCount);
    if (downloads.length > 0) {
      prefetchPreviews(downloads, { download: true, onStatus: host.onPreviewPreparation });
    }
    const warmOnly = ids.slice(downloadCount);
    if (warmOnly.length > 0) prefetchPreviews(warmOnly);
  }

  /**
   * Keep the next track loaded on the idle deck.
   *
   * Warming the HTTP cache is not enough: what makes `ended` able to continue
   * without touching the network — and what a phone with its screen off will
   * actually allow — is an element that is already holding the stream. On a locked
   * iPhone it is the *only* continuation that works: iOS keeps a backgrounded page
   * alive while a media element is sounding, so the moment a track ends with
   * nothing else playing, the page freezes and a request for the next one never
   * comes back.
   *
   * Shuffle is not an exception. `toggleShuffle` and `playShuffled` write the
   * random order into the queue itself and `actions.next` always takes the entry
   * after this one, so there is nothing to guess — the old guard here was reading
   * an arrangement the player stopped using.
   */
  let stagedEntry: { queueId: string; attemptId: string; url: string } | null = null;

  /** What `actions.next` will play, or undefined when nothing can be known ahead:
   * `repeat: 'one'` is handled in `onEnded` without ever reaching a load. */
  function nextEntry(): PlaybackQueueEntry | undefined {
    const pb = state.playback;
    if (pb.repeat === 'one' || pb.queue.length === 0) return undefined;
    if (pb.index < pb.queue.length - 1) return pb.queue[pb.index + 1];
    return pb.repeat === 'all' ? repeatCycle(pb.queue)[0] : undefined;
  }

  function stageNext(): void {
    // A DJ handoff owns the idle deck: it loads the incoming track there itself,
    // cued to its own in-point, and staging would fetch the same stream twice and
    // lose the race. Only once there *is* a plan, though — Auto Mode without one
    // has an ordinary track change to make, and used to make it over the network.
    if (audioService.mixPhase() !== 'idle') return;
    const next = nextEntry();
    if (state.autoMode.active && next && state.autoMode.plan[next.queueId]) return;
    if (!next || isPodcastTrack(next)) {
      stagedEntry = null;
      audioService.clearStaged();
      return;
    }
    if (!trackPrepared(next)) {
      stagedEntry = null;
      audioService.clearStaged();
      const videoId = playbackYoutubeId(next);
      if (videoId) prefetchPreviews([videoId], { download: true, onStatus: host.onPreviewPreparation });
      return;
    }
    if (stagedEntry?.queueId === next.queueId) return;
    // Minted here rather than at playback so a handoff reports the same attempt
    // the deck was cued under. It identifies the attempt in telemetry only — it
    // is deliberately not in the URL, which has to stay cacheable.
    const attemptId = randomId();
    stagedEntry = { queueId: next.queueId, attemptId, url: trackUrl(next) };
    audioService.stage(stagedEntry.url, levelFor(next));
  }

  function discardFutureAutoplay(): void {
    host.generatedQueue?.stop('autoplay');
    const pb = state.playback;
    const queue = pb.queue.filter(
      (entry, index) => index <= pb.index || !(entry.queueLane === 'generated' && entry.queueSource === 'autoplay'),
    );
    setState('playback', { queue, autoplayLoading: false });
  }

  function cancelPendingRadio(): void {
    host.generatedQueue?.stop('radio');
  }

  /**
   * Keep a small final lane of similar music warm. The shared generated-queue
   * coordinator owns cancellation and asks the same server planner as Radio and
   * Auto Mode; this gate only decides when invisible Autoplay is allowed to run.
   */
  async function ensureAutoplay(force = false): Promise<boolean> {
    const pb = state.playback;
    const current = pb.currentTrack;
    if (
      !pb.autoplayEnabled ||
      !current ||
      isPodcastTrack(current) ||
      pb.radioMode ||
      state.autoMode.active ||
      pb.repeat !== 'off'
    ) {
      return false;
    }

    const upcoming = futureEntries(pb.queue, pb.index);
    const generated = upcoming.filter(
      (entry) => entry.queueLane === 'generated' && entry.queueSource === 'autoplay',
    );
    const deterministic = upcoming.filter(
      (entry) => !(entry.queueLane === 'generated' && entry.queueSource === 'autoplay'),
    );
    if (!force && deterministic.length > host.AUTOPLAY_PREPARE_THRESHOLD) return false;
    if (!force && generated.length >= host.AUTOPLAY_REFILL_THRESHOLD) return false;

    const seed = generated.at(-1) ?? deterministic.at(-1) ?? current;
    if (generated.length >= host.AUTOPLAY_TARGET) return true;
    return host.ensureGeneratedQueue().ensureAutoplay(seed, force);
  }

  const programMediaSession = new ProgramMediaSession();

  /** Publish metadata, position and transport from one canonical programme read. */
  function updateMediaSession(
    track: Track | null,
    reason: MediaSessionSyncReason = 'track',
    forceMetadata = false,
  ): void {
    programMediaSession.sync(track, audioService.snapshot(), reason, forceMetadata);
  }

  function updatePositionState(reason: MediaSessionSyncReason = 'position'): void {
    updateMediaSession(state.playback.currentTrack, reason);
  }

  /** Fallback jump for the OS skip buttons, when the platform names no offset of
   * its own. Podcast listeners expect a bigger hop than music listeners — a 10s
   * nudge through a two-hour episode is useless — and a bigger one forward (skip
   * the ad) than back (catch the sentence you missed). */
  function osSeekStep(direction: 'forward' | 'backward'): number {
    const track = state.playback.currentTrack;
    if (track && isPodcastTrack(track)) return direction === 'forward' ? 30 : 15;
    return 10;
  }

  /**
   * Load + play the queue entry at index `i`. Computes the stream URL by source.
   *
   * Idempotent by default: asking for the entry that is already active is a no-op
   * (or a resume, if it was paused) rather than a second request and a restart
   * from 0:00. That is what makes drumming on a row harmless — a preview click
   * costs the engine a yt-dlp resolution and a proxied stream, and the first tap
   * has already paid for both. Pass `restart` for the deliberate replay.
   */
  function loadIndex(
    i: number,
    opts: { restart?: boolean; trigger?: PlaybackTrigger; freshDeck?: boolean } = {},
  ): void {
    const track = state.playback.queue[i];
    if (!track) return;
    const pb = state.playback;
    if (!opts.restart && !pb.loadError && i === pb.index && pb.currentTrack?.id === track.id) {
      if (pb.isLoading || pb.isPlaying) return; // already on its way / already sounding
      void audioService.resume().catch(() => {});
      return;
    }
    if (state.autoMode.active) {
      const identity = queueIdentity(track);
      if (!state.autoMode.heard.some((heard) => queueIdentity(heard) === identity)) {
        setState('autoMode', 'heard', (heard) => [...heard, track].slice(-40));
      }
    }
    host.userPlaybackStartedThisSession = true;
    const generation = beginLoad();
    // A deck already holding this exact stream takes over without a request and
    // without an `src` assignment. From `ended` that keeps the handover inside the
    // media event, which is what lets it continue at all on a locked phone.
    // Computed once and shared by both paths, so a handoff and a fresh load can
    // never disagree about how loud this track should be.
    const level = levelFor(track);
    const staged = stagedEntry?.queueId === track.queueId
      ? audioService.takeStaged(stagedEntry.url, level)
      : null;
    createPlaybackAttempt(
      track,
      generation,
      opts.trigger ?? 'selection',
      staged ? stagedEntry!.attemptId : undefined,
    );
    if (staged) stagedEntry = null;
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
      duration: staged ? audioService.snapshot().duration : 0,
    });
    updateMediaSession(track);
    const previewId = track.source === 'preview' ? playbackYoutubeId(track) : null;
    if (previewId) {
      prefetchPreviews([previewId], { download: true, onStatus: host.onPreviewPreparation });
    }
    const start = staged
      ?? (opts.freshDeck
        ? audioService.recover(trackUrl(track), 0, level)
        : audioService.load(trackUrl(track), level));
    void Promise.resolve(start)
      .catch(() => onPlaybackFailed(generation, 'load'));
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
      prefetchUpcoming();
      // The live index, not the one this load was for: by the time a track is
      // audible it is the current one, and a captured index would look ahead from
      // wherever a superseded attempt happened to be.
      requestUpcomingLoudness(state.playback.index);
    };
    // Queue *depth*, on the other hand, cannot wait on audio: a lane that runs dry
    // because the track before it failed to start is the one case where refilling
    // matters most.
    queueMicrotask(() => {
      void ensureAutoplay();
      if (state.playback.radioMode || state.autoMode.active) {
        void host.generatedQueue?.ensureRunway();
      }
    });
  }

  /** Lookahead work deferred until the current track is actually sounding. */
  let runWhenAudible: (() => void) | null = null;

  function flushWhenAudible(): void {
    const work = runWhenAudible;
    runWhenAudible = null;
    work?.();
  }

  /**
   * Which load attempt the store is currently on.
   *
   * A failed load reports itself twice — `play()` rejects *and* the element fires
   * `error` — so without a generation the second report would land after the first
   * already advanced the queue, and blame the innocent track that just started.
   * Claim a generation per attempt; the first report to arrive retires it and the
   * duplicate is ignored.
   */
  let loadGeneration = 0;
  const beginLoad = (): number => ++loadGeneration;

  /** Consecutive unplayable tracks, so a broken stretch of the queue skips
   * forward a few entries and then stops instead of racing to the end. */
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
      if (attempt.audibleAt === null) attempt.startupStallMs += spell;
      else attempt.rebufferMs += spell;
      attempt.bufferStartedAt = null;
    }
    const generation = beginLoad();
    attempt.generation = generation;
    setState('playback', {
      isPlaying: true,
      isLoading: true,
      loadError: false,
      phase: 'recovering',
    });
    emitAttempt(
      attempt,
      'ui_recovery_started',
      'recovering',
      {
        recovery_count: attempt.recoveryCount,
        position_ms: Math.round((state.playback.currentTime || 0) * 1000),
      },
      reason,
    );
    const position = state.playback.currentTime || 0;
    const recovery = attempt.sourceKind === 'podcast' && track.podcast_enclosure_url
      ? api
          .podcastPeek(track.podcast_enclosure_url)
          .then(({ stream_token }) => {
            if (!stream_token) throw new Error('no podcast stream token');
            return audioService.recover(podcastStreamUrl(stream_token), position, 1);
          })
      : audioService.recover(trackUrl(track), position, levelFor(track));
    void recovery.catch(() => onPlaybackFailed(generation, reason));
    scheduleStallRecovery(STARTUP_RECOVERY_MS);
    return true;
  }

  function scheduleStallRecovery(delayMs = STALL_RECOVERY_MS): void {
    clearStallTimer();
    const attempt = activeAttempt;
    if (!attempt) return;
    const bufferedAtArm = audioService.bufferedEnd();
    stallBufferedEnd = bufferedAtArm;
    stallRecoveryTimer = lifetime.timeout(() => {
      stallRecoveryTimer = null;
      if (
        activeAttempt !== attempt
        || !['loading', 'recovering', 'buffering'].includes(state.playback.phase)
      ) return;
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
      if (
        prep
        && (prep.state === 'pending' || prep.state === 'streamable')
        && spoolBytes > attempt.spoolBytes
      ) {
        attempt.spoolBytes = spoolBytes;
        scheduleStallRecovery(delayMs);
        return;
      }
      if (!recoverCurrent('stall')) onPlaybackFailed(attempt.generation, 'stall');
    }, delayMs);
  }

  /** The current track cannot be played: surface it, then move on if that is the
   * sane thing to do. Silence with a dead play button was the old behaviour. */
  function onPlaybackFailed(
    generation: number,
    reason = 'media_error',
    media: Record<string, number | boolean> = {},
  ): void {
    if (generation !== loadGeneration) return; // a later attempt already took over
    if (recoverCurrent(reason === 'stall' ? 'stall' : reason === 'load' ? 'load' : 'error')) return;
    loadGeneration += 1; // retire this attempt: further reports for it are stale
    const pb = state.playback;
    const attempt = activeAttempt;
    clearStallTimer();
    if (attempt) {
      emitAttempt(
        attempt,
        'ui_attempt_failed',
        'failed',
        {
          elapsed_ms: Math.round(performance.now() - attempt.startedAt),
          startup_stall_ms: Math.round(attempt.startupStallMs),
          rebuffer_count: attempt.rebufferCount,
          rebuffer_ms: Math.round(attempt.rebufferMs),
          recovery_count: attempt.recoveryCount,
          resource_generation: generation,
          runway_ready_depth: futureEntries(pb.queue, pb.index).slice(0, 3).filter(trackPrepared).length,
          ...media,
        },
        reason,
      );
      // A failure after the music had started is still a play, and one that ended
      // badly is the most worth counting. `concludeAttempt` no-ops on an attempt
      // that never sounded, which is what the event above already covers.
      concludeAttempt(attempt, 'failed');
      activeAttempt = null;
    }
    setState('playback', { isPlaying: false, isLoading: false, loadError: true, phase: 'failed' });
    if (
      attempt?.sourceKind === 'preview'
      && (attempt.trigger === 'selection' || attempt.trigger === 'retry')
    ) {
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
    const hasNext = pb.index < pb.queue.length - 1 || (pb.repeat === 'all' && pb.queue.length > 1);
    if (hasNext && consecutiveLoadFailures <= MAX_CONSECUTIVE_SKIPS) {
      toast.error(tr('toast.trackUnavailableSkipping'));
      host.actions.next();
      return;
    }
    toast.error(tr('toast.trackUnavailable'));
  }

  /** This device's session as it would be handed over right now. */

    return {
      dispose() { lifetime.dispose(); loadGeneration += 1; cancelActiveAttempt('disposed'); stagedEntry = null; runWhenAudible = null; programMediaSession.dispose(); },
      cancelActiveAttempt,
      updateMediaSession,
      get stagedEntry() { return stagedEntry; },
      set stagedEntry(value: { queueId: string; attemptId: string; url: string } | null) { stagedEntry = value; },
      loadIndex,
      trackUrl,
      levelFor,
      concludeAttempt,
      get activeAttempt() { return activeAttempt; },
      set activeAttempt(value: PlaybackAttempt | null) { activeAttempt = value; },
      prefetchUpcoming,
      trackPrepared,
      discardFutureAutoplay,
      cancelPendingRadio,
      emitPlaybackEvent,
      ensureAutoplay,
      stageNext,
      nextEntry,
      recoverCurrent,
      beginLoad,
      createPlaybackAttempt,
      onPlaybackFailed,
      get consecutiveLoadFailures() { return consecutiveLoadFailures; },
      set consecutiveLoadFailures(value: number) { consecutiveLoadFailures = value; },
      repeatCycle,
      applyVolumeLeveling,
      get programMediaSession() { return programMediaSession; },
      clearStallTimer,
      get loadGeneration() { return loadGeneration; },
      set loadGeneration(value: number) { loadGeneration = value; },
      scheduleStallRecovery,
      get STARTUP_RECOVERY_MS() { return STARTUP_RECOVERY_MS; },
      get STALL_RECOVERY_MS() { return STALL_RECOVERY_MS; },
      flushWhenAudible,
      emitAttempt,
      updatePositionState,
      osSeekStep,
      get loudnessAsked() { return loudnessAsked; },
    };
}
