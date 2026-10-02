import { Lifetime } from '../lib/lifetime';

import { api, type DjItemRef, type DjPlanResponse, type DjRouteKind, type ListeningPlanItem, type PreviewPreparation } from '../lib/api';
import { audioService, type LiveTransitionPlan, type ProgramPlaybackSnapshot, type ProgramTransportOrigin } from '../lib/audio';
import { type MediaSessionSyncReason } from '../lib/mediaSession';
import { playbackYoutubeId } from '../lib/media';
import { prefetchPreviews } from '../lib/prefetch';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';

import { isPodcastTrack } from '../lib/track';
import { queueIdentity, queueIndexOf } from '../lib/queueDiscovery';

import { GeneratedQueueController, type AutoPlanItem } from '../lib/generatedQueue';

import { t as tr } from '../lib/i18n';
import { ListeningLearning } from '../lib/listeningLearning';
import { createQueueEntry, futureEntries, type PlaybackQueueEntry } from '../lib/playbackQueue';

import type { Track } from '../types/music';

import { state, setState, randomId } from './core';

import type { PlaybackTrigger, PlaybackAttempt } from './playbackTransport';

export interface CommittedTransition {
  queueId: string;
  fromKey: string;
  toKey: string;
}

export interface DjHost {
  trackUrl: (track: Track) => string;
  listeningLearning: ListeningLearning;
  concludeAttempt: (attempt: PlaybackAttempt | null, outcome: string) => void;
  activeAttempt: PlaybackAttempt | null;
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  pushPlaybackState: (opts?: { keepalive?: boolean; body?: Parameters<typeof api.putPlaybackState>[0] }) => void;
  pendingImmediateAutoTrack: Track | null;
  generatedQueue: GeneratedQueueController | null;
  actions: {
    next: (trigger?: PlaybackTrigger) => void;
    retryCurrent: () => void;
    resumePlayback: (origin?: ProgramTransportOrigin) => void;
    exitAutoMode: () => void;
  };
  prefetchUpcoming: () => void;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
  trackPrepared: (track: Track) => boolean;
  generatedActivityId: number;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  loadIndex: (i: number, opts?: { restart?: boolean; trigger?: PlaybackTrigger; freshDeck?: boolean }) => void;
  ensureGeneratedQueue: () => GeneratedQueueController;
  planItemTrack: (item: ListeningPlanItem) => Track;
  autoReasonKey: (item: ListeningPlanItem) => string;
  autoSessionEpoch: number;
  autoOpeningAborter: AbortController | null;
  emitPlaybackEvent: (phase: string, extra?: Record<string, number | boolean>, strings?: {
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
  }) => void;
  ensureAutoplay: (force?: boolean) => Promise<boolean>;
  stageNext: () => void;
  nextEntry: () => PlaybackQueueEntry | undefined;
  stagedEntry: { queueId: string; attemptId: string; url: string } | null;
  recoverCurrent: (reason: 'load' | 'error' | 'stall') => boolean;
}

export function createDj(host: DjHost) {
  const lifetime = new Lifetime();
  /**
   * How long before the blend the next track is committed.
   *
   * At the commit point the incoming deck is loaded and cued, and the route stops
   * being editable: direction changes, requests and DJ changes from here on apply
   * to the track *after* this one. That is what a DJ does, and it is the whole
   * reason the surface can be touched mid-song without breaking the mix.
   */
  const COMMIT_LEAD_SECONDS = 45;
  /** Shortest a track may play before the DJ is allowed to mix out of it. */
  const MIN_PLAY_SECONDS = 90;
  const MIN_PLAY_FRACTION = 0.6;
  /** Below this the analysis is a structural guess, not measured features. */
  const TRUSTED_CONFIDENCE = 0.35;

  /** Cleared explicitly, field by field: a store update merges, so `{ status:
   * 'idle' }` alone would leave the finished mix's technique and cue behind for
   * the readout to keep showing. */
  const IDLE_TRANSITION = {
    status: 'idle',
    technique: undefined,
    nextTrackId: undefined,
    at: undefined,
  } as const;

  /**
   * Automatic handoffs that fail back to back, so a station-wide upstream
   * outage cannot burn through the whole route in an instant.
   *
   * A dead candidate is dropped and the next one tried immediately — that is
   * the point of the runway. But `evaluateDjRunway` re-fires on every
   * `timeupdate`, several times a second, and nothing before this stopped it
   * re-arming the very next candidate the moment one failed. An upstream outage
   * fails every candidate the same way, so that loop cleared an entire
   * pre-planned route — eight songs, none of which ever sounded — before the
   * listener could react. After `MAX_CONSECUTIVE_AUTO_HANDOFF_FAILURES` in a
   * row, automatic attempts pause for `AUTO_HANDOFF_COOLDOWN_MS` (the backend's
   * own upstream backoff window) while the current track keeps playing
   * undisturbed; a listener-requested skip (`autoSkip`) is never gated by this
   * — only the automatic path is.
   */
  const MAX_CONSECUTIVE_AUTO_HANDOFF_FAILURES = 2;
  const AUTO_HANDOFF_COOLDOWN_MS = 30_000;
  let autoHandoffFailures = 0;
  let autoHandoffCooldownUntil = 0;

  let committedTransition: CommittedTransition | null = null;
  /** Claim on the commitment. Arming a transition cancels whatever was armed
   * before, and that cancellation reports back — so every callback has to be able
   * to tell whether it is still the one in charge, or the ghost of the handoff it
   * just replaced. */
  let commitSeq = 0;

  /** Duration of what is actually loaded, preferring the media element over the
   * catalogue metadata — a plan clamped against a wrong duration is exactly how a
   * cue lands in the middle of a song. */
  function playingDuration(): number {
    const duration = audioService.snapshot().duration;
    if (Number.isFinite(duration) && duration > 0) return duration;
    const declared = state.playback.currentTrack?.duration ?? 0;
    return Number.isFinite(declared) && declared > 0 ? declared : 0;
  }

  /**
   * Turn a planned transition into one that is safe to perform *right now*.
   *
   * Every rule here exists because its absence produced an audible failure:
   *
   * - a cue is only honoured when it was planned out of the track that is
   *   playing (`fromKey`), otherwise it belongs to a different timeline;
   * - the cue is clamped into the real duration, so a missing or zero `out_cue`
   *   becomes an end-of-track fade instead of a mix at 0:00;
   * - a track always gets a minimum airing before the DJ may leave it;
   * - a low-confidence analysis is never beatmatched, only faded.
   *
   * The result is that a bad plan degrades to a plain fade. It never cuts.
   */
  function resolveTransition(
    fromKey: string,
    duration: number,
    item: AutoPlanItem | undefined,
  ): LiveTransitionPlan | null {
    if (!Number.isFinite(duration) || duration <= 4) return null;
    const chained = item?.fromKey === fromKey ? item.transition : undefined;
    const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
    const requested = chained?.overlap_seconds ?? 6;
    const overlap = Math.max(1.5, Math.min(trusted ? requested : Math.min(requested, 6), duration * 0.25));
    const latest = duration - overlap - 1;
    if (latest <= 0) return null;
    const earliest = Math.min(Math.min(MIN_PLAY_SECONDS, duration * MIN_PLAY_FRACTION), latest);
    const proposed = chained && Number.isFinite(chained.out_cue) && (chained.out_cue ?? 0) > 0
      ? Number(chained.out_cue)
      : latest;
    return {
      technique: trusted ? chained!.technique : 'safe_fade',
      out_cue: Math.min(latest, Math.max(earliest, proposed)),
      in_cue: trusted ? chained!.in_cue : 0,
      overlap_seconds: overlap,
      overlap_bars: chained?.overlap_bars ?? 0,
      playback_rate: trusted ? chained!.playback_rate : 1,
      confidence: chained?.confidence ?? 0,
    };
  }

  /** Hand the runway over to the mixer and freeze it there. */
  function commitTransition(
    next: PlaybackQueueEntry,
    fromKey: string,
    plan: LiveTransitionPlan,
    manual: boolean,
  ): void {
    const toKey = queueIdentity(next);
    const outgoing = state.playback.currentTrack;
    const outgoingDuration = playingDuration();
    const token = ++commitSeq;
    const owns = () => commitSeq === token;
    committedTransition = { queueId: next.queueId, fromKey, toKey };
    setState('autoMode', 'transition', {
      status: 'armed',
      technique: plan.technique,
      nextTrackId: toKey,
      at: manual ? state.playback.currentTime : plan.out_cue,
    });
    audioService.armTransition(host.trackUrl(next), plan, {
      onDominant: () => {
        if (!owns()) return;
        autoHandoffFailures = 0;
        if (!manual) host.listeningLearning.complete(outgoing, outgoingDuration);
        const queue = state.playback.queue;
        const index = queue.findIndex((entry) => entry.queueId === next.queueId);
        // The incoming deck is already audible; there is no undo. Follow it.
        host.concludeAttempt(host.activeAttempt, 'handoff');
        host.activeAttempt = null;
        const snapshot = audioService.snapshot();
        setState('playback', {
          currentTrack: next,
          index: index === -1 ? state.playback.index : index,
          currentTime: snapshot.position,
          duration: snapshot.duration > 0 ? snapshot.duration : next.duration ?? 0,
          isPlaying: snapshot.playing,
          isLoading: false,
          loadError: false,
          phase: 'playing',
        });
        setState('autoMode', 'transition', {
          status: 'mixing',
          technique: plan.technique,
          nextTrackId: toKey,
        });
        host.updateMediaSession(next, 'handoff_dominant', true);
        host.pushPlaybackState();
      },
      onComplete: (position) => {
        if (!owns()) return;
        committedTransition = null;
        setState('playback', { currentTime: position, duration: playingDuration() });
        setState('autoMode', 'transition', IDLE_TRANSITION);
        // `releaseDeck` paused the outgoing element immediately before this
        // callback. On iOS that element may still be the OS's chosen media
        // session, so re-assert B only after A is definitely out of the programme.
        host.updateMediaSession(state.playback.currentTrack, 'handoff_settled', true);
        const pending = host.pendingImmediateAutoTrack;
        host.pendingImmediateAutoTrack = null;
        if (state.autoMode.active && pending) {
          queueMicrotask(() => mixAutoTrackNow(pending));
        } else if (state.autoMode.active) {
          void host.generatedQueue?.ensureRunway();
        }
      },
      onCancel: () => {
        if (!owns()) return;
        committedTransition = null;
        setState('autoMode', 'transition', IDLE_TRANSITION);
      },
      onError: () => {
        if (!owns()) return;
        committedTransition = null;
        setState('autoMode', 'transition', IDLE_TRANSITION);
        const outgoingEnded = audioService.snapshot().ended;
        // `audio.ts` has deliberately kept the outgoing deck alive. Loading the
        // URL that just failed here used to throw that protection away, replace
        // the audible deck, and make Auto skip through several broken tracks in
        // silence. Drop the failed handoff and let the DJ refill the runway while
        // the current song keeps playing.
        if (!dropAutoRouteOccurrence(next.queueId)) return;
        if (outgoingEnded) {
          // `ended` deliberately left the committed handoff in charge. If its
          // incoming deck never became playable, ownership is still on the song
          // that just finished; promote another verified runway entry rather than
          // exposing the failed URL as the current 0:00 Retry track.
          if (promotePreparedAutoSuccessor()) host.actions.next('ended');
          else {
            host.prefetchUpcoming();
            enterStarved();
          }
          return;
        }
        // A listener-requested skip is always worth attempting and always worth
        // reporting on its own — it does not retry unattended, so it cannot
        // spiral, and it does not count toward or trip the breaker below.
        if (manual) {
          toast.error(tr('toast.trackUnavailableSkipping'));
          return;
        }
        autoHandoffFailures += 1;
        if (autoHandoffFailures >= MAX_CONSECUTIVE_AUTO_HANDOFF_FAILURES) {
          autoHandoffCooldownUntil = performance.now() + AUTO_HANDOFF_COOLDOWN_MS;
          toast.error(tr('toast.autoModeHandoffPaused'));
        } else {
          toast.error(tr('toast.trackUnavailableSkipping'));
        }
      },
    }, { manual, level: host.levelFor(next) });
  }

  /** How far ahead of the commit point an unmeasured transition asks to be
   * re-planned, leaving room for the answer to arrive in time to be used. */
  const REFINE_LEAD_SECONDS = 20;
  let refinedPair = '';

  function djItemRef(track: Track): DjItemRef {
    return {
      id: track.id,
      track_id: track.source === 'preview' ? undefined : track.id,
      youtube_id: track.youtube_id ?? (track.source === 'preview' ? track.id : undefined),
      source: track.source,
      title: track.title,
      artist: track.artist,
      duration: track.duration,
    };
  }

  function autoRecommendationIdentity(track: Track): string {
    if (track.recommendation?.identity) return track.recommendation.identity;
    return track.source === 'preview'
      ? `music:youtube:${track.youtube_id || track.id}`
      : `music:track:${track.id}`;
  }

  /**
   * Upgrade a conservative transition once its analysis exists.
   *
   * The planner answers instantly with a fade for anything it has not measured
   * yet. This asks again just before the handoff is committed: by then the
   * background analysis has usually landed, and the fade becomes the beatmatched
   * blend it was always meant to be. If it has not, nothing is lost — the fade
   * was already safe.
   */
  function maybeRefineTransition(current: Track, next: PlaybackQueueEntry, fromKey: string): void {
    const toKey = queueIdentity(next);
    const pair = `${fromKey}>${toKey}`;
    if (refinedPair === pair) return;
    const item = state.autoMode.plan[next.queueId];
    if (!item || item.fromKey !== fromKey) return;
    if ((item.transition?.confidence ?? 0) >= TRUSTED_CONFIDENCE) return;
    refinedPair = pair;
    void api
      .refineDjTransition({
        dj_profile: state.autoMode.djProfile,
        from: djItemRef(current),
        to: djItemRef(next),
      })
      .then((result) => {
        if (!result.measured || !state.autoMode.active) return;
        if (state.autoMode.plan[next.queueId]?.fromKey !== fromKey) return;
        setState('autoMode', 'plan', next.queueId, 'transition', result.transition);
      })
      .catch(() => {
        /* the conservative plan stands */
      });
  }

  /** Watch the runway from `timeupdate` and commit when the moment arrives. */
  function evaluateDjRunway(): void {
    if (!state.autoMode.active || committedTransition || audioService.mixPhase() !== 'idle') return;
    if (performance.now() < autoHandoffCooldownUntil) return;
    const pb = state.playback;
    const current = pb.currentTrack;
    const next = pb.queue[pb.index + 1];
    if (!current || !next || pb.loadError) return;
    if (!host.trackPrepared(next)) {
      const videoId = playbackYoutubeId(next);
      if (videoId) prefetchPreviews([videoId], { download: true });
      promotePreparedAutoSuccessor();
      return;
    }
    const fromKey = queueIdentity(current);
    const plan = resolveTransition(fromKey, playingDuration(), state.autoMode.plan[next.queueId]);
    if (!plan) return;
    if (pb.currentTime >= plan.out_cue - COMMIT_LEAD_SECONDS - REFINE_LEAD_SECONDS) {
      maybeRefineTransition(current, next, fromKey);
    }
    if (pb.currentTime < plan.out_cue - COMMIT_LEAD_SECONDS) return;
    commitTransition(next, fromKey, plan, false);
  }

  /** Index that new manual entries must land after, so they cannot displace a
   * handoff that is already loaded and cued. */
  function insertionFloor(): number {
    const pb = state.playback;
    if (!committedTransition) return pb.index;
    const committed = pb.queue.findIndex((entry) => entry.queueId === committedTransition!.queueId);
    return committed > pb.index ? committed : pb.index;
  }

  /**
   * What a repair is allowed to do with one route entry.
   *
   * A `manual` entry carries no `autoRoute` at all — `enqueue` and `playNext`
   * drop explicit requests straight into the route span — but a song asked for by
   * name is every bit as pinned as one that was dragged there, and both
   * `applyPlan` and `exitAutoMode` already treat the two alike. Classifying on
   * `autoRoute` alone would hand the planner permission to delete them.
   */
  function autoRouteKind(entry: PlaybackQueueEntry): DjRouteKind {
    if (entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user') return 'user';
    return entry.autoRoute?.kind ?? 'generated';
  }

  /** User-owned route occurrences survive a manual pivot. Generated guesses and
   * bridges belonged to the old musical path and do not. */
  function explicitAutoRunway(): PlaybackQueueEntry[] {
    return futureEntries(state.playback.queue, state.playback.index)
      .filter((entry) => autoRouteKind(entry) === 'user');
  }

  /** A song selected while DJ is driving means "mix this now", everywhere.
   *
   * The existing manual handoff is the audio primitive: it keeps the outgoing
   * deck alive until the requested media is ready and degrades to a short safe
   * fade. If two decks are already audible there is no honest three-deck cancel;
   * retain only the latest request and chain it as soon as that blend settles. */
  function mixAutoTrackNow(track: Track): void {
    if (!state.autoMode.active || isPodcastTrack(track)) return;
    const pb = state.playback;
    if (pb.currentTrack && queueIndexOf([pb.currentTrack], track) === 0) {
      if (pb.loadError) host.actions.retryCurrent();
      else if (!pb.isPlaying && !pb.isLoading) host.actions.resumePlayback();
      return;
    }
    if (audioService.mixPhase() === 'crossfading') {
      host.pendingImmediateAutoTrack = track;
      setState('autoMode', 'activity', {
        id: ++host.generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.immediateQueued',
        values: { title: track.title },
      });
      return;
    }

    host.discardFutureAutoplay();
    host.cancelPendingRadio();
    host.pendingImmediateAutoTrack = null;
    if (audioService.mixPhase() !== 'idle') audioService.cancelMix('superseded');
    const explicit = explicitAutoRunway();
    const requested = {
      ...createQueueEntry(track, 'manual', 'play_next'),
      autoRoute: { kind: 'user' as const, placement: 'dj' as const },
    };
    const current = pb.currentTrack;

    setState('autoMode', {
      heard: [...state.autoMode.heard, track].slice(-40),
      plan: {},
      staleSeams: [],
      transition: IDLE_TRANSITION,
      activity: {
        id: ++host.generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.mixingImmediate',
        values: { title: track.title },
      },
    });

    if (!current || pb.index < 0) {
      setState('playback', {
        queue: [requested, ...explicit],
        index: -1,
        radioMode: false,
        radioLoading: false,
        radioSeedId: null,
      });
      host.loadIndex(0);
      void host.ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
      return;
    }

    const prefix = pb.queue.slice(0, pb.index + 1);
    setState('playback', {
      queue: [...prefix, requested, ...explicit],
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    const fromKey = queueIdentity(current);
    commitTransition(requested, fromKey, {
      technique: 'safe_fade',
      out_cue: 0,
      in_cue: 0,
      overlap_seconds: 1.6,
      overlap_bars: 0,
      playback_rate: 1,
      confidence: 0,
    }, true);
    void host.ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
  }

  /** Apply the first route returned by a source-only DJ plan. */
  function startAutoFromSourcePlan(response: DjPlanResponse): boolean {
    if (!response.opening) return false;
    const opening = host.planItemTrack(response.opening);
    const openingEntry = {
      ...createQueueEntry(opening, 'generated', 'auto_mode'),
      autoRoute: { kind: 'generated' as const },
    };
    const candidates = response.items
      .map((item) => ({ item, track: host.planItemTrack(item) }))
      .filter(({ track }) => queueIndexOf([openingEntry], track) === -1);
    const entries = candidates.map(({ track }) => ({
      ...createQueueEntry(track, 'generated', 'auto_mode'),
      autoRoute: { kind: 'generated' as const },
    }));
    const plan: Record<string, AutoPlanItem> = {};
    let fromKey = queueIdentity(openingEntry);
    candidates.forEach(({ item }, index) => {
      const entry = entries[index];
      plan[entry.queueId] = {
        trackId: queueIdentity(entry),
        source: item.source_pool,
        reasonKey: host.autoReasonKey(item),
        reasonValues: item.source_pool === 'related' ? { title: opening.title } : undefined,
        fromKey,
        transition: item.transition,
        bpm: item.analysis?.bpm,
        key: item.analysis?.key,
        sourceSetId: item.source_set_id,
        sourceSetLabel: item.source_set_label,
        lineage: item.lineage,
      };
      fromKey = queueIdentity(entry);
    });
    setState('playback', {
      queue: [openingEntry, ...entries],
      index: -1,
      shuffle: false,
      repeat: 'off',
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    host.ensureGeneratedQueue().adopt('auto_mode', openingEntry, state.autoMode.profile, {
      sessionId: response.session_id,
      nextSegmentIndex: (response.segment_index ?? 0) + 1,
    });
    setState('autoMode', {
      heard: [opening],
      plan,
      staleSeams: [],
      phase: entries.length ? 'ready' : 'degraded',
      activity: {
        id: ++host.generatedActivityId,
        status: 'done',
        key: 'autoMode.agent.openedSource',
        values: { title: opening.title },
      },
    });
    host.loadIndex(0);
    host.prefetchUpcoming();
    return true;
  }

  async function startAutoFromSources(): Promise<void> {
    if (!state.autoMode.active || state.playback.currentTrack || state.autoMode.sources.length === 0) return;
    const sessionEpoch = host.autoSessionEpoch;
    host.autoOpeningAborter?.abort();
    const aborter = new AbortController();
    host.autoOpeningAborter = aborter;
    setState('autoMode', {
      phase: 'planning',
      activity: { id: ++host.generatedActivityId, status: 'working', key: 'autoMode.agent.openingSource' },
    });
    try {
      const response = await api.planDjQueue({
        dj_profile: state.autoMode.djProfile,
        direction: state.autoMode.direction,
        session_id: randomId(),
        segment_index: 0,
        sources: state.autoMode.sources.map(({ id, label, tracks, activation }) => ({ id, label, tracks, activation })),
        heard: [],
        exclude: state.autoMode.avoidedIdentities,
        limit: 8,
      }, aborter.signal);
      if (aborter.signal.aborted || !state.autoMode.active || sessionEpoch !== host.autoSessionEpoch || state.playback.currentTrack) return;
      if (!startAutoFromSourcePlan(response)) throw new Error('no opening');
    } catch (error) {
      if (aborter.signal.aborted) return;
      setState('autoMode', {
        phase: 'degraded',
        activity: { id: ++host.generatedActivityId, status: 'error', key: 'autoMode.agent.openingFailed' },
      });
      toast.error(tr('toast.autoModeOpeningFailed'));
    } finally {
      if (host.autoOpeningAborter === aborter) host.autoOpeningAborter = null;
    }
  }

  async function confirmNormalMode(
    kind: 'podcast' | 'radio',
    proceed: () => void | Promise<void>,
  ): Promise<void> {
    const ok = await confirmDialog({
      title: tr('modeChange.toNormalTitle'),
      message: tr(kind === 'podcast' ? 'modeChange.podcastMessage' : 'modeChange.radioMessage'),
      confirmLabel: tr(kind === 'podcast' ? 'modeChange.playPodcast' : 'modeChange.startRadio'),
    });
    if (!ok || !state.autoMode.active) return;
    host.actions.exitAutoMode();
    await proceed();
  }

  /**
   * Take one occurrence out of the route, along with any bridges the DJ built to
   * reach it — they exist only to arrive somewhere nobody is going any more.
   *
   * Returns the entry that was dropped so the caller can name it, or null when
   * the request is refused: the cued handoff is already loaded and is not
   * anybody's to remove.
   */
  function dropAutoRouteOccurrence(queueId: string): PlaybackQueueEntry | null {
    if (!state.autoMode.active || committedTransition?.queueId === queueId) return null;
    const track = state.playback.queue.find((entry) => entry.queueId === queueId);
    if (!track) return null;
    const owned = new Set(state.playback.queue
      .filter((entry) => entry.autoRoute?.kind === 'bridge' && entry.autoRoute.ownerQueueId === queueId)
      .map((entry) => entry.queueId));
    owned.add(queueId);
    setState('playback', 'queue', (queue) => queue.filter((entry) => !owned.has(entry.queueId)));
    setState('autoMode', 'plan', (plan) => Object.fromEntries(
      Object.entries(plan).filter(([id]) => !owned.has(id)),
    ));
    setState('autoMode', 'staleSeams', (seams) => seams.filter((id) => !owned.has(id)));
    void host.generatedQueue?.ensureRunway();
    return track;
  }

  /** Keep a song out of the rest of this session, undoably. Removal is the
   * caller's business; this only decides what the planner may reach for. */
  function avoidAutoIdentity(track: Track): void {
    const identity = autoRecommendationIdentity(track);
    const sessionEpoch = host.autoSessionEpoch;
    setState('autoMode', 'avoidedIdentities', (identities) => (
      identities.includes(identity) ? identities : [...identities, identity]
    ));
    toast.action(tr('autoMode.route.avoided', { title: track.title }), tr('common.undo'), () => {
      if (!state.autoMode.active || host.autoSessionEpoch !== sessionEpoch) return;
      setState('autoMode', 'avoidedIdentities', (identities) => identities.filter((value) => value !== identity));
    });
  }

  let replanTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAN_DEBOUNCE_MS = 800;

  /**
   * Rewrite the uncommitted runway after a direction change.
   *
   * Debounced and coalesced: a listener nudging three controls in a row is one
   * intention, not three replans. Nothing that is already committed is touched,
   * so the music that is playing — and the one blend that is prepared — carries
   * on undisturbed.
   */
  /**
   * What the listener just asked for, in their terms.
   *
   * The booth reports back the instruction it received, not the internal profile
   * it derived from it — "retuning to balanced" was a leftover from a control the
   * listener no longer touches, and it told them nothing about their own request.
   * A literal string is the listener's own words; a value starting with
   * `autoMode.` is translated on the way out.
   */
  let replanNote = '';

  function scheduleRunwayReplan(note: string): void {
    if (!state.autoMode.active) return;
    replanNote = note;
    if (replanTimer) lifetime.clearTimeout(replanTimer);
    setState('autoMode', {
      pendingDirection: true,
      // Answer the gesture immediately. Waiting out the debounce before saying
      // anything reads as a surface that ignored you.
      activity: {
        id: ++host.generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.heard',
        values: { note },
      },
    });
    replanTimer = lifetime.timeout(() => {
      replanTimer = null;
      setState('autoMode', 'pendingDirection', false);
      if (state.autoMode.active) void host.ensureGeneratedQueue().replan(state.autoMode.profile);
    }, REPLAN_DEBOUNCE_MS);
  }

  function cancelRunwayReplan(): void {
    if (replanTimer) lifetime.clearTimeout(replanTimer);
    replanTimer = null;
    replanNote = '';
    setState('autoMode', 'pendingDirection', false);
  }

  /**
   * How far short of the duration an `ended` is treated as a cut stream.
   *
   * A track that really finished ends within a frame of its duration. One that
   * ends thirty seconds early did not finish — the stream was cut, which over a
   * patchy mobile link is the common case, and advancing the queue there loses the
   * rest of a song the listener was in the middle of.
   */
  const PREMATURE_END_SECONDS = 3;

  /** The queue entry playback ran out on, so a late plan knows what it resumes. */
  let starvedQueueId: string | null = null;

  /**
   * Out of music, but not done.
   *
   * Everything that could bring the next track is already in flight or scheduled —
   * the generated-queue retry backoff, a reconnecting socket, the app coming back
   * to the foreground — and each of those calls `resumeFromStarved`. The old code
   * set `paused` here, which was indistinguishable from a listener pausing and so
   * nothing ever looked at it again: on a drive, one bad minute of signal ended
   * the music for the rest of the journey.
   */
  function enterStarved(): void {
    starvedQueueId = state.playback.queue[state.playback.index]?.queueId ?? null;
    setState('playback', { isPlaying: false, isLoading: false, phase: 'starved' });
    host.emitPlaybackEvent('ui_queue_starved', {
      lane_remaining: futureEntries(state.playback.queue, state.playback.index).length,
      auto_mode: state.autoMode.active,
      radio: state.playback.radioMode,
      // Starving in the foreground is a spinner; starving with the phone locked is
      // a drive that goes quiet, because the refill it waits on cannot complete.
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
    });
  }

  /** Pick the music back up if the runway has since been extended. */
  function resumeFromStarved(): void {
    if (state.playback.phase !== 'starved') return;
    const pb = state.playback;
    if (pb.queue[pb.index]?.queueId !== starvedQueueId) return;
    if (pb.index >= pb.queue.length - 1) {
      // Nothing yet. Ask again — for autoplay this is also what re-arms the
      // controller's own retry, which is otherwise only started by a failure.
      void host.ensureAutoplay(true);
      void host.generatedQueue?.refillNow();
      return;
    }
    if (state.autoMode.active) promotePreparedAutoSuccessor();
    const next = state.playback.queue[state.playback.index + 1];
    if (!next || !host.trackPrepared(next)) {
      host.prefetchUpcoming();
      return;
    }
    starvedQueueId = null;
    host.loadIndex(state.playback.index + 1, { trigger: 'ended' });
  }

  /** Inside the last minute of a track, a thin lane is refilled without waiting
   * for the track change that would otherwise have triggered it. */
  const RUNWAY_LEAD_SECONDS = 60;
  /** How often an empty lane is allowed to re-ask for music inside that minute. */
  const EMPTY_RUNWAY_RETRY_MS = 5_000;
  let runwayCheckedFor = '';
  let lastEmptyRefillAt = 0;

  /**
   * Notice a lane running out before the music does.
   *
   * Refills used to be requested only when a track *started*. If the request that
   * followed a track change failed, nothing asked again until the next track
   * change — which, at the end of the lane, never came. Riding `timeupdate` costs
   * one comparison per event and gives a thin lane a whole minute of runway to be
   * filled in, retries included.
   */
  function watchRunway(snapshot: ProgramPlaybackSnapshot): void {
    const pb = state.playback;
    const duration = snapshot.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    if (duration - snapshot.position > RUNWAY_LEAD_SECONDS) return;
    const key = pb.queue[pb.index]?.queueId ?? '';
    if (!key) return;
    // The check is latched per track, but an empty runway un-latches it: a lane
    // that was long enough a moment ago and is not any more has to be asked about
    // again, and this last minute is the only chance to fix it before `ended`
    // arrives and there is nothing to play.
    const empty = pb.index >= pb.queue.length - 1;
    if (runwayCheckedFor === key && !empty) return;
    // `timeupdate` arrives four times a second, so the un-latched case needs a
    // rate of its own or a lane that stays empty becomes a request storm.
    if (empty && Date.now() - lastEmptyRefillAt < EMPTY_RUNWAY_RETRY_MS) return;
    if (empty) lastEmptyRefillAt = Date.now();
    runwayCheckedFor = key;
    // Also re-stages: an entry that landed after this track started would not
    // otherwise be cued up on the idle deck in time to matter.
    host.stageNext();
    // Forced when the lane is actually empty. Waiting for `ended` to discover it
    // means asking the network from a page iOS has already frozen, which is how a
    // drive ends in silence — the answer arrives when the phone is unlocked.
    void host.ensureAutoplay(empty);
    if (pb.radioMode || state.autoMode.active) {
      void (empty ? host.generatedQueue?.refillNow() : host.generatedQueue?.ensureRunway());
    }
  }

  /**
   * How this track boundary is about to be crossed, as flags on `ui_track_ended`.
   *
   * The whole point of a drive is that nobody is watching it. Without this, a car
   * journey that went quiet between two songs can only be reconstructed from
   * memory; with it, every boundary says whether it was handed over from a deck
   * that already had the stream (the only continuation a locked iPhone allows),
   * blended by the DJ, fetched from the network, or met with an empty queue.
   */
  function boundaryFacts(): Record<string, boolean> {
    const next = host.nextEntry();
    return {
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      handoff_dj: audioService.mixPhase() !== 'idle',
      handoff_staged: !!next && host.stagedEntry?.queueId === next.queueId,
      starved: !next,
    };
  }

  /** Move a verified generated fallback to the next slot without jumping over a
   * listener request. Returns true when the immediate successor can play without
   * first acquiring internet bytes. */
  function promotePreparedAutoSuccessor(): boolean {
    const pb = state.playback;
    const immediate = pb.queue[pb.index + 1];
    if (!immediate) return false;
    if (host.trackPrepared(immediate)) return true;
    if (immediate.queueLane !== 'generated') return false;
    let readyIndex = -1;
    for (let index = pb.index + 2; index < pb.queue.length; index += 1) {
      const candidate = pb.queue[index];
      if (candidate.queueLane !== 'generated') break;
      if (host.trackPrepared(candidate)) {
        readyIndex = index;
        break;
      }
    }
    if (readyIndex === -1) return false;
    setState('playback', 'queue', (queue) => {
      const copy = queue.slice();
      const [ready] = copy.splice(readyIndex, 1);
      copy.splice(pb.index + 1, 0, ready);
      return copy;
    });
    return true;
  }

  /** React to the engine's acquisition verdict instead of guessing readiness
   * from an accepted job. Terminal failures remove only future occurrences and
   * preserve the lane/context ordering already encoded by the queue. */
  function onPreviewPreparation(videoId: string, status: PreviewPreparation): void {
    const pb = state.playback;
    if (pb.currentTrack && playbackYoutubeId(pb.currentTrack) === videoId) {
      setState('playback', 'previewPreparation', status);
    }
    const future = pb.queue.slice(Math.max(0, pb.index + 1));
    const matching = future.filter((entry) => playbackYoutubeId(entry) === videoId);
    if (status.state === 'unavailable' && matching.length > 0) {
      const failedIds = new Set(matching.map((entry) => entry.queueId));
      for (const entry of matching) host.generatedQueue?.exclude(entry);

      if (state.autoMode.active) {
        for (const entry of matching) {
          if (entry.queueLane === 'generated') dropAutoRouteOccurrence(entry.queueId);
        }
      }
      // Auto's route helper may already have removed generated entries and their
      // bridges. This second pass owns manual/context and non-Auto generated
      // lanes, and is intentionally occurrence-scoped.
      setState('playback', 'queue', (queue) => queue.filter((entry) => !failedIds.has(entry.queueId)));
      if (host.stagedEntry && failedIds.has(host.stagedEntry.queueId)) {
        host.stagedEntry = null;
        audioService.clearStaged();
      }
      host.emitPlaybackEvent('ui_preview_unavailable', {
        occurrences: matching.length,
        retry_after_sec: status.retry_after ?? 0,
      }, {
        video_id: videoId,
        queue_lane: matching[0]?.queueLane,
        queue_source: matching[0]?.queueSource,
      });
      if (matching.some((entry) => entry.queueLane === 'generated')) {
        void host.generatedQueue?.refillNow();
      }
      host.prefetchUpcoming();
    }
    if (status.state === 'ready') promotePreparedAutoSuccessor();
    host.stageNext();
    resumeFromStarved();
  }

  function onEnded(): void {
    // The track played to its end either way, so its delivery is reportable before
    // anything is decided about what follows.
    host.concludeAttempt(host.activeAttempt, 'ended');
    // A committed handoff owns the end of this track: the mixer starts the blend
    // off the same moment, and advancing the queue here would cancel it.
    if (audioService.mixPhase() !== 'idle') {
      host.emitPlaybackEvent('ui_track_ended', boundaryFacts());
      return;
    }
    const snapshot = audioService.snapshot();
    const duration = playingDuration();
    const position = snapshot.position;
    // The store's clock only advances while the page is awake, so after a spell
    // with the screen off it is stale. The element is the authority at this point.
    setState('playback', { currentTime: position, duration });
    const premature = duration > 0 && position < duration - PREMATURE_END_SECONDS;
    // Seconds, not milliseconds: the endpoint drops any `_ms` value over five
    // minutes, which a podcast duration passes comfortably.
    host.emitPlaybackEvent('ui_track_ended', {
      position_sec: Math.round(position),
      duration_sec: Math.round(duration),
      premature,
      ...boundaryFacts(),
    });
    if (premature && host.recoverCurrent('stall')) {
      // A cut stream, not a finished song: reload and carry on from here rather
      // than skipping the rest of it.
      host.emitPlaybackEvent('ui_premature_end', { position_sec: Math.round(position) });
      return;
    }
    const pb = state.playback;
    if (pb.repeat === 'one') {
      audioService.seek(0);
      void audioService.resume().catch(() => {});
      return;
    }
    // Whatever happens next, the track that just played is over: leave the
    // transport reading complete instead of frozen wherever the page last looked.
    if (duration > 0) setState('playback', 'currentTime', duration);
    host.listeningLearning.complete(pb.currentTrack, duration);
    if (pb.index < pb.queue.length - 1 || pb.repeat === 'all') {
      if (state.autoMode.active) promotePreparedAutoSuccessor();
      const successor = host.nextEntry();
      if (successor && !host.trackPrepared(successor)) {
        host.prefetchUpcoming();
        enterStarved();
        return;
      }
      host.actions.next('ended');
      return;
    }
    const continuousIntent = pb.radioMode
      ? 'radio'
      : state.autoMode.active
        ? 'auto_mode'
        : null;
    if (!continuousIntent && !pb.autoplayEnabled) {
      // The listener turned continuous play off: the end of the queue is the end,
      // and saying "finding more music" would be a lie.
      setState('playback', { isPlaying: false, isLoading: false, phase: 'paused' });
      return;
    }
    const endedQueueId = pb.queue[pb.index]?.queueId;
    const extend = continuousIntent
      ? host.generatedQueue?.refillNow() ?? Promise.resolve(false)
      : host.ensureAutoplay(true);
    enterStarved();
    void extend.then((ready) => {
      const current = state.playback.queue[state.playback.index];
      if (state.playback.phase !== 'starved' || current?.queueId !== endedQueueId) return;
      if (continuousIntent && host.generatedQueue?.activeIntent() !== continuousIntent) return;
      if (ready && state.playback.index < state.playback.queue.length - 1) resumeFromStarved();
    });
  }

  /** Apply a playlist mutation response (authoritative playlists + settings). */

    return {
      dispose() { lifetime.dispose(); cancelRunwayReplan(); commitSeq += 1; committedTransition = null; },
      onPreviewPreparation,
      get autoHandoffFailures() { return autoHandoffFailures; },
      set autoHandoffFailures(value: number) { autoHandoffFailures = value; },
      get autoHandoffCooldownUntil() { return autoHandoffCooldownUntil; },
      set autoHandoffCooldownUntil(value: number) { autoHandoffCooldownUntil = value; },
      cancelRunwayReplan,
      get committedTransition() { return committedTransition; },
      set committedTransition(value: CommittedTransition | null) { committedTransition = value; },
      scheduleRunwayReplan,
      startAutoFromSources,
      dropAutoRouteOccurrence,
      avoidAutoIdentity,
      insertionFloor,
      djItemRef,
      autoRouteKind,
      playingDuration,
      get TRUSTED_CONFIDENCE() { return TRUSTED_CONFIDENCE; },
      commitTransition,
      confirmNormalMode,
      mixAutoTrackNow,
      resumeFromStarved,
      get replanNote() { return replanNote; },
      set replanNote(value: string) { replanNote = value; },
      onEnded,
      evaluateDjRunway,
      watchRunway
    };
}
