import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api, type DjDirection, type DjItemRef, type DjPlanResponse, type DjProfile, type DjRouteKind, type ListeningPlanItem, type PreviewPreparation } from "../lib/api";
import { audioService, type LiveTransitionPlan, type ProgramPlaybackSnapshot } from "../lib/audio";
import { type MediaSessionSyncReason } from "../lib/mediaSession";
import { playbackYoutubeId } from "../lib/media";
import { createPreparationOwner } from "../lib/prefetch";
import { toast } from "../lib/toast";
import { confirmDialog } from "../lib/confirm";
import { isPodcastTrack } from "../lib/track";
import { queueIdentity, queueIndexOf } from "../lib/queueDiscovery";
import { GeneratedQueueController, type AutoActivity, type AutoMusicSet, type AutoPlanItem, type AutoProfile } from "../lib/generatedQueue";
import { t as tr } from "../lib/i18n";
import { ListeningLearning } from "../lib/listeningLearning";
import { createQueueEntry, futureEntries, isPendingEntry, type PlaybackQueueEntry } from "../lib/playbackQueue";
import { shuffled } from "../lib/shuffle";
import type { Track } from "../types/music";
import { favouriteTracks, musicLibrary } from "./identity";
import { state, setState, setNowPlayingOpen, randomId, type RepeatMode } from "./core";
import type { PlayerActions, PlaybackTrigger, PlaybackAttempt, LoadOptions, CommittedTransition, PublishedPlaybackState } from "./contracts";
export interface DjPorts {
  createPlaybackAttempt: (track: Track, generation: number, trigger: PlaybackTrigger, id?: string) => PlaybackAttempt;
  beginLoad: () => number;
  trackUrl: (track: Track) => string;
  listeningLearning: ListeningLearning;
  concludeAttempt: (attempt: PlaybackAttempt | null, outcome: string) => void;
  activeAttempt: PlaybackAttempt | null;
  currentPreparation: ReturnType<typeof createPreparationOwner>;
  prefetchUpcoming: () => void;
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  pushPlaybackState: (opts?: {
    keepalive?: boolean;
    body?: PublishedPlaybackState;
  }) => void;
  stagedEntry: {
    queueId: string;
    attemptId: string;
    url: string;
  } | null;
  actions: Pick<PlayerActions, 'addAutoSource' | 'enterAutoMode' | 'exitAutoMode' | 'next' | 'placeAutoTrack' | 'placeAutoTracks' | 'playFrom' | 'repairAutoRoute' | 'resumePlayback' | 'retryCurrent' | 'startRadio'>;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
  trackPrepared: (track: Track) => boolean;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  loadIndex: (i: number, opts?: LoadOptions) => void;
  updateUpcomingPreparation: () => void;
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
  stageNext: () => void;
  nextEntry: () => PlaybackQueueEntry | undefined;
  previewLookahead: () => string[];
  runWhenAudible: (() => void) | null;
  abandonContextMatches: (keep?: (queueId: string) => boolean) => void;
}

/** Owns dj behaviour; cross-domain work enters through explicit ports. */
export function createDj(ports: DjPorts, lifetime: RuntimeLifetime) {
  let generatedQueue: GeneratedQueueController | null = null;
  let autoPlaybackPrefs: {
    shuffle: boolean;
    repeat: RepeatMode;
  } | null = null;
  let autoSessionEpoch = 0;
  let pendingImmediateAutoTrack: Track | null = null;
  let autoOpeningAborter: AbortController | null = null;
  let autoOpeningRetry: ReturnType<typeof setTimeout> | null = null;
  const AUTOPLAY_TARGET = 8;
  const AUTOPLAY_PREPARE_THRESHOLD = 2;
  const AUTOPLAY_REFILL_THRESHOLD = 5;
  async function ensureAutoplay(force = false): Promise<boolean> {
    const pb = state.playback;
    const current = pb.currentTrack;
    if (!pb.autoplayEnabled || !current || isPendingEntry(current) || isPodcastTrack(current) || pb.radioMode || state.autoMode.active || pb.repeat !== 'off') {
      return false;
    }
    const upcoming = futureEntries(pb.queue, pb.index);
    const generated = upcoming.filter(entry => entry.queueLane === 'generated' && entry.queueSource === 'autoplay');
    const deterministic = upcoming.filter(entry => !(entry.queueLane === 'generated' && entry.queueSource === 'autoplay'));
    if (!force && deterministic.length > AUTOPLAY_PREPARE_THRESHOLD) return false;
    if (!force && generated.length >= AUTOPLAY_REFILL_THRESHOLD) return false;

    // A context song still waiting on its match has nothing to seed a plan with.
    const seed = generated.at(-1) ?? deterministic.filter(entry => !isPendingEntry(entry)).at(-1) ?? current;
    if (generated.length >= AUTOPLAY_TARGET) return true;
    return ensureGeneratedQueue().ensureAutoplay(seed, force);
  }
  const COMMIT_LEAD_SECONDS = 45;
  const MIN_PLAY_SECONDS = 90;
  const MIN_PLAY_FRACTION = 0.6;
  const TRUSTED_CONFIDENCE = 0.35;
  const IDLE_TRANSITION = {
    status: 'idle',
    technique: undefined,
    nextTrackId: undefined,
    at: undefined
  } as const;
  const MAX_CONSECUTIVE_AUTO_HANDOFF_FAILURES = 2;
  const AUTO_HANDOFF_COOLDOWN_MS = 30_000;
  let autoHandoffFailures = 0;
  let autoHandoffCooldownUntil = 0;
  let committedTransition: CommittedTransition | null = null;
  let commitSeq = 0;
  function playingDuration(): number {
    const duration = audioService.snapshot().duration;
    if (Number.isFinite(duration) && duration > 0) return duration;
    const declared = state.playback.currentTrack?.duration ?? 0;
    return Number.isFinite(declared) && declared > 0 ? declared : 0;
  }
  function resolveTransition(fromKey: string, duration: number, item: AutoPlanItem | undefined): LiveTransitionPlan | null {
    if (!Number.isFinite(duration) || duration <= 4) return null;
    if (!state.playback.djMixing) {
      return {
        technique: 'direct',
        out_cue: duration,
        in_cue: 0,
        overlap_seconds: 0,
        overlap_bars: 0,
        playback_rate: 1,
        confidence: 0
      };
    }
    const chained = item?.fromKey === fromKey ? item.transition : undefined;
    const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
    const requested = chained?.overlap_seconds ?? 6;
    const overlap = Math.max(1.5, Math.min(trusted ? requested : Math.min(requested, 6), duration * 0.25));
    const latest = duration - overlap - 1;
    if (latest <= 0) return null;
    const earliest = Math.min(Math.min(MIN_PLAY_SECONDS, duration * MIN_PLAY_FRACTION), latest);
    const proposed = chained && Number.isFinite(chained.out_cue) && (chained.out_cue ?? 0) > 0 ? Number(chained.out_cue) : latest;
    return {
      technique: trusted ? chained!.technique : 'safe_fade',
      out_cue: Math.min(latest, Math.max(earliest, proposed)),
      in_cue: trusted ? chained!.in_cue : 0,
      overlap_seconds: overlap,
      overlap_bars: chained?.overlap_bars ?? 0,
      playback_rate: trusted ? chained!.playback_rate : 1,
      confidence: chained?.confidence ?? 0
    };
  }
  function unmixed(plan: LiveTransitionPlan): LiveTransitionPlan {
    return {
      ...plan,
      technique: 'direct',
      in_cue: 0,
      overlap_seconds: 0,
      overlap_bars: 0,
      playback_rate: 1
    };
  }
  function adoptHandoffAttempt(track: PlaybackQueueEntry): void {
    const attempt = ports.createPlaybackAttempt(track, ports.beginLoad(), 'handoff');
    attempt.audibleAt = performance.now();
  }
  function commitTransition(next: PlaybackQueueEntry, fromKey: string, planned: LiveTransitionPlan, manual: boolean): void {
    const plan = state.playback.djMixing ? planned : unmixed(planned);
    const toKey = queueIdentity(next);
    const outgoing = state.playback.currentTrack;
    const outgoingDuration = playingDuration();
    const token = ++commitSeq;
    const owns = () => commitSeq === token;
    committedTransition = {
      queueId: next.queueId,
      fromKey,
      toKey
    };
    setState('autoMode', 'transition', {
      status: 'armed',
      technique: plan.technique,
      nextTrackId: toKey,
      at: manual ? state.playback.currentTime : plan.out_cue
    });
    audioService.armTransition(ports.trackUrl(next), plan, {
      onDominant: () => {
        if (!owns()) return;
        autoHandoffFailures = 0;
        if (!manual) ports.listeningLearning.complete(outgoing, outgoingDuration);
        const queue = state.playback.queue;
        const index = queue.findIndex(entry => entry.queueId === next.queueId);
        // The incoming deck is already audible; there is no undo. Follow it.
        ports.concludeAttempt(ports.activeAttempt, 'handoff');
        ports.activeAttempt = null;
        adoptHandoffAttempt(next);
        const snapshot = audioService.snapshot();
        setState('playback', {
          currentTrack: next,
          index: index === -1 ? state.playback.index : index,
          currentTime: snapshot.position,
          duration: snapshot.duration > 0 ? snapshot.duration : next.duration ?? 0,
          isPlaying: snapshot.playing,
          isLoading: false,
          loadError: false,
          phase: 'playing'
        });
        setState('autoMode', 'transition', {
          status: 'mixing',
          technique: plan.technique,
          nextTrackId: toKey
        });
        const previewId = next.source === 'preview' ? playbackYoutubeId(next) : null;
        ports.currentPreparation.update(previewId ? [previewId] : []);
        ports.prefetchUpcoming();
        ports.updateMediaSession(next, 'handoff_dominant', true);
        ports.pushPlaybackState();
      },
      onComplete: position => {
        if (!owns()) return;
        committedTransition = null;
        setState('playback', {
          currentTime: position,
          duration: playingDuration()
        });
        setState('autoMode', 'transition', IDLE_TRANSITION);
        // The outgoing source has been retired. This publication does not prove
        // iOS changed its selected Now Playing element.
        ports.updateMediaSession(state.playback.currentTrack, 'handoff_settled', true);
        const pending = pendingImmediateAutoTrack;
        pendingImmediateAutoTrack = null;
        if (state.autoMode.active && pending) {
          queueMicrotask(() => mixAutoTrackNow(pending));
        } else if (state.autoMode.active) {
          void generatedQueue?.ensureRunway();
        }
      },
      onCancel: () => {
        if (!owns()) return;
        committedTransition = null;
        setState('autoMode', 'transition', IDLE_TRANSITION);
      },
      onStaged: () => {
        if (!owns()) return;
        // The blend could not be performed, but its song still comes next: the
        // deck that was cued for it is now the staged deck the ordinary handover
        // takes (`loadIndex` → `takeStaged`), from its first second.
        committedTransition = null;
        setState('autoMode', 'transition', IDLE_TRANSITION);
        ports.stagedEntry = {
          queueId: next.queueId,
          attemptId: randomId(),
          url: ports.trackUrl(next)
        };
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
          if (promotePreparedAutoSuccessor()) ports.actions.next('ended');else {
            ports.prefetchUpcoming();
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
      }
    }, {
      manual,
      level: ports.levelFor(next)
    });
  }
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
      artist_is_channel: track.artist_is_channel,
      duration: track.duration
    };
  }
  function autoRecommendationIdentity(track: Track): string {
    if (track.recommendation?.identity) return track.recommendation.identity;
    return track.source === 'preview' ? `music:youtube:${track.youtube_id || track.id}` : `music:track:${track.id}`;
  }
  function maybeRefineTransition(current: Track, next: PlaybackQueueEntry, fromKey: string): void {
    const toKey = queueIdentity(next);
    const pair = `${fromKey}>${toKey}`;
    if (refinedPair === pair) return;
    const item = state.autoMode.plan[next.queueId];
    if (!item || item.fromKey !== fromKey) return;
    if ((item.transition?.confidence ?? 0) >= TRUSTED_CONFIDENCE) return;
    refinedPair = pair;
    void api.refineDjTransition({
      dj_profile: state.autoMode.djProfile,
      from: djItemRef(current),
      to: djItemRef(next)
    }).then(lifetime.guard(result => {
      if (!result.measured || !state.autoMode.active) return;
      if (state.autoMode.plan[next.queueId]?.fromKey !== fromKey) return;
      setState('autoMode', 'plan', next.queueId, 'transition', result.transition);
    })).catch(lifetime.guard(() => {
      /* the conservative plan stands */
    }));
  }
  function evaluateDjRunway(): void {
    if (!state.autoMode.active || committedTransition || audioService.mixPhase() !== 'idle') return;
    if (performance.now() < autoHandoffCooldownUntil) return;
    const pb = state.playback;
    const current = pb.currentTrack;
    const next = pb.queue[pb.index + 1];
    if (!current || !next || pb.loadError) return;
    if (!ports.trackPrepared(next)) {
      const videoId = playbackYoutubeId(next);
      if (videoId) ports.prefetchUpcoming();
      promotePreparedAutoSuccessor();
      return;
    }
    const fromKey = queueIdentity(current);
    const plan = resolveTransition(fromKey, playingDuration(), state.autoMode.plan[next.queueId]);
    if (!plan) return;
    // A measured blend is only worth asking for when there will be a blend.
    if (state.playback.djMixing && pb.currentTime >= plan.out_cue - COMMIT_LEAD_SECONDS - REFINE_LEAD_SECONDS) {
      maybeRefineTransition(current, next, fromKey);
    }
    if (pb.currentTime < plan.out_cue - COMMIT_LEAD_SECONDS) return;
    commitTransition(next, fromKey, plan, false);
  }
  function insertionFloor(): number {
    const pb = state.playback;
    if (!committedTransition) return pb.index;
    const committed = pb.queue.findIndex(entry => entry.queueId === committedTransition!.queueId);
    return committed > pb.index ? committed : pb.index;
  }
  function autoRouteKind(entry: PlaybackQueueEntry): DjRouteKind {
    if (entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user') return 'user';
    return entry.autoRoute?.kind ?? 'generated';
  }
  function explicitAutoRunway(): PlaybackQueueEntry[] {
    return futureEntries(state.playback.queue, state.playback.index).filter(entry => autoRouteKind(entry) === 'user');
  }
  function mixAutoTrackNow(track: Track): void {
    if (!state.autoMode.active || isPodcastTrack(track)) return;
    const pb = state.playback;
    if (pb.currentTrack && queueIndexOf([pb.currentTrack], track) === 0) {
      if (pb.loadError) ports.actions.retryCurrent();else if (!pb.isPlaying && !pb.isLoading) ports.actions.resumePlayback();
      return;
    }
    if (audioService.mixPhase() === 'crossfading') {
      pendingImmediateAutoTrack = track;
      setState('autoMode', 'activity', {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.immediateQueued',
        values: {
          title: track.title
        }
      });
      return;
    }
    ports.discardFutureAutoplay();
    ports.cancelPendingRadio();
    pendingImmediateAutoTrack = null;
    if (audioService.mixPhase() !== 'idle') audioService.cancelMix('superseded');
    const explicit = explicitAutoRunway();
    const requested = {
      ...createQueueEntry(track, 'manual', 'play_next'),
      autoRoute: {
        kind: 'user' as const,
        placement: 'dj' as const
      }
    };
    const current = pb.currentTrack;
    setState('autoMode', {
      sources: state.autoMode.sources.length ? state.autoMode.sources : [{
        id: randomId(),
        label: track.title,
        tracks: [track],
        activation: 1
      }],
      heard: [...state.autoMode.heard, track].slice(-40),
      plan: {},
      staleSeams: [],
      transition: IDLE_TRANSITION,
      activity: {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.mixingImmediate',
        values: {
          title: track.title
        }
      }
    });
    if (!current || pb.index < 0) {
      setState('playback', {
        queue: [requested, ...explicit],
        index: -1,
        radioMode: false,
        radioLoading: false,
        radioSeedId: null
      });
      ports.loadIndex(0);
      void ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
      return;
    }
    const prefix = pb.queue.slice(0, pb.index + 1);
    setState('playback', {
      queue: [...prefix, requested, ...explicit],
      radioMode: false,
      radioLoading: false,
      radioSeedId: null
    });
    const fromKey = queueIdentity(current);
    commitTransition(requested, fromKey, {
      technique: 'safe_fade',
      out_cue: 0,
      in_cue: 0,
      overlap_seconds: 1.6,
      overlap_bars: 0,
      playback_rate: 1,
      confidence: 0
    }, true);
    void ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
  }
  function rememberDjExploration(): void {
    if (!state.autoMode.active) return;
    const entry = state.playback.queue[state.playback.index];
    if (entry?.autoRoute?.kind !== 'generated' || entry.autoRoute.directionRevision !== (state.autoMode.directionRevision ?? 0)) return;
    const roots = state.autoMode.exploration ?? [];
    const identity = queueIdentity(entry);
    if (roots.some(track => queueIdentity(track) === identity)) return;
    setState('autoMode', 'exploration', [...roots, entry].slice(-4));
    void generatedQueue?.ensureRunway();
  }
  function startAutoFromSourcePlan(response: DjPlanResponse): boolean {
    if (!response.opening) return false;
    const opening = planItemTrack(response.opening);
    const openingEntry = {
      ...createQueueEntry(opening, 'generated', 'auto_mode'),
      autoRoute: {
        kind: 'generated' as const,
        directionRevision: state.autoMode.directionRevision ?? 0
      }
    };
    const candidates = response.items.map(item => ({
      item,
      track: planItemTrack(item)
    })).filter(({
      track
    }) => queueIndexOf([openingEntry], track) === -1);
    const entries = candidates.map(({
      track
    }) => ({
      ...createQueueEntry(track, 'generated', 'auto_mode'),
      autoRoute: {
        kind: 'generated' as const,
        directionRevision: state.autoMode.directionRevision ?? 0
      }
    }));
    const plan: Record<string, AutoPlanItem> = {};
    let fromKey = queueIdentity(openingEntry);
    candidates.forEach(({
      item
    }, index) => {
      const entry = entries[index];
      plan[entry.queueId] = {
        trackId: queueIdentity(entry),
        source: item.source_pool,
        reasonKey: autoReasonKey(item),
        reasonValues: item.source_pool === 'related' ? {
          title: opening.title
        } : undefined,
        fromKey,
        transition: item.transition,
        bpm: item.analysis?.bpm,
        key: item.analysis?.key,
        sourceSetId: item.source_set_id,
        sourceSetLabel: item.source_set_label,
        lineage: item.lineage
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
      radioSeedId: null
    });
    ensureGeneratedQueue().adopt('auto_mode', openingEntry, state.autoMode.profile, {
      sessionId: response.session_id,
      nextSegmentIndex: (response.segment_index ?? 0) + 1
    });
    setState('autoMode', {
      heard: [opening],
      plan,
      staleSeams: [],
      phase: entries.length ? 'ready' : response.warming ? 'warming' : 'degraded',
      activity: {
        id: ++generatedActivityId,
        status: 'done',
        key: 'autoMode.agent.openedSource',
        values: {
          title: opening.title
        }
      }
    });
    ports.loadIndex(0);
    ports.prefetchUpcoming();
    return true;
  }
  async function startAutoFromSources(retryStep = 0): Promise<void> {
    const isCurrent = lifetime.capture();
    if (autoOpeningRetry) lifetime.clearTimeout(autoOpeningRetry);
    autoOpeningRetry = null;
    if (!state.autoMode.active || state.playback.currentTrack || state.autoMode.sources.length === 0) return;
    const sessionEpoch = autoSessionEpoch;
    autoOpeningAborter?.abort();
    const aborter = new AbortController();
    autoOpeningAborter = aborter;
    setState('autoMode', {
      phase: 'planning',
      activity: {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.openingSource'
      }
    });
    try {
      const response = await api.planDjQueue({
        dj_profile: state.autoMode.djProfile,
        direction: state.autoMode.direction,
        session_id: randomId(),
        segment_index: 0,
        source_policy: 'explicit',
        exploration: state.autoMode.exploration ?? [],
        direction_revision: state.autoMode.directionRevision ?? 0,
        sources: state.autoMode.sources.map(({
          id,
          label,
          tracks,
          activation
        }) => ({
          id,
          label,
          tracks,
          activation
        })),
        heard: [],
        exclude: state.autoMode.avoidedIdentities,
        limit: 8
      }, aborter.signal);
      if (!isCurrent()) {
        return;
      }
      if (aborter.signal.aborted || !state.autoMode.active || sessionEpoch !== autoSessionEpoch || state.playback.currentTrack) return;
      if (!startAutoFromSourcePlan(response)) throw new Error('no opening');
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (aborter.signal.aborted || !state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
      setState('autoMode', {
        phase: 'degraded',
        activity: {
          id: ++generatedActivityId,
          status: 'error',
          key: 'autoMode.agent.openingFailed'
        }
      });
      const delay = [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(retryStep, 4)];
      autoOpeningRetry = lifetime.setTimeout(() => {
        autoOpeningRetry = null;
        if (state.autoMode.active && sessionEpoch === autoSessionEpoch && !state.playback.currentTrack) {
          void startAutoFromSources(retryStep + 1);
        }
      }, delay);
    } finally {
      if (autoOpeningAborter === aborter) autoOpeningAborter = null;
    }
  }
  const AUTO_OPENING_MIN_FAVOURITES = 8;
  const AUTO_OPENING_SAMPLE = 40;
  async function openAutoFromCollection(): Promise<void> {
    const isCurrent = lifetime.capture();
    const epoch = autoSessionEpoch;
    // A song or a source the listener chose while this was looking wins.
    const unanswered = () => state.autoMode.active && autoSessionEpoch === epoch && !state.playback.currentTrack && state.autoMode.sources.length === 0;
    const open = (tracks: Track[], label: string) => {
      ports.actions.addAutoSource(shuffled(tracks).slice(0, AUTO_OPENING_SAMPLE), label);
    };
    const favourites = favouriteTracks().filter(track => !isPodcastTrack(track));
    const library = musicLibrary();
    if (favourites.length >= AUTO_OPENING_MIN_FAVOURITES || favourites.length && !library.length) {
      open(favourites, tr('nav.favourites'));
      return;
    }
    if (library.length) {
      open(library, tr('nav.library'));
      return;
    }
    const aborter = new AbortController();
    autoOpeningAborter?.abort();
    autoOpeningAborter = aborter;
    setState('autoMode', {
      phase: 'planning',
      activity: {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.openingSource'
      }
    });
    let recommended: Track[] = [];
    try {
      const feed = await api.getDiscoveryMusicFeed(aborter.signal);
      if (!isCurrent()) {
        return;
      }
      recommended = (feed.items ?? []).flatMap((item): Track[] => {
        const owned = item.track_id ? state.library.find(track => track.id === item.track_id) : undefined;
        if (owned) return isPodcastTrack(owned) ? [] : [owned];
        const videoId = String(item.external_ids?.youtube_id ?? '');
        if (!videoId) return [];
        return [{
          id: videoId,
          title: item.title,
          artist: item.artist,
          album: item.album,
          duration: item.duration,
          cover: item.cover,
          source: 'preview'
        }];
      });
    } catch {
      if (!isCurrent()) {
        return;
      }

      // Nothing to open from, which is said below.
    } finally {
      if (autoOpeningAborter === aborter) autoOpeningAborter = null;
    }
    if (aborter.signal.aborted || !unanswered()) return;
    if (recommended.length) {
      open(recommended, tr('nav.search'));
      return;
    }
    setState('autoMode', {
      phase: 'idle',
      activity: {
        id: ++generatedActivityId,
        status: 'error',
        key: 'autoMode.noSeed'
      }
    });
  }
  async function confirmNormalMode(kind: 'podcast' | 'radio', proceed: () => void | Promise<void>): Promise<void> {
    const isCurrent = lifetime.capture();
    const ok = await confirmDialog({
      title: tr('modeChange.toNormalTitle'),
      message: tr(kind === 'podcast' ? 'modeChange.podcastMessage' : 'modeChange.radioMessage'),
      confirmLabel: tr(kind === 'podcast' ? 'modeChange.playPodcast' : 'modeChange.startRadio')
    });
    if (!isCurrent()) {
      return;
    }
    if (!ok || !state.autoMode.active) return;
    ports.actions.exitAutoMode();
    await proceed();
    if (!isCurrent()) {
      return;
    }
  }
  function dropAutoRouteOccurrence(queueId: string): PlaybackQueueEntry | null {
    if (!state.autoMode.active || committedTransition?.queueId === queueId) return null;
    const track = state.playback.queue.find(entry => entry.queueId === queueId);
    if (!track) return null;
    const owned = new Set(state.playback.queue.filter(entry => entry.autoRoute?.kind === 'bridge' && entry.autoRoute.ownerQueueId === queueId).map(entry => entry.queueId));
    owned.add(queueId);
    setState('playback', 'queue', queue => queue.filter(entry => !owned.has(entry.queueId)));
    setState('autoMode', 'plan', plan => Object.fromEntries(Object.entries(plan).filter(([id]) => !owned.has(id))));
    setState('autoMode', 'staleSeams', seams => seams.filter(id => !owned.has(id)));
    ports.updateUpcomingPreparation();
    void generatedQueue?.ensureRunway();
    return track;
  }
  function avoidAutoIdentity(track: Track): void {
    const identity = autoRecommendationIdentity(track);
    const sessionEpoch = autoSessionEpoch;
    setState('autoMode', 'avoidedIdentities', identities => identities.includes(identity) ? identities : [...identities, identity]);
    toast.action(tr('autoMode.route.avoided', {
      title: track.title
    }), tr('common.undo'), () => {
      if (!state.autoMode.active || autoSessionEpoch !== sessionEpoch) return;
      setState('autoMode', 'avoidedIdentities', identities => identities.filter(value => value !== identity));
    });
  }
  let replanTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAN_DEBOUNCE_MS = 800;
  let replanNote = '';
  function isSingleRequest(entry: PlaybackQueueEntry): boolean {
    if (entry.autoRoute?.kind === 'bridge') return false;
    if (entry.autoRoute?.requestGroup) return false;
    return entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user';
  }
  function changeAutoSession(tracks: Track[], label: string, lead?: Track): boolean {
    const usable = tracks.filter(track => !isPodcastTrack(track));
    if (!state.autoMode.active || !usable.length || lead && isPodcastTrack(lead)) return false;
    cancelRunwayReplan();
    autoOpeningAborter?.abort();
    autoOpeningAborter = null;
    if (autoOpeningRetry) lifetime.clearTimeout(autoOpeningRetry);
    autoOpeningRetry = null;
    pendingImmediateAutoTrack = null;
    autoSessionEpoch += 1;
    const revision = (state.autoMode.directionRevision ?? 0) + 1;
    const source: AutoMusicSet = {
      id: randomId(),
      label: label.trim() || usable[0].title,
      tracks: usable,
      activation: 1
    };
    // A cued but silent handoff was the old direction's next song; a sounding
    // blend is already the music.
    const audible = audioService.mixPhase() === 'crossfading';
    if (!audible) {
      if (audioService.mixPhase() !== 'idle') audioService.cancelMix('superseded');
      committedTransition = null;
      setState('autoMode', 'transition', IDLE_TRANSITION);
    }
    const pb = state.playback;
    const current = pb.currentTrack;
    const floor = current ? insertionFloor() : pb.index;
    const anchor = pb.queue[floor] ?? current;
    const leadEntry = lead && anchor && queueIndexOf([anchor], lead) !== 0 ? {
      ...createQueueEntry(lead, 'generated', 'auto_mode'),
      autoRoute: {
        kind: 'generated' as const,
        directionRevision: revision
      }
    } : null;
    // A request for the very song the session now starts from is that start.
    const kept = pb.queue.slice(floor + 1).filter(entry => isSingleRequest(entry) && !(leadEntry && queueIndexOf([entry], leadEntry) === 0));
    const head = pb.queue.slice(0, floor + 1);
    const queue = [...head, ...(leadEntry ? [leadEntry] : []), ...kept];
    if (ports.stagedEntry && !queue.some(entry => entry.queueId === ports.stagedEntry!.queueId)) {
      ports.stagedEntry = null;
      audioService.clearStaged();
    }
    setState('playback', {
      queue,
      radioMode: false,
      radioLoading: false,
      radioSeedId: null
    });
    // Every kept seam now has a different song in front of it. A cue is only
    // ever honoured for the song it was planned out of.
    const plan: Record<string, AutoPlanItem> = {};
    for (const [queueId, item] of Object.entries(state.autoMode.plan)) {
      if (head.some(entry => entry.queueId === queueId)) plan[queueId] = item;
    }
    queue.slice(floor + 1).forEach((row, offset) => {
      const fromKey = queueIdentity(queue[floor + offset]);
      const held = state.autoMode.plan[row.queueId];
      plan[row.queueId] = held?.fromKey === fromKey ? held : {
        ...held,
        trackId: queueIdentity(row),
        source: held?.source ?? (row.source === 'preview' ? 'related' : 'local'),
        reasonKey: held?.reasonKey ?? (row === leadEntry ? 'autoMode.reason.sessionStart' : 'autoMode.route.placed'),
        fromKey,
        transition: undefined
      };
    });
    setState('autoMode', {
      sources: [source],
      exploration: [],
      directionRevision: revision,
      plan,
      staleSeams: [],
      repairing: false,
      phase: 'planning',
      activity: {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.sourceChanged',
        values: {
          title: source.label
        }
      }
    });
    ports.updateUpcomingPreparation();
    if (!current) {
      // Nothing to mix out of: the planner opens inside the new source.
      generatedQueue?.stop('auto_mode');
      void startAutoFromSources();
    } else {
      // The DJ's own measurement of the seam into the chosen song, asked for now
      // rather than a minute before the end — it may well leave sooner.
      if (leadEntry && anchor) maybeRefineTransition(anchor, leadEntry, queueIdentity(anchor));
      void ensureGeneratedQueue().start('auto_mode', queue.at(-1) ?? current, state.autoMode.profile);
    }
    ports.prefetchUpcoming();
    ports.pushPlaybackState();
    return true;
  }
  function scheduleRunwayReplan(note: string): void {
    if (!state.autoMode.active) return;
    replanNote = note;
    if (replanTimer) lifetime.clearTimeout(replanTimer);
    setState('autoMode', {
      pendingDirection: true,
      // Answer the gesture immediately. Waiting out the debounce before saying
      // anything reads as a surface that ignored you.
      activity: {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.heard',
        values: {
          note
        }
      }
    });
    replanTimer = lifetime.setTimeout(() => {
      replanTimer = null;
      setState('autoMode', 'pendingDirection', false);
      if (state.autoMode.active) void ensureGeneratedQueue().replan(state.autoMode.profile);
    }, REPLAN_DEBOUNCE_MS);
  }
  function cancelRunwayReplan(): void {
    if (replanTimer) lifetime.clearTimeout(replanTimer);
    replanTimer = null;
    replanNote = '';
    setState('autoMode', 'pendingDirection', false);
  }
  const PREMATURE_END_SECONDS = 3;
  let starvedQueueId: string | null = null;
  function enterStarved(): void {
    starvedQueueId = state.playback.queue[state.playback.index]?.queueId ?? null;
    setState('playback', {
      isPlaying: false,
      isLoading: false,
      phase: 'starved'
    });
    ports.emitPlaybackEvent('ui_queue_starved', {
      lane_remaining: futureEntries(state.playback.queue, state.playback.index).length,
      auto_mode: state.autoMode.active,
      radio: state.playback.radioMode,
      // Starving in the foreground is a spinner; starving with the phone locked is
      // a drive that goes quiet, because the refill it waits on cannot complete.
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden'
    });
  }
  function resumeFromStarved(): void {
    if (state.playback.phase !== 'starved') return;
    const pb = state.playback;
    if (pb.queue[pb.index]?.queueId !== starvedQueueId) return;
    if (pb.index >= pb.queue.length - 1) {
      // Nothing yet. Ask again — for autoplay this is also what re-arms the
      // controller's own retry, which is otherwise only started by a failure.
      void ensureAutoplay(true);
      void generatedQueue?.refillNow();
      return;
    }
    if (state.autoMode.active) promotePreparedAutoSuccessor();
    const next = state.playback.queue[state.playback.index + 1];
    if (!next || !ports.trackPrepared(next)) {
      ports.prefetchUpcoming();
      return;
    }
    starvedQueueId = null;
    ports.loadIndex(state.playback.index + 1, {
      trigger: 'ended'
    });
  }
  const RUNWAY_LEAD_SECONDS = 60;
  const EMPTY_RUNWAY_RETRY_MS = 5_000;
  let runwayCheckedFor = '';
  let lastEmptyRefillAt = 0;
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
    ports.stageNext();
    // Forced when the lane is actually empty. Waiting for `ended` to discover it
    // means asking the network from a page iOS has already frozen, which is how a
    // drive ends in silence — the answer arrives when the phone is unlocked.
    void ensureAutoplay(empty);
    if (pb.radioMode || state.autoMode.active) {
      void (empty ? generatedQueue?.refillNow() : generatedQueue?.ensureRunway());
    }
  }
  function boundaryFacts(): Record<string, boolean> {
    const next = ports.nextEntry();
    return {
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      handoff_dj: audioService.mixPhase() !== 'idle',
      handoff_staged: !!next && ports.stagedEntry?.queueId === next.queueId,
      starved: !next
    };
  }
  function promotePreparedAutoSuccessor(): boolean {
    const pb = state.playback;
    const immediate = pb.queue[pb.index + 1];
    if (!immediate) return false;
    if (ports.trackPrepared(immediate)) return true;
    if (immediate.queueLane !== 'generated') return false;
    let readyIndex = -1;
    for (let index = pb.index + 2; index < pb.queue.length; index += 1) {
      const candidate = pb.queue[index];
      if (candidate.queueLane !== 'generated') break;
      if (ports.trackPrepared(candidate)) {
        readyIndex = index;
        break;
      }
    }
    if (readyIndex === -1) return false;
    setState('playback', 'queue', queue => {
      const copy = queue.slice();
      const [ready] = copy.splice(readyIndex, 1);
      copy.splice(pb.index + 1, 0, ready);
      return copy;
    });
    return true;
  }
  function onPreviewPreparation(videoId: string, status: PreviewPreparation): void {
    const pb = state.playback;
    const currentId = pb.currentTrack && playbackYoutubeId(pb.currentTrack);
    const wanted = ports.previewLookahead().slice(0, 3);
    if (videoId !== currentId && !wanted.includes(videoId)) return;
    if (pb.currentTrack && currentId === videoId) {
      setState('playback', 'previewPreparation', status);
    }
    if (ports.runWhenAudible) return;
    const future = pb.queue.slice(Math.max(0, pb.index + 1));
    const matching = future.filter(entry => playbackYoutubeId(entry) === videoId);
    if (status.state === 'unavailable' && matching.length > 0) {
      const failedIds = new Set(matching.map(entry => entry.queueId));
      for (const entry of matching) generatedQueue?.exclude(entry);
      if (state.autoMode.active) {
        for (const entry of matching) {
          if (entry.queueLane === 'generated') dropAutoRouteOccurrence(entry.queueId);
        }
      }
      // Auto's route helper may already have removed generated entries and their
      // bridges. This second pass owns manual/context and non-Auto generated
      // lanes, and is intentionally occurrence-scoped.
      setState('playback', 'queue', queue => queue.filter(entry => !failedIds.has(entry.queueId)));
      if (ports.stagedEntry && failedIds.has(ports.stagedEntry.queueId)) {
        ports.stagedEntry = null;
        audioService.clearStaged();
      }
      ports.emitPlaybackEvent('ui_preview_unavailable', {
        occurrences: matching.length,
        retry_after_sec: status.retry_after ?? 0
      }, {
        video_id: videoId,
        queue_lane: matching[0]?.queueLane,
        queue_source: matching[0]?.queueSource
      });
      if (matching.some(entry => entry.queueLane === 'generated')) {
        void generatedQueue?.refillNow();
      }
      ports.prefetchUpcoming();
    }
    if (status.state === 'ready') promotePreparedAutoSuccessor();
    ports.stageNext();
    resumeFromStarved();
  }
  let generatedActivityId = 0;
  function planItemTrack(item: ListeningPlanItem): Track {
    const local = item.track_id ? state.library.find(track => track.id === item.track_id) : null;
    const base: Track = local ? {
      ...local
    } : {
      id: item.youtube_id || item.id,
      title: item.title,
      artist: item.artist,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      source: 'preview'
    };
    return {
      ...base,
      artist_is_channel: local ? false : item.artist_is_channel,
      artists: local?.artists ?? item.artists ?? undefined,
      deezer_artist_id: base.deezer_artist_id ?? item.deezer_artist_id ?? undefined,
      deezer_album_id: base.deezer_album_id ?? item.deezer_album_id ?? undefined,
      source_title: item.source_title,
      source_artist: item.source_artist,
      youtube_id: item.youtube_id ?? base.youtube_id,
      discovery_youtube_id: item.discovery_youtube_id,
      playback_source_kind: item.playback_source_kind,
      canonical_identity: item.canonical_identity,
      recommendation: {
        identity: item.recommendation_identity,
        source: item.recommendation_source,
        reason: item.recommendation_source === 'autoplay' ? tr('autoplay.reason') : item.reason,
        reason_code: item.reason_code,
        discovery_youtube_id: item.discovery_youtube_id ?? undefined
      }
    };
  }
  function autoReasonKey(item: ListeningPlanItem): string {
    if (item.source_pool === 'related') return 'autoMode.reason.related';
    if (item.source_pool === 'local') return 'autoMode.reason.library';
    return 'autoMode.reason.node';
  }
  function ensureGeneratedQueue(): GeneratedQueueController {
    if (generatedQueue) return generatedQueue;
    generatedQueue = new GeneratedQueueController({
      snapshot: () => ({
        currentTrack: state.playback.currentTrack,
        queue: state.playback.queue.slice(),
        index: state.playback.index
      }),
      identity: queueIdentity,
      planningContext: () => JSON.stringify([state.autoMode.directionRevision, state.autoMode.sources.map(source => [source.id, source.activation, source.tracks.map(queueIdentity)]), (state.autoMode.exploration ?? []).map(queueIdentity), state.autoMode.avoidedIdentities, state.autoMode.direction]),
      isCommitted: entry => committedTransition?.queueId === entry.queueId,
      requestPlan: (intent, profile, seed, limit, exclude, signal, generatedSession) => {
        const seedBody = {
          id: seed.id,
          track_id: seed.source === 'preview' ? undefined : seed.id,
          youtube_id: seed.youtube_id ?? (seed.source === 'preview' ? seed.id : undefined),
          discovery_youtube_id: seed.discovery_youtube_id ?? undefined,
          source: seed.source,
          title: seed.title,
          artist: seed.artist,
          album: seed.album,
          duration: seed.duration
        };
        if (intent === 'auto_mode' && typeof api.planDjQueue === 'function') {
          return api.planDjQueue({
            dj_profile: state.autoMode.djProfile,
            direction: state.autoMode.direction,
            session_id: generatedSession?.id,
            segment_index: generatedSession?.segmentIndex,
            context: state.autoMode.heard.slice(-8).map(djItemRef),
            seed: seedBody,
            source_policy: 'explicit',
            exploration: state.autoMode.exploration ?? [],
            direction_revision: state.autoMode.directionRevision ?? 0,
            sources: state.autoMode.sources.map(({
              id,
              label,
              tracks,
              activation
            }) => ({
              id,
              label,
              tracks,
              activation
            })),
            heard: state.autoMode.heard,
            exclude: [...new Set([...exclude, ...state.autoMode.avoidedIdentities])],
            limit
          }, signal);
        }
        return api.planMusicQueue({
          intent,
          profile,
          seed: seedBody,
          exclude,
          limit
        }, signal);
      },
      applyPlan: (intent, response, replace, anchor) => {
        if (intent === 'auto_mode' && response.direction_revision != null && response.direction_revision !== (state.autoMode.directionRevision ?? 0)) return 0;
        // What a replacing plan keeps: everything already played, every explicit
        // request, and the one handoff that is already loaded and cued.
        const previousUpcoming = replace ? futureEntries(state.playback.queue, state.playback.index) : [];
        const held = replace ? previousUpcoming.filter(entry => entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user' || committedTransition?.queueId === entry.queueId) : [];
        const retained = replace ? [...state.playback.queue.slice(0, state.playback.index + 1), ...held] : state.playback.queue;
        const candidates = response.items.map(item => ({
          item,
          track: planItemTrack(item)
        })).filter(({
          track
        }) => queueIndexOf(retained, track) === -1);
        if (candidates.length === 0) return 0;
        const entries = candidates.map(({
          track
        }) => ({
          ...createQueueEntry(track, 'generated', intent),
          autoRoute: intent === 'auto_mode' ? {
            kind: 'generated' as const,
            directionRevision: state.autoMode.directionRevision ?? 0
          } : undefined
        }));
        if (replace) {
          let generatedIndex = 0;
          const runway = previousUpcoming.map(entry => {
            const preserved = entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user' || committedTransition?.queueId === entry.queueId;
            return preserved ? entry : entries[generatedIndex++];
          }).filter((entry): entry is PlaybackQueueEntry => Boolean(entry));
          runway.push(...entries.slice(generatedIndex));
          setState('playback', 'queue', [...state.playback.queue.slice(0, state.playback.index + 1), ...runway]);
        } else {
          setState('playback', 'queue', queue => [...queue, ...entries]);
        }
        if (intent === 'auto_mode') {
          const plan: Record<string, AutoPlanItem> = replace ? {} : {
            ...state.autoMode.plan
          };
          // The server chains a route: item N's transition is planned out of item
          // N-1, starting at the anchor. Walk the response in order so each entry
          // records which track its cue belongs to. An item dropped as a duplicate
          // breaks the chain, and the entry behind it loses a transition it can no
          // longer honour — a plain fade, rather than a cue from the wrong song.
          let previousKey = queueIdentity(anchor);
          let chained = true;
          const accepted = new Map(candidates.map(({
            item
          }, index) => [item, entries[index]] as const));
          for (const item of response.items) {
            if (!accepted.has(item)) {
              chained = false;
              continue;
            }
            const track = planItemTrack(item);
            const id = queueIdentity(track);
            const entry = accepted.get(item)!;
            plan[entry.queueId] = {
              trackId: id,
              source: item.source_pool,
              reasonKey: autoReasonKey(item),
              reasonValues: item.source_pool === 'related' ? {
                title: state.playback.currentTrack?.title ?? ''
              } : undefined,
              fromKey: previousKey,
              transition: chained ? item.transition : undefined,
              bpm: item.analysis?.bpm,
              key: item.analysis?.key,
              sourceSetId: item.source_set_id,
              sourceSetLabel: item.source_set_label,
              lineage: item.lineage
            };
            previousKey = id;
            chained = true;
          }
          // The anchor is a track the route continues from, not one it chose, so
          // it has no plan entry of its own. Recording its reading is what lets
          // the booth show a BPM for the song that is actually playing when a
          // session starts from whatever the listener already had on.
          setState('autoMode', 'plan', plan);
          // A replacing plan re-seams every join it writes, so the only unplanned
          // ones left are those belonging to rows it was not allowed to touch.
          setState('autoMode', 'staleSeams', seams => {
            if (!replace) return seams;
            const live = new Set(state.playback.queue.map(entry => entry.queueId));
            return seams.filter(id => live.has(id) && plan[id] === undefined);
          });
        }
        ports.prefetchUpcoming();
        // New runway. If the music ran out waiting for exactly this, start it
        // again — the plan arriving is the event, and nothing else is watching.
        if (entries.length > 0) {
          ports.stageNext();
          resumeFromStarved();
        }
        return entries.length;
      },
      onStatus: (intent, status, response, replacing) => {
        if (intent === 'autoplay') {
          setState('playback', 'autoplayLoading', status === 'planning');
          return;
        }
        if (intent === 'radio') {
          setState('playback', 'radioLoading', status === 'planning');
          return;
        }
        if (status === 'idle') {
          setState('autoMode', {
            phase: 'idle',
            pendingDirection: false
          });
          return;
        }
        if (status === 'planning') {
          setState('autoMode', {
            phase: 'planning',
            activity: {
              id: ++generatedActivityId,
              status: 'working',
              key: replacing ? 'autoMode.agent.redrawing' : 'autoMode.agent.searching',
              values: replacing ? {
                note: replanNote
              } : {
                title: state.playback.currentTrack?.title ?? ''
              }
            }
          });
          return;
        }
        const counts = response?.pool_counts ?? {
          local: 0,
          related: 0,
          discovery: 0
        };
        const exhausted = status === 'exhausted';
        const degraded = status === 'degraded' || exhausted;
        setState('autoMode', {
          phase: exhausted ? 'exhausted' : status === 'warming' ? 'warming' : degraded ? 'degraded' : 'ready',
          activity: {
            id: ++generatedActivityId,
            status: degraded ? 'error' : 'done',
            key: exhausted ? 'autoMode.route.exhausted' : degraded ? 'autoMode.agent.retrying' : replacing ? 'autoMode.agent.steered' : 'autoMode.agent.queued',
            values: {
              note: replanNote,
              count: response?.items.length ?? 0,
              tracks: response?.items.slice(0, 2).map(item => item.title).join(' · ') ?? '',
              related: counts.related,
              node: counts.discovery,
              local: counts.local
            }
          }
        });
      }
    });
    return generatedQueue;
  }
  const domainActions = {
    enterAutoMode(options?: {
      source: Track;
      deferPlanning: boolean;
    }): void {
      const current = state.playback.currentTrack;
      if (state.autoMode.active || current && isPodcastTrack(current) || options && isPodcastTrack(options.source)) return;
      // Asking for Auto is asking to see it. This lives here rather than in a
      // reaction to `autoMode.active`, because the flag also turns on when a
      // session is restored on boot — and a restore has no one asking for
      // anything, so it must leave the shell collapsed.
      setNowPlayingOpen(true);
      autoSessionEpoch += 1;
      pendingImmediateAutoTrack = null;
      autoOpeningAborter?.abort();
      autoOpeningAborter = null;
      autoHandoffFailures = 0;
      autoHandoffCooldownUntil = 0;
      autoPlaybackPrefs = {
        shuffle: state.playback.shuffle,
        repeat: state.playback.repeat
      };
      ports.discardFutureAutoplay();
      ports.cancelPendingRadio();
      ports.abandonContextMatches();
      // Take the wheel while preserving explicit queue occurrences.
      const prefix = state.playback.queue.slice(0, state.playback.index + 1);
      const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
      setState('playback', {
        shuffle: false,
        repeat: 'off',
        radioMode: false,
        radioLoading: false,
        radioSeedId: null,
        queue: [...prefix, ...manual]
      });
      setState('autoMode', {
        active: true,
        phase: current ? 'planning' : 'idle',
        activity: null,
        plan: {},
        sources: options ? [{
          id: randomId(),
          label: options.source.title,
          tracks: [options.source],
          activation: 1
        }] : current ? [{
          id: randomId(),
          label: current.title,
          tracks: [current],
          activation: 1
        }] : [],
        heard: current ? [current] : [],
        exploration: [],
        directionRevision: (state.autoMode.directionRevision ?? 0) + 1,
        avoidedIdentities: [],
        transition: {
          status: 'idle'
        },
        pendingDirection: false,
        repairing: false,
        staleSeams: []
      });
      // Entering the workspace is what starts the session. What decides that is
      // whether there is a song to plan *from* — never what the transport is
      // doing. The two used to be one condition, and `isPlaying` is false in far
      // more places than "the listener pressed pause": a page thawed after a
      // spell frozen in a pocket, a `pause` delivered from a deck, a session put
      // back on boot. In every one of them Auto opened with an empty route that
      // only a play press would fill — the transport driving the mode instead of
      // the other way round.
      //
      // Normally a no-op — the graph was built at the session's first touch —
      // but it also covers a listener who reached Auto Mode without one (a
      // keyboard shortcut, a restored session) and resumes a context that was
      // interrupted while the app sat in the background. With nothing playing it
      // matters more: the opening only starts once the planner answers, long
      // after the press that asked for it, and on a phone this press is the only
      // gesture that will ever vouch for that playback.
      audioService.unlockAudio();
      if (options?.deferPlanning) {
        generatedQueue?.stop();
        return;
      }
      if (current) void ensureGeneratedQueue().start('auto_mode', current, state.autoMode.profile);else void openAutoFromCollection();
    },
    exitAutoMode(): void {
      cancelRunwayReplan();
      pendingImmediateAutoTrack = null;
      autoOpeningAborter?.abort();
      autoOpeningAborter = null;
      // A blend that is already sounding finishes on its own; cancelling it would
      // revive the faded-out song while the UI names the new one. Anything merely
      // prepared is dropped.
      if (audioService.mixPhase() !== 'crossfading') audioService.cancelMix('exit');
      const prefix = state.playback.queue.slice(0, state.playback.index + 1);
      const survivors = futureEntries(state.playback.queue, state.playback.index).filter(entry => entry.queueLane === 'manual' || entry.autoRoute?.kind === 'user' || audioService.mixPhase() === 'crossfading' && committedTransition?.queueId === entry.queueId).map(entry => ({
        ...entry,
        queueLane: 'manual' as const,
        queueSource: 'add_to_queue' as const,
        autoRoute: undefined
      }));
      setState('playback', 'queue', [...prefix, ...survivors]);
      generatedQueue?.stop('auto_mode');
      if (autoPlaybackPrefs) {
        setState('playback', {
          shuffle: autoPlaybackPrefs.shuffle,
          repeat: autoPlaybackPrefs.repeat
        });
        autoPlaybackPrefs = null;
      }
      setState('autoMode', {
        active: false,
        phase: 'idle',
        sources: [],
        heard: [],
        exploration: [],
        avoidedIdentities: [],
        plan: {},
        pendingDirection: false,
        repairing: false,
        staleSeams: []
      });
      ports.updateUpcomingPreparation();
    },
    addAutoSource(tracks: Track[], label: string): void {
      const usable = tracks.filter(track => !isPodcastTrack(track));
      if (!state.autoMode.active || usable.length === 0) return;
      const source: AutoMusicSet = {
        id: randomId(),
        label: label.trim() || usable[0].title,
        tracks: usable,
        activation: Math.max(0, ...state.autoMode.sources.map(item => item.activation)) + 1
      };
      setState('autoMode', 'sources', sources => [...sources, source]);
      // A source is direction, never an implied playback request — and rewriting
      // the runway is not one, so a session waiting on a red light takes the
      // steer exactly like a sounding one. `removeAutoSource` always did.
      if (state.playback.currentTrack) scheduleRunwayReplan(tr('autoMode.note.direction'));else void startAutoFromSources();
    },
    beginAutoSessionChange(): number {
      return ++autoSessionEpoch;
    },
    async startDjFromTrack(track: Track): Promise<boolean> {
      if (isPodcastTrack(track) || state.playback.currentTrack && isPodcastTrack(state.playback.currentTrack)) {
        return false;
      }
      if (!state.autoMode.active) ports.actions.enterAutoMode({
        source: track,
        deferPlanning: true
      });
      return changeAutoSession([track], track.title, track);
    },
    async changeAutoSession(tracks: Track[], label: string): Promise<boolean> {
      return changeAutoSession(tracks, label);
    },
    retryAutoRoute(): void {
      if (!state.playback.currentTrack) {
        void startAutoFromSources();
        return;
      }
      void generatedQueue?.retry();
    },
    useAutoTrackAsSource(track: Track): void {
      if (!state.autoMode.active || isPodcastTrack(track)) return;
      const identity = queueIdentity(track);
      const existing = state.autoMode.sources.find(source => source.tracks.length === 1 && queueIdentity(source.tracks[0]) === identity);
      if (existing) {
        toast.info(tr('autoMode.source.already', {
          title: track.title
        }));
        return;
      }
      ports.actions.addAutoSource([track], track.title);
      toast.info(tr('autoMode.source.added', {
        title: track.title
      }));
    },
    removeAutoSource(id: string): void {
      if (!state.autoMode.active || state.autoMode.sources.length <= 1) return;
      setState('autoMode', 'sources', sources => sources.filter(source => source.id !== id));
      if (state.playback.currentTrack && state.autoMode.heard.length) {
        scheduleRunwayReplan(tr('autoMode.note.direction'));
      }
    },
    removeAutoRouteOccurrence(queueId: string): void {
      const track = dropAutoRouteOccurrence(queueId);
      if (!track) return;
      toast.action(tr('autoMode.note.dropped', {
        title: track.title
      }), tr('autoMode.route.avoidSession'), () => {
        if (state.autoMode.active) avoidAutoIdentity(track);
      });
    },
    avoidAutoTrackForSession(queueId: string): void {
      const track = dropAutoRouteOccurrence(queueId);
      if (track) avoidAutoIdentity(track);
    },
    setAutoProfile(profile: AutoProfile): void {
      try {
        localStorage.setItem('auto:profile', profile);
      } catch {
        /* private mode / storage disabled */
      }
      setState('autoMode', 'profile', profile);
      scheduleRunwayReplan(tr(`autoMode.note.crate.${profile}`));
    },
    setAutoDjProfile(profile: DjProfile): void {
      try {
        localStorage.setItem('auto:dj-profile', profile);
      } catch {
        /* private mode / storage disabled */
      }
      setState('autoMode', 'djProfile', profile);
      scheduleRunwayReplan(tr(`autoMode.note.dj.${profile}`));
    },
    setAutoDirection(direction: Partial<DjDirection>, note?: string): void {
      setState('autoMode', 'direction', current => ({
        ...current,
        ...direction
      }));
      scheduleRunwayReplan(note ?? tr('autoMode.note.direction'));
    },
    reportAutoActivity(key: string, status: AutoActivity['status'], values?: Record<string, string | number>): void {
      if (!state.autoMode.active) return;
      setState('autoMode', 'activity', {
        id: ++generatedActivityId,
        status,
        key,
        values
      });
    },
    autoSessionToken(): number {
      return autoSessionEpoch;
    },
    async placeAutoTracks(tracks: Track[], beforeQueueId?: string, requestGroup?: string): Promise<void> {
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active) return;
      const usable = tracks.filter(track => !isPodcastTrack(track));
      if (!usable.length) return;
      const group = requestGroup ?? (usable.length > 1 ? randomId() : undefined);
      if (usable.length === 1) return ports.actions.placeAutoTrack(usable[0], beforeQueueId, group);
      const epoch = autoSessionEpoch;
      if (!state.playback.currentTrack) {
        await ports.actions.placeAutoTrack(usable[0], undefined, group);
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || epoch !== autoSessionEpoch) return;
        return ports.actions.placeAutoTracks(usable.slice(1), beforeQueueId, group);
      }
      const floor = insertionFloor();
      const seed = state.playback.queue[floor] ?? state.playback.currentTrack;
      const route = state.playback.queue.slice(floor + 1);
      const signature = route.map(row => row.queueId).join('|');
      const occurrences = usable.map(track => ({
        ...createQueueEntry(track, 'generated', 'auto_mode'),
        autoRoute: {
          kind: 'user' as const,
          placement: beforeQueueId ? 'fixed' as const : 'dj' as const,
          requestGroup: group
        }
      }));
      const progress = toast.loading(tr('musicExplorer.requesting'));
      const fallback = () => {
        if (!state.autoMode.active || epoch !== autoSessionEpoch) return;
        const currentFloor = insertionFloor();
        const target = beforeQueueId ? state.playback.queue.findIndex(row => row.queueId === beforeQueueId) : -1;
        const at = target > currentFloor ? target : currentFloor + 1;
        setState('playback', 'queue', queue => [...queue.slice(0, at), ...occurrences, ...queue.slice(at)]);
        setState('autoMode', 'staleSeams', state.playback.queue.slice(currentFloor + 1).map(row => row.queueId));
        ports.prefetchUpcoming();
      };
      try {
        const response = await api.placeDjTracks({
          dj_profile: state.autoMode.djProfile,
          seed: djItemRef(seed),
          route: route.map(row => ({
            ...djItemRef(row),
            queue_id: row.queueId
          })),
          requests: occurrences.map(row => ({
            track: row,
            requested_queue_id: row.queueId
          })),
          before_queue_id: beforeQueueId,
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: state.autoMode.directionRevision ?? 0,
          sources: state.autoMode.sources,
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || epoch !== autoSessionEpoch) {
          progress.dismiss();
          return;
        }
        if (insertionFloor() !== floor || state.playback.queue.slice(floor + 1).map(row => row.queueId).join('|') !== signature) {
          fallback();
        } else {
          const working = [...route];
          const plan = {
            ...state.autoMode.plan
          };
          const byId = new Map(occurrences.map(row => [row.queueId, row]));
          const placed = new Set<string>();
          for (const placement of response.placements) {
            const requested = byId.get(placement.requested_queue_id);
            if (!requested || placed.has(requested.queueId)) throw new Error('invalid collection placement');
            placed.add(requested.queueId);
            let fromKey = queueIdentity(working[placement.insert_at - 1] ?? seed);
            const entries = placement.items.map((item, index) => {
              const entry = item.route_kind === 'user' ? requested : {
                ...createQueueEntry(planItemTrack(item), 'generated', 'auto_mode'),
                queueId: `${requested.queueId}:bridge:${index}`,
                autoRoute: {
                  kind: 'bridge' as const,
                  ownerQueueId: requested.queueId
                }
              };
              plan[entry.queueId] = {
                trackId: queueIdentity(entry),
                source: item.source_pool,
                reasonKey: autoReasonKey(item),
                fromKey,
                transition: item.transition,
                bpm: item.analysis?.bpm,
                key: item.analysis?.key
              };
              fromKey = queueIdentity(entry);
              return entry;
            });
            if (entries.filter(row => row.queueId === requested.queueId).length !== 1) throw new Error('missing request');
            const following = working[placement.insert_at];
            if (following && placement.following_transition) plan[following.queueId] = {
              ...(plan[following.queueId] ?? {
                trackId: queueIdentity(following),
                source: 'local',
                reasonKey: 'autoMode.reason.library'
              }),
              fromKey,
              transition: placement.following_transition
            };
            working.splice(placement.insert_at, 0, ...entries);
          }
          if (placed.size !== occurrences.length) throw new Error('incomplete collection placement');
          setState('playback', 'queue', queue => [...queue.slice(0, floor + 1), ...working]);
          setState('autoMode', 'plan', plan);
          ports.prefetchUpcoming();
        }
        progress.update('success', tr('musicExplorer.collectionDone', {
          count: occurrences.length
        }));
      } catch {
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || epoch !== autoSessionEpoch) {
          progress.dismiss();
          return;
        }
        fallback();
        progress.update('info', tr('autoMode.agent.placedFallback', {
          title: tr('musicExplorer.collectionDone', {
            count: occurrences.length
          })
        }));
      }
    },
    async placeAutoTrack(track: Track, beforeQueueId?: string, requestGroup?: string): Promise<void> {
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active || isPodcastTrack(track)) return;
      const floor = insertionFloor();
      const route = state.playback.queue.slice(floor + 1);
      const seed = state.playback.queue[floor] ?? state.playback.currentTrack;
      const occurrence = {
        ...createQueueEntry(track, 'generated', 'auto_mode'),
        autoRoute: {
          kind: 'user' as const,
          placement: beforeQueueId ? 'fixed' as const : 'dj' as const,
          requestGroup
        }
      };
      if (!seed) {
        setState('playback', {
          queue: [occurrence],
          index: 0,
          shuffle: false,
          repeat: 'off'
        });
        ports.loadIndex(0);
        void ensureGeneratedQueue().start('auto_mode', occurrence, state.autoMode.profile);
        return;
      }
      const sessionEpoch = autoSessionEpoch;
      const routeSignature = route.map(entry => entry.queueId).join('|');
      const fallbackIndex = beforeQueueId ? Math.max(floor + 1, state.playback.queue.findIndex(entry => entry.queueId === beforeQueueId)) : floor + 1;
      setState('autoMode', 'activity', {
        id: ++generatedActivityId,
        status: 'working',
        key: 'autoMode.agent.placing',
        values: {
          title: track.title
        }
      });
      try {
        const response = await api.placeDjTrack({
          dj_profile: state.autoMode.djProfile,
          seed: djItemRef(seed),
          route: route.map(entry => ({
            ...djItemRef(entry),
            queue_id: entry.queueId
          })),
          track,
          requested_queue_id: occurrence.queueId,
          before_queue_id: beforeQueueId,
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: state.autoMode.directionRevision ?? 0,
          sources: state.autoMode.sources.map(({
            id,
            label,
            tracks,
            activation
          }) => ({
            id,
            label,
            tracks,
            activation
          })),
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        const currentRoute = state.playback.queue.slice(insertionFloor() + 1);
        if (currentRoute.map(entry => entry.queueId).join('|') !== routeSignature) {
          const currentFloor = insertionFloor();
          const before = beforeQueueId ? state.playback.queue.findIndex(entry => entry.queueId === beforeQueueId) : currentFloor + 1;
          const at = before > currentFloor ? before : currentFloor + 1;
          setState('playback', 'queue', queue => [...queue.slice(0, at), occurrence, ...queue.slice(at)]);
          ports.prefetchUpcoming();
          return;
        }
        const entries = response.items.map(item => {
          const isUser = item.route_kind === 'user';
          const entry = isUser ? occurrence : createQueueEntry(planItemTrack(item), 'generated', 'auto_mode');
          return {
            ...entry,
            autoRoute: isUser ? occurrence.autoRoute : {
              kind: 'bridge' as const,
              ownerQueueId: occurrence.queueId
            }
          };
        });
        const at = Math.min(state.playback.queue.length, floor + 1 + response.insert_at);
        setState('playback', 'queue', queue => [...queue.slice(0, at), ...entries, ...queue.slice(at)]);
        const plan = {
          ...state.autoMode.plan
        };
        let fromKey = queueIdentity(state.playback.queue[at - 1] ?? seed);
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          const item = response.items[index];
          plan[entry.queueId] = {
            trackId: queueIdentity(entry),
            source: item.source_pool,
            reasonKey: autoReasonKey(item),
            fromKey,
            transition: item.transition,
            bpm: item.analysis?.bpm,
            key: item.analysis?.key,
            sourceSetId: item.source_set_id,
            sourceSetLabel: item.source_set_label,
            lineage: item.lineage
          };
          fromKey = queueIdentity(entry);
        }
        const following = state.playback.queue[at + entries.length];
        if (following && response.following_transition) {
          plan[following.queueId] = {
            ...(plan[following.queueId] ?? {
              trackId: queueIdentity(following),
              source: 'local',
              reasonKey: 'autoMode.reason.library'
            }),
            fromKey,
            transition: response.following_transition
          };
        }
        setState('autoMode', {
          plan,
          activity: {
            id: ++generatedActivityId,
            status: 'done',
            key: 'autoMode.agent.placed',
            values: {
              title: track.title
            }
          }
        });
        const insertedIds = new Set(entries.map(entry => entry.queueId));
        toast.action(tr('autoMode.note.added', {
          title: track.title
        }), tr('common.undo'), () => {
          if (!state.autoMode.active) return;
          setState('playback', 'queue', queue => queue.filter(entry => !insertedIds.has(entry.queueId)));
          setState('autoMode', 'plan', current => Object.fromEntries(Object.entries(current).filter(([queueId]) => !insertedIds.has(queueId))));
          void generatedQueue?.ensureRunway();
        });
        ports.prefetchUpcoming();
      } catch {
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        // The user's placement is authoritative even if musical analysis is not.
        setState('playback', 'queue', queue => [...queue.slice(0, fallbackIndex), occurrence, ...queue.slice(fallbackIndex)]);
        setState('autoMode', 'activity', {
          id: ++generatedActivityId,
          status: 'error',
          key: 'autoMode.agent.placedFallback',
          values: {
            title: track.title
          }
        });
        ports.prefetchUpcoming();
      }
    },
    async repairAutoRoute(): Promise<void> {
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active || state.autoMode.repairing) return;
      const floor = insertionFloor();
      const seed = state.playback.queue[floor] ?? state.playback.currentTrack;
      const fullRoute = state.playback.queue.slice(floor + 1);
      const route = fullRoute.slice(0, 16);
      const untouchedTail = fullRoute.slice(16);
      // One seam is a transition, not a route. There is nothing to re-seam.
      if (!seed || route.length < 2) return;
      const sessionEpoch = autoSessionEpoch;
      const routeSignature = fullRoute.map(entry => entry.queueId).join('|');
      const previousQueue = state.playback.queue.slice();
      const previousPlan = {
        ...state.autoMode.plan
      };
      const previousStaleSeams = state.autoMode.staleSeams.slice();
      const anchors = route.filter(entry => autoRouteKind(entry) === 'user').map(entry => entry.queueId);
      setState('autoMode', {
        repairing: true,
        activity: {
          id: ++generatedActivityId,
          status: 'working',
          key: 'autoMode.agent.repairing'
        }
      });
      try {
        const response = await api.repairDjRoute({
          dj_profile: state.autoMode.djProfile,
          seed: djItemRef(seed),
          route: route.map(entry => ({
            ...djItemRef(entry),
            queue_id: entry.queueId,
            route_kind: autoRouteKind(entry)
          })),
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: state.autoMode.directionRevision ?? 0,
          sources: state.autoMode.sources.map(({
            id,
            label,
            tracks,
            activation
          }) => ({
            id,
            label,
            tracks,
            activation
          })),
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) {
          return;
        }
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        const currentFloor = insertionFloor();
        const unchanged = state.playback.queue.slice(currentFloor + 1).map(entry => entry.queueId).join('|') === routeSignature;
        // A handoff that committed mid-flight moves the floor, so it shows up
        // here as a changed route and is caught by the same check.
        if (!unchanged) {
          setState('autoMode', 'activity', {
            id: ++generatedActivityId,
            status: 'error',
            key: 'autoMode.agent.repairSkipped'
          });
          return;
        }
        // Cheap insurance against a server regression: a repair that lost one of
        // the listener's songs does nothing at all, rather than losing it here.
        const returned = response.items.filter(item => item.route_kind === 'user').map(item => item.queue_id ?? '');
        if (returned.join('|') !== anchors.join('|')) {
          setState('autoMode', 'activity', {
            id: ++generatedActivityId,
            status: 'error',
            key: 'autoMode.agent.repairSkipped'
          });
          return;
        }
        const byQueueId = new Map(route.map(entry => [entry.queueId, entry] as const));
        const entries = response.items.map(item => {
          const kept = item.queue_id ? byQueueId.get(item.queue_id) : undefined;
          const autoRoute = item.route_kind === 'bridge' ? {
            kind: 'bridge' as const,
            ownerQueueId: item.owner_queue_id
          } : {
            kind: 'generated' as const,
            directionRevision: state.autoMode.directionRevision ?? 0
          };
          // Spreading the kept entry preserves its lane and context, which is how
          // an explicitly queued song stays an explicit request through a repair.
          if (kept) return item.route_kind === 'user' ? kept : {
            ...kept,
            autoRoute
          };
          return {
            ...createQueueEntry(planItemTrack(item), 'generated', 'auto_mode'),
            autoRoute
          };
        });
        setState('playback', 'queue', queue => [...queue.slice(0, floor + 1), ...entries, ...untouchedTail]);

        // Everything up to and including the floor keeps its plan. Wiping it
        // wholesale would strip the cued handoff's own entry and turn a blend
        // that is already loaded into a fade at the moment it fires.
        const prefix = new Set(state.playback.queue.slice(0, floor + 1).map(entry => entry.queueId));
        const plan: Record<string, AutoPlanItem> = Object.fromEntries(Object.entries(state.autoMode.plan).filter(([id]) => prefix.has(id) || untouchedTail.some(row => row.queueId === id)));
        let fromKey = queueIdentity(state.playback.queue[floor] ?? seed);
        entries.forEach((entry, index) => {
          const item = response.items[index];
          // The server rebuilds a kept row as a generic "Route" item, so its own
          // provenance is the better answer for where the song came from.
          const held = previousPlan[entry.queueId];
          plan[entry.queueId] = {
            ...held,
            trackId: queueIdentity(entry),
            source: item.source_pool,
            reasonKey: held?.reasonKey ?? autoReasonKey(item),
            sourceSetId: held?.sourceSetId ?? item.source_set_id,
            sourceSetLabel: held?.sourceSetLabel ?? item.source_set_label,
            lineage: held?.lineage ?? item.lineage,
            fromKey,
            transition: item.transition,
            bpm: item.analysis?.bpm,
            key: item.analysis?.key
          };
          fromKey = queueIdentity(entry);
        });
        setState('autoMode', {
          plan,
          // Only the analysed horizon was repaired. Keep the untouched tail
          // visible and mark its joins for planning as playback approaches.
          staleSeams: untouchedTail.map(row => row.queueId),
          activity: {
            id: ++generatedActivityId,
            status: 'done',
            key: 'autoMode.agent.repaired'
          }
        });
        ports.prefetchUpcoming();
        toast.action(tr('autoMode.note.repaired'), tr('common.undo'), () => {
          if (!state.autoMode.active || autoSessionEpoch !== sessionEpoch) return;
          if (insertionFloor() !== floor) return;
          if (state.playback.queue[floor]?.queueId !== previousQueue[floor]?.queueId) return;
          setState('playback', 'queue', previousQueue);
          setState('autoMode', {
            plan: previousPlan,
            staleSeams: previousStaleSeams
          });
          ports.prefetchUpcoming();
        });
      } catch {
        if (!isCurrent()) {
          return;
        }

        // Nothing was written — the queue is only touched once an answer lands —
        // so there is no half-repaired route to unwind.
        setState('autoMode', 'activity', {
          id: ++generatedActivityId,
          status: 'error',
          key: 'autoMode.agent.repairFailed'
        });
      } finally {
        setState('autoMode', 'repairing', false);
      }
    },
    async autoSkip(): Promise<void> {
      const isCurrent = lifetime.capture();
      const canAdvance = () => state.playback.index < state.playback.queue.length - 1;
      if (audioService.mixPhase() !== 'idle') {
        // A handoff is already prepared or under way. Bring it forward; the mixer
        // always does something with that, and says what.
        const skipped = state.playback.currentTrack;
        const owned = audioService.mixIsDominant();
        const outcome = audioService.startMixNow();
        if (outcome === 'staged') {
          // The next song could not be blended in yet: hand it over the way any
          // other skip would, from the deck that was already holding it.
          ports.listeningLearning.skip(skipped, playingDuration());
          ports.actions.next();
          void generatedQueue?.ensureRunway();
          return;
        }
        if (outcome === 'blend' || outcome === 'finished' && !owned) {
          ports.listeningLearning.skip(skipped, playingDuration());
          void generatedQueue?.ensureRunway();
          return;
        }
        // The blend had already handed over, so the listener is skipping the
        // song they now hear; or the prepared song could not play at all. Either
        // way, skip from where playback stands now.
      }
      if (canAdvance()) {
        const pb = state.playback;
        const next = pb.queue[pb.index + 1];
        const current = pb.currentTrack;
        ports.listeningLearning.skip(current, playingDuration());
        if (audioService.mixPhase() !== 'idle') {
          audioService.cancelMix('superseded');
          ports.actions.next();
        } else if (next && current) {
          const fromKey = queueIdentity(current);
          const item = state.autoMode.plan[next.queueId];
          const chained = item?.fromKey === fromKey ? item.transition : undefined;
          const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
          commitTransition(next, fromKey, {
            technique: trusted ? chained!.technique : 'safe_fade',
            out_cue: 0,
            // a manual skip blends from wherever the track is now
            in_cue: trusted ? chained!.in_cue : 0,
            overlap_seconds: 1.6,
            overlap_bars: chained?.overlap_bars ?? 0,
            playback_rate: trusted ? chained!.playback_rate : 1,
            confidence: chained?.confidence ?? 0
          }, true);
        } else {
          ports.actions.next();
        }
        void generatedQueue?.ensureRunway();
        return;
      }
      await generatedQueue?.refillNow();
      if (!isCurrent()) {
        return;
      }

      // A failed final URL can happen while a refill is already in flight. Wait
      // briefly for that real plan instead of leaving Auto stopped on the error.
      for (let attempt = 0; attempt < 28 && state.autoMode.active; attempt += 1) {
        if (canAdvance()) {
          ports.actions.next();
          return;
        }
        await new Promise(resolve => lifetime.setTimeout(() => resolve(undefined), 250));
        if (!isCurrent()) {
          return;
        }
      }
    },
    promoteInAutoRoute(queueId: string): void {
      const pb = state.playback;
      const from = pb.queue.findIndex(entry => entry.queueId === queueId);
      const to = insertionFloor() + 1;
      if (from <= pb.index || from === to || to > from) return;
      const queue = pb.queue.slice();
      const [entry] = queue.splice(from, 1);
      queue.splice(to, 0, entry);
      setState('playback', 'queue', queue);
      ports.prefetchUpcoming();
    },
    moveAutoRoute(queueId: string, beforeQueueId?: string): void {
      if (!state.autoMode.active || queueId === beforeQueueId) return;
      const source = state.playback.queue.find(entry => entry.queueId === queueId);
      if (!source) return;
      // Grabbing a bridge is a request to move what it leads into: on its own it
      // connects nothing, and leaving it behind would strand its owner.
      const ownerId = source.autoRoute?.kind === 'bridge' && source.autoRoute.ownerQueueId ? source.autoRoute.ownerQueueId : queueId;
      const blockIds = new Set(state.playback.queue.filter(entry => entry.queueId === ownerId || entry.autoRoute?.kind === 'bridge' && entry.autoRoute.ownerQueueId === ownerId).map(entry => entry.queueId));
      if (!blockIds.has(ownerId) || beforeQueueId && blockIds.has(beforeQueueId)) return;
      const floor = insertionFloor();
      const start = state.playback.queue.findIndex(entry => blockIds.has(entry.queueId));
      if (start <= floor) return;
      const block = state.playback.queue.filter(entry => blockIds.has(entry.queueId));
      const rest = state.playback.queue.filter(entry => !blockIds.has(entry.queueId));
      // Everything before the block is untouched by lifting it out, so the row
      // that closes over the gap is the one that lands on its old index.
      const closed = rest[start]?.queueId;
      const target = beforeQueueId ? rest.findIndex(entry => entry.queueId === beforeQueueId) : rest.length;
      // Never in front of a handoff that is already loaded. The route panel stops
      // offering that seam; this is what happens if anything else asks for it.
      const at = Math.max(floor + 1, target === -1 ? rest.length : target);
      const moved = block.map(entry => entry.queueId === ownerId ? {
        ...entry,
        autoRoute: {
          kind: 'user' as const,
          placement: 'fixed' as const
        }
      } : entry);
      const queue = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
      const opened = [moved[0].queueId, closed, rest[at]?.queueId].filter((id): id is string => Boolean(id));
      setState('playback', 'queue', queue);
      setState('autoMode', 'staleSeams', seams => {
        const live = new Set(queue.map(entry => entry.queueId));
        return [...new Set([...seams.filter(id => live.has(id)), ...opened])];
      });
      ports.prefetchUpcoming();
      const owner = block.find(entry => entry.queueId === ownerId) ?? source;
      toast.action(tr('autoMode.route.moved', {
        title: owner.title
      }), tr('autoMode.route.fix'), () => {
        if (state.autoMode.active) void ports.actions.repairAutoRoute();
      });
    },
    async startRadio(seed: Track): Promise<void> {
      const isCurrent = lifetime.capture();
      if (isPodcastTrack(seed)) {
        toast.error(tr('toast.radioUnavailable'));
        return;
      }
      if (state.autoMode.active) {
        await confirmNormalMode('radio', () => ports.actions.startRadio(seed));
        if (!isCurrent()) {
          return;
        }
        return;
      }
      const t = toast.loading(tr('toast.startingRadio'));
      ports.discardFutureAutoplay();
      ports.cancelPendingRadio();
      setState('playback', {
        radioMode: true,
        radioLoading: true,
        radioSeedId: seed.id
      });
      const isCurrentPlaying = state.playback.currentTrack?.id === seed.id && state.playback.isPlaying;
      if (isCurrentPlaying) {
        ports.abandonContextMatches();
        const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
        setState('playback', {
          queue: [createQueueEntry(seed, 'context', 'radio', {
            id: `radio:${seed.id}`,
            kind: 'single',
            label: seed.title
          }), ...manual],
          index: 0
        });
      } else {
        ports.actions.playFrom([seed], 0, {
          radio: true
        });
      }
      const ready = await ensureGeneratedQueue().start('radio', seed);
      if (!isCurrent()) {
        return;
      }
      if (generatedQueue?.activeIntent() !== 'radio' || !state.playback.radioMode || state.playback.radioSeedId !== seed.id) {
        t.dismiss();
        return;
      }
      if (ready) {
        void api.emitDiscoveryEvent('music_started_radio', {
          track_id: seed.source === 'preview' ? undefined : seed.id,
          title: seed.title,
          artist: seed.artist,
          album: seed.album,
          youtube_id: seed.youtube_id ?? (seed.source === 'preview' ? seed.id : undefined),
          source: seed.source ?? 'library'
        }).catch(lifetime.guard(() => {}));
        t.update('success', tr('toast.radioStarted'));
      } else {
        t.update('error', tr('toast.radioFailed', {
          ytId: seed.youtube_id || tr('toast.radioFailedFallback')
        }));
        generatedQueue.stop('radio');
        const cur = state.playback.queue[state.playback.index];
        const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
        setState('playback', {
          radioMode: false,
          radioLoading: false,
          radioSeedId: null,
          queue: cur ? [cur, ...manual] : manual,
          index: cur ? 0 : -1
        });
      }
    },
    stopRadio(): void {
      ports.cancelPendingRadio();
      const cur = state.playback.queue[state.playback.index];
      const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
      setState('playback', {
        radioMode: false,
        radioLoading: false,
        radioSeedId: null,
        queue: cur ? [cur, ...manual] : manual,
        index: cur ? 0 : -1
      });
    },
    async setAutoplayEnabled(enabled: boolean): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const previous = state.playback.autoplayEnabled;
      if (enabled === previous) return true;
      setState('playback', 'autoplayEnabled', enabled);
      if (enabled) queueMicrotask(() => void ensureAutoplay(true));else ports.discardFutureAutoplay();
      try {
        await api.setAutoplayEnabled(enabled);
        if (!isCurrent()) {
          return false;
        }
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        setState('playback', 'autoplayEnabled', previous);
        if (previous) queueMicrotask(() => void ensureAutoplay(true));
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    }
  };
  return {
    dispose() {
      ++autoSessionEpoch;
      autoOpeningAborter?.abort();
      generatedQueue?.stop();
      generatedQueue = null;
    },
    actions: domainActions,
    onPreviewPreparation,
    get generatedQueue() {
      return generatedQueue;
    },
    set generatedQueue(value: GeneratedQueueController | null) {
      generatedQueue = value;
    },
    ensureAutoplay,
    resumeFromStarved,
    insertionFloor,
    boundaryFacts,
    playingDuration,
    get PREMATURE_END_SECONDS() {
      return PREMATURE_END_SECONDS;
    },
    promotePreparedAutoSuccessor,
    enterStarved,
    confirmNormalMode,
    mixAutoTrackNow,
    ensureGeneratedQueue,
    get commitSeq() {
      return commitSeq;
    },
    set commitSeq(value: number) {
      commitSeq = value;
    },
    get committedTransition() {
      return committedTransition;
    },
    set committedTransition(value: CommittedTransition | null) {
      committedTransition = value;
    },
    get autoSessionEpoch() {
      return autoSessionEpoch;
    },
    set autoSessionEpoch(value: number) {
      autoSessionEpoch = value;
    },
    get autoPlaybackPrefs() {
      return autoPlaybackPrefs;
    },
    set autoPlaybackPrefs(value: {
      shuffle: boolean;
      repeat: RepeatMode;
    } | null) {
      autoPlaybackPrefs = value;
    },
    rememberDjExploration,
    evaluateDjRunway,
    watchRunway
  };
}
