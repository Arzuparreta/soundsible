import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { createDjEvidence } from '../lib/djEvidence';
import { recordPlaybackDiagnostic, setDiagnosticContext } from '../lib/playbackDiagnostics';
import { api, type DjPlanResponse, type ListeningPlanItem, type ListeningPlanResponse } from '../lib/api';
import { audioService, type LiveTransitionPlan } from '../lib/audio';
import { type MediaSessionSyncReason } from '../lib/mediaSession';
import { playbackYoutubeId } from '../lib/media';
import { createPreparationOwner } from '../lib/prefetch';
import { setDjWork } from '../lib/http';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { isPodcastTrack } from '../lib/track';
import { queueIdentity, queueIndexOf } from '../lib/queueDiscovery';
import type { AutoActivity, AutoMusicSet, AutoPlanItem, GeneratedQueueController } from '../lib/generatedQueue';
import { t as tr } from '../lib/i18n';
import { ListeningLearning } from '../lib/listeningLearning';
import { createQueueEntry, futureEntries, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { shuffled } from '../lib/shuffle';
import {
  editableFrom,
  insertionFloor as committedFloor,
  moveRouteBlock,
  removedOccurrences,
  repairHorizon,
  requestInsertion,
  routeBlock,
  routeKind,
  routeRows,
  sessionSurvivors,
} from '../lib/djRoute';
import { IMMEDIATE_TRANSITION, TRUSTED_CONFIDENCE, resolveTransition, skipTransition, unmixed } from '../lib/djTransition';
import { autoReasonKey, djItemRef, planItemTrack, routePlanEntry } from '../lib/planItems';
import type { Track } from '../types/music';
import { favouriteTracks, musicLibrary } from './identity';
import { state, setState, setNowPlayingOpen, randomId, type RepeatMode } from './core';
import type { PlayerActions, PlaybackTrigger, PlaybackAttempt, CommittedTransition, PublishedPlaybackState } from './contracts';
import type { DjRunwayPort } from './runway';

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
  actions: Pick<PlayerActions, 'addAutoSource' | 'enterAutoMode' | 'exitAutoMode' | 'next' | 'placeAutoTrack' | 'placeAutoTracks' | 'repairAutoRoute' | 'resumePlayback' | 'retryCurrent'>;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
  trackPrepared: (track: Track) => boolean;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  loadIndex: (i: number) => void;
  updateUpcomingPreparation: () => void;
  abandonContextMatches: (keep?: (queueId: string) => boolean) => void;
  /** The generated lanes this session's runway is planned through. */
  runway: {
    ensureGeneratedQueue: () => GeneratedQueueController;
    readonly generatedQueue: GeneratedQueueController | null;
    enterStarved: () => void;
    promotePreparedAutoSuccessor: () => boolean;
  };
}

const COMMIT_LEAD_SECONDS = 45;
const IDLE_TRANSITION = {
  status: 'idle',
  technique: undefined,
  nextTrackId: undefined,
  at: undefined
} as const;
const MAX_CONSECUTIVE_AUTO_HANDOFF_FAILURES = 2;
const AUTO_HANDOFF_COOLDOWN_MS = 30_000;
const REFINE_RETRY_MS = 2_000;
const REPLAN_DEBOUNCE_MS = 800;
const REPAIR_LIMIT = 16;
const AUTO_OPENING_MIN_FAVOURITES = 8;
const AUTO_OPENING_SAMPLE = 40;

/**
 * Owns the DJ session: its sources and direction, the handoffs between songs,
 * and the listener's edits to the route. Route rules live in `lib/djRoute.ts`
 * and are shared with Android; the generated runway is planned through
 * `ports.runway`, which this session plugs into with `runwayPort`.
 */
export function createDj(ports: DjPorts, lifetime: RuntimeLifetime) {
  const evidence = createDjEvidence(recordPlaybackDiagnostic, randomId);
  lifetime.own(setDiagnosticContext(() => evidence.context()));
  function syncEvidence(): void { evidence.sync(state.autoMode.active, state.autoMode.directionRevision ?? 0); }
  const generated = () => ports.runway.generatedQueue;
  let autoPlaybackPrefs: {
    shuffle: boolean;
    repeat: RepeatMode;
  } | null = null;
  let autoSessionEpoch = 0;
  let generatedActivityId = 0;
  function activity(status: AutoActivity['status'], key: string, values?: AutoActivity['values']): AutoActivity {
    return { id: ++generatedActivityId, status, key, values };
  }
  function directionRevision(): number {
    return state.autoMode.directionRevision ?? 0;
  }
  function sourceBodies() {
    return state.autoMode.sources.map(({ id, label, tracks, activation }) => ({ id, label, tracks, activation }));
  }
  function routeEntry(track: Track, revision = directionRevision()): PlaybackQueueEntry {
    return { ...createQueueEntry(track, 'generated', 'auto_mode'), autoRoute: { kind: 'generated', directionRevision: revision } };
  }

  // --- Work the engine does for this session --------------------------------
  const workClient = `dj-${randomId()}`;
  let workRevision = 0;
  let workSignature = '';
  let workUpdatedAt = 0;
  function activateDjWork(): void {
    setDjWork({ client: workClient, epoch: autoSessionEpoch });
  }
  function syncDjWork(): void {
    if (!state.autoMode.active) return;
    activateDjWork();
    // Match the planner's eight-song runway rather than acquiring every
    // distant manual request the listener may have queued.
    const tracks = state.playback.queue.slice(Math.max(0, state.playback.index), Math.max(0, state.playback.index) + 9).map(djItemRef);
    const signature = JSON.stringify([autoSessionEpoch, tracks]);
    if (signature === workSignature && Date.now() - workUpdatedAt < 15_000) return;
    if (signature !== workSignature) ++workRevision;
    workSignature = signature;
    workUpdatedAt = Date.now();
    void api.updateDjWork?.({ active: true, revision: workRevision, tracks }).catch(() => { workSignature = ''; });
  }
  function releaseDjWork(): void {
    void api.updateDjWork?.({ active: false, revision: ++workRevision },
      { client: workClient, epoch: autoSessionEpoch }).catch(() => {});
    workSignature = '';
    setDjWork(undefined);
    refinementAborter?.abort();
    refinement = { pair: '', inFlight: false, nextAt: 0, measured: false };
  }

  // --- Handoffs ---------------------------------------------------------------
  let pendingImmediateAutoTrack: Track | null = null;
  let autoOpeningAborter: AbortController | null = null;
  let autoOpeningRetry: ReturnType<typeof setTimeout> | null = null;
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
  function insertionFloor(): number {
    return committedFloor(state.playback.queue, state.playback.index, committedTransition?.queueId);
  }
  /** The first queue index a route edit may touch. */
  function routeStart(): number {
    return editableFrom(routeRows(state.playback.queue), state.playback.index, insertionFloor());
  }
  function adoptHandoffAttempt(track: PlaybackQueueEntry): void {
    const attempt = ports.createPlaybackAttempt(track, ports.beginLoad(), 'handoff');
    attempt.audibleAt = performance.now();
  }
  function commitTransition(next: PlaybackQueueEntry, fromKey: string, planned: LiveTransitionPlan, manual: boolean): void {
    syncEvidence();
    const plan = state.playback.djMixing ? planned : unmixed(planned);
    const owned = evidence.arm(fromKey, next.queueId, plan, manual, state.playback.djMixing);
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
        evidence.outcome(owned, 'dominant');
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
        evidence.outcome(owned, 'completed');
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
          void generated()?.ensureRunway();
        }
      },
      onCancel: reason => {
        if (!owns()) return;
        evidence.outcome(owned, 'cancelled', reason);
        committedTransition = null;
        setState('autoMode', 'transition', IDLE_TRANSITION);
      },
      onStaged: () => {
        if (!owns()) return;
        evidence.outcome(owned, 'staged');
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
        evidence.outcome(owned, 'failed');
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
          if (ports.runway.promotePreparedAutoSuccessor()) ports.actions.next('ended');else {
            ports.prefetchUpcoming();
            ports.runway.enterStarved();
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
      diagnostic: owned,
      level: ports.levelFor(next)
    });
  }
  let refinement = { pair: '', inFlight: false, nextAt: 0, measured: false };
  let refinementAborter: AbortController | null = null;
  function autoRecommendationIdentity(track: Track): string {
    if (track.recommendation?.identity) return track.recommendation.identity;
    return track.source === 'preview' ? `music:youtube:${track.youtube_id || track.id}` : `music:track:${track.id}`;
  }
  function maybeRefineTransition(current: Track, next: PlaybackQueueEntry, fromKey: string): void {
    const toKey = queueIdentity(next);
    const pair = `${fromKey}>${toKey}`;
    const phase = audioService.mixPhase();
    if (phase !== 'idle' && phase !== 'armed') return;
    if (committedTransition && committedTransition.queueId !== next.queueId) return;
    if (refinement.pair !== pair) {
      refinementAborter?.abort();
      refinement = { pair, inFlight: false, nextAt: 0, measured: false };
    }
    const attempt = refinement;
    if (attempt.inFlight || attempt.measured || performance.now() < attempt.nextAt) return;
    const item = state.autoMode.plan[next.queueId];
    if (!item || item.fromKey !== fromKey) return;
    if ((item.transition?.confidence ?? 0) >= TRUSTED_CONFIDENCE) return;
    attempt.inFlight = true;
    const aborter = new AbortController();
    refinementAborter = aborter;
    attempt.nextAt = performance.now() + REFINE_RETRY_MS;
    const revision = state.autoMode.directionRevision;
    void api.refineDjTransition({
      from: djItemRef(current),
      to: djItemRef(next)
    }, aborter.signal).then(lifetime.guard(result => {
      if (state.autoMode.active && refinement === attempt && state.autoMode.directionRevision === revision) {
        evidence.refine(fromKey, next.queueId, result.analysis?.from, result.analysis?.to, result.transition, false);
      }
      if (!result.measured || !state.autoMode.active || refinement !== attempt) return;
      if (state.autoMode.directionRevision !== revision || state.autoMode.plan[next.queueId] !== item) return;
      if (committedTransition) {
        if (committedTransition.queueId !== next.queueId || audioService.mixPhase() !== 'armed'
            || (result.transition.out_cue ?? 0) < state.playback.currentTime + 5) return;
        // Loading bytes is reversible while the incoming deck remains silent.
        ++commitSeq;
        committedTransition = null;
        audioService.cancelMix('superseded');
        setState('autoMode', 'transition', IDLE_TRANSITION);
      }
      attempt.measured = true;
      evidence.refine(fromKey, next.queueId, result.analysis?.from, result.analysis?.to, result.transition, true);
      setState('autoMode', 'plan', next.queueId, 'transition', result.transition);
      setState('autoMode', 'staleSeams', seams => seams.filter(id => id !== next.queueId));
      evaluateDjRunway();
    })).catch(lifetime.guard(() => {
      /* the conservative plan stands until the next bounded attempt */
    })).finally(() => {
      attempt.inFlight = false;
      if (refinementAborter === aborter) refinementAborter = null;
    });
  }
  function evaluateDjRunway(): void {
    syncDjWork();
    if (!state.autoMode.active) return;
    if (committedTransition) {
      const current = state.playback.currentTrack;
      const next = state.playback.queue[state.playback.index + 1];
      if (current && next && state.playback.djMixing && audioService.mixPhase() === 'armed') {
        maybeRefineTransition(current, next, queueIdentity(current));
      }
      return;
    }
    if (audioService.mixPhase() !== 'idle') return;
    if (performance.now() < autoHandoffCooldownUntil) return;
    const pb = state.playback;
    const current = pb.currentTrack;
    const next = pb.queue[pb.index + 1];
    if (!current || !next || pb.loadError) return;
    if (!ports.trackPrepared(next)) {
      const videoId = playbackYoutubeId(next);
      if (videoId) ports.prefetchUpcoming();
      ports.runway.promotePreparedAutoSuccessor();
      return;
    }
    const fromKey = queueIdentity(current);
    const entry = state.autoMode.plan[next.queueId];
    if (entry && entry.fromKey !== fromKey) {
      setState('autoMode', 'plan', next.queueId, { ...entry, fromKey, transition: undefined });
      refinement = { pair: '', inFlight: false, nextAt: 0, measured: false };
    }
    const plan = resolveTransition(fromKey, playingDuration(), state.autoMode.plan[next.queueId], state.playback.djMixing);
    if (!plan) return;
    // A measured blend is only worth asking for when there will be a blend.
    if (state.playback.djMixing && pb.currentTime < plan.out_cue - COMMIT_LEAD_SECONDS) {
      maybeRefineTransition(current, next, fromKey);
    }
    if (pb.currentTime < plan.out_cue - COMMIT_LEAD_SECONDS) return;
    commitTransition(next, fromKey, plan, false);
  }
  function explicitAutoRunway(): PlaybackQueueEntry[] {
    return futureEntries(state.playback.queue, state.playback.index).filter(entry => routeKind(entry) === 'user');
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
      setState('autoMode', 'activity', activity('working', 'autoMode.agent.immediateQueued', { title: track.title }));
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
      activity: activity('working', 'autoMode.agent.mixingImmediate', { title: track.title })
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
      void ports.runway.ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
      return;
    }
    const prefix = pb.queue.slice(0, pb.index + 1);
    setState('playback', {
      queue: [...prefix, requested, ...explicit],
      radioMode: false,
      radioLoading: false,
      radioSeedId: null
    });
    commitTransition(requested, queueIdentity(current), IMMEDIATE_TRANSITION, true);
    void ports.runway.ensureGeneratedQueue().start('auto_mode', requested, state.autoMode.profile);
  }
  function rememberDjExploration(): void {
    if (!state.autoMode.active) return;
    const entry = state.playback.queue[state.playback.index];
    if (entry?.autoRoute?.kind !== 'generated' || entry.autoRoute.directionRevision !== directionRevision()) return;
    const roots = state.autoMode.exploration ?? [];
    const identity = queueIdentity(entry);
    if (roots.some(track => queueIdentity(track) === identity)) return;
    setState('autoMode', 'exploration', [...roots, entry].slice(-4));
    void generated()?.ensureRunway();
  }

  // --- Opening a session ------------------------------------------------------
  function startAutoFromSourcePlan(response: DjPlanResponse): boolean {
    if (!response.opening) return false;
    syncEvidence();
    evidence.route(response);
    const opening = planItemTrack(response.opening, state.library);
    const openingEntry = routeEntry(opening);
    const candidates = response.items
      .map(item => ({ item, track: planItemTrack(item, state.library) }))
      .filter(({ track }) => queueIndexOf([openingEntry], track) === -1);
    const entries = candidates.map(({ track }) => routeEntry(track));
    const plan: Record<string, AutoPlanItem> = {};
    let fromKey = queueIdentity(openingEntry);
    candidates.forEach(({ item }, index) => {
      const entry = entries[index];
      evidence.select(fromKey, entry.queueId, index ? candidates[index - 1].item.analysis : response.opening?.analysis,
        item.analysis, item.transition, response);
      plan[entry.queueId] = {
        ...routePlanEntry(item, queueIdentity(entry), fromKey),
        reasonValues: item.source_pool === 'related' ? { title: opening.title } : undefined,
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
    ports.runway.ensureGeneratedQueue().adopt('auto_mode', openingEntry, state.autoMode.profile, {
      sessionId: response.session_id,
      nextSegmentIndex: (response.segment_index ?? 0) + 1
    });
    setState('autoMode', {
      heard: [opening],
      plan,
      staleSeams: [],
      phase: entries.length ? 'ready' : response.warming ? 'warming' : 'degraded',
      activity: activity('done', 'autoMode.agent.openedSource', { title: opening.title })
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
    activateDjWork();
    autoOpeningAborter?.abort();
    const aborter = new AbortController();
    autoOpeningAborter = aborter;
    setState('autoMode', {
      phase: 'planning',
      activity: activity('working', 'autoMode.agent.openingSource')
    });
    try {
      const response = await api.planDjQueue({
        session_id: randomId(),
        segment_index: 0,
        source_policy: 'explicit',
        exploration: state.autoMode.exploration ?? [],
        direction_revision: directionRevision(),
        sources: sourceBodies(),
        heard: [],
        exclude: state.autoMode.avoidedIdentities,
        limit: 8
      }, aborter.signal);
      if (!isCurrent()) return;
      if (aborter.signal.aborted || !state.autoMode.active || sessionEpoch !== autoSessionEpoch || state.playback.currentTrack) return;
      if (!startAutoFromSourcePlan(response)) throw new Error('no opening');
    } catch {
      if (!isCurrent()) return;
      if (aborter.signal.aborted || !state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
      setState('autoMode', {
        phase: 'degraded',
        activity: activity('error', 'autoMode.agent.openingFailed')
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
      activity: activity('working', 'autoMode.agent.openingSource')
    });
    let recommended: Track[] = [];
    try {
      const feed = await api.getDiscoveryMusicFeed(aborter.signal);
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
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
      activity: activity('error', 'autoMode.noSeed')
    });
  }
  async function confirmNormalMode(kind: 'podcast' | 'radio', proceed: () => void | Promise<void>): Promise<void> {
    const isCurrent = lifetime.capture();
    const ok = await confirmDialog({
      title: tr('modeChange.toNormalTitle'),
      message: tr(kind === 'podcast' ? 'modeChange.podcastMessage' : 'modeChange.radioMessage'),
      confirmLabel: tr(kind === 'podcast' ? 'modeChange.playPodcast' : 'modeChange.startRadio')
    });
    if (!isCurrent()) return;
    if (!ok || !state.autoMode.active) return;
    ports.actions.exitAutoMode();
    await proceed();
  }

  // --- Route edits --------------------------------------------------------------
  function dropAutoRouteOccurrence(queueId: string): PlaybackQueueEntry | null {
    if (!state.autoMode.active || committedTransition?.queueId === queueId) return null;
    const track = state.playback.queue.find(entry => entry.queueId === queueId);
    if (!track) return null;
    const owned = new Set(removedOccurrences(routeRows(state.playback.queue), queueId));
    setState('playback', 'queue', queue => queue.filter(entry => !owned.has(entry.queueId)));
    setState('autoMode', 'plan', plan => Object.fromEntries(Object.entries(plan).filter(([id]) => !owned.has(id))));
    setState('autoMode', 'staleSeams', seams => seams.filter(id => !owned.has(id)));
    ports.updateUpcomingPreparation();
    void generated()?.ensureRunway();
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
  /** Where a request in front of `before` goes: the start of that block when
   * it is editable, otherwise nowhere fixed. */
  function requestDestination(before: string | undefined): string | undefined {
    if (!before) return undefined;
    const queue = state.playback.queue;
    const anchor = routeBlock(routeRows(queue), before)?.[0];
    const index = anchor === undefined ? -1 : queue.findIndex(entry => entry.queueId === anchor);
    return index >= routeStart() ? anchor : undefined;
  }
  function insertRequests(occurrences: PlaybackQueueEntry[], before: string | undefined): void {
    const at = requestInsertion(routeRows(state.playback.queue), routeStart() - 1, before);
    setState('playback', 'queue', queue => [...queue.slice(0, at), ...occurrences, ...queue.slice(at)]);
  }
  function routeSignature(start = routeStart()): string {
    return state.playback.queue.slice(start).map(entry => entry.queueId).join('|');
  }
  let replanTimer: ReturnType<typeof setTimeout> | null = null;
  let replanNote = '';
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
    const revision = directionRevision() + 1;
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
    const floor = current ? routeStart() - 1 : pb.index;
    const anchor = pb.queue[floor] ?? current;
    const leadEntry = lead && anchor && queueIndexOf([anchor], lead) !== 0 ? routeEntry(lead, revision) : null;
    // A request for the very song the session now starts from is that start.
    const future = pb.queue.slice(floor + 1);
    const survivors = new Set(sessionSurvivors(routeRows(future), leadEntry ? queueIdentity(leadEntry) : undefined));
    const kept = future.filter(entry => survivors.has(entry.queueId));
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
      activity: activity('working', 'autoMode.agent.sourceChanged', { title: source.label })
    });
    ports.updateUpcomingPreparation();
    if (!current) {
      // Nothing to mix out of: the planner opens inside the new source.
      generated()?.stop('auto_mode');
      void startAutoFromSources();
    } else {
      // The DJ's own measurement of the seam into the chosen song, asked for now
      // rather than a minute before the end — it may well leave sooner.
      if (leadEntry && anchor) maybeRefineTransition(anchor, leadEntry, queueIdentity(anchor));
      void ports.runway.ensureGeneratedQueue().start('auto_mode', queue.at(-1) ?? current, state.autoMode.profile);
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
      activity: activity('working', 'autoMode.agent.heard', { note })
    });
    replanTimer = lifetime.setTimeout(() => {
      replanTimer = null;
      setState('autoMode', 'pendingDirection', false);
      if (state.autoMode.active) void ports.runway.ensureGeneratedQueue().replan(state.autoMode.profile);
    }, REPLAN_DEBOUNCE_MS);
  }
  function cancelRunwayReplan(): void {
    if (replanTimer) lifetime.clearTimeout(replanTimer);
    replanTimer = null;
    replanNote = '';
    setState('autoMode', 'pendingDirection', false);
  }

  // --- The runway's DJ intent ---------------------------------------------------
  const runwayPort: DjRunwayPort = {
    committedQueueId: () => committedTransition?.queueId ?? null,
    activateWork: activateDjWork,
    syncEvidence,
    planningContext: () => JSON.stringify([state.autoMode.directionRevision, state.autoMode.sources.map(source => [source.id, source.activation, source.tracks.map(queueIdentity)]), (state.autoMode.exploration ?? []).map(queueIdentity), state.autoMode.avoidedIdentities]),
    requestPlan(seed, limit, exclude, signal, session) {
      syncDjWork();
      if (typeof api.planDjQueue !== 'function') return null;
      return api.planDjQueue({
        session_id: session?.id,
        segment_index: session?.segmentIndex,
        context: state.autoMode.heard.slice(-8).map(djItemRef),
        seed,
        source_policy: 'explicit',
        exploration: state.autoMode.exploration ?? [],
        direction_revision: directionRevision(),
        sources: sourceBodies(),
        heard: state.autoMode.heard,
        exclude: [...new Set([...exclude, ...state.autoMode.avoidedIdentities])],
        limit
      }, signal);
    },
    acceptsPlan: response => response.direction_revision == null || response.direction_revision === directionRevision(),
    routeEntry: track => routeEntry(track),
    planApplied(response: ListeningPlanResponse, accepted: Map<ListeningPlanItem, PlaybackQueueEntry>, replace: boolean, anchor: Track) {
      syncEvidence();
      evidence.route(response);
      const plan: Record<string, AutoPlanItem> = replace ? {} : { ...state.autoMode.plan };
      // The server chains a route: item N's transition is planned out of item
      // N-1, starting at the anchor. Walk the response in order so each entry
      // records which track its cue belongs to. An item dropped as a duplicate
      // breaks the chain, and the entry behind it loses a transition it can no
      // longer honour — a plain fade, rather than a cue from the wrong song.
      let previousKey = queueIdentity(anchor);
      let previousAnalysis = (response as DjPlanResponse).seed_analysis;
      let chained = true;
      for (const item of response.items) {
        const entry = accepted.get(item);
        if (!entry) {
          chained = false;
          continue;
        }
        const id = queueIdentity(entry);
        evidence.select(previousKey, entry.queueId, chained ? previousAnalysis : undefined,
          item.analysis, chained ? item.transition : undefined, response);
        previousAnalysis = item.analysis;
        plan[entry.queueId] = {
          ...routePlanEntry(item, id, previousKey, chained ? item.transition : undefined),
          reasonValues: item.source_pool === 'related' ? { title: state.playback.currentTrack?.title ?? '' } : undefined,
        };
        previousKey = id;
        chained = true;
      }
      setState('autoMode', 'plan', plan);
      // A replacing plan re-seams every join it writes, so the only unplanned
      // ones left are those belonging to rows it was not allowed to touch.
      setState('autoMode', 'staleSeams', seams => {
        if (!replace) return seams;
        const live = new Set(state.playback.queue.map(entry => entry.queueId));
        return seams.filter(id => live.has(id) && plan[id] === undefined);
      });
      syncDjWork();
    },
    status(status, response, replacing) {
      if (status === 'idle') {
        setState('autoMode', { phase: 'idle', pendingDirection: false });
        return;
      }
      if (status === 'planning') {
        setState('autoMode', {
          phase: 'planning',
          activity: activity('working', replacing ? 'autoMode.agent.redrawing' : 'autoMode.agent.searching',
            replacing ? { note: replanNote } : { title: state.playback.currentTrack?.title ?? '' })
        });
        return;
      }
      const counts = response?.pool_counts ?? { local: 0, related: 0, discovery: 0 };
      const exhausted = status === 'exhausted';
      const degraded = status === 'degraded' || exhausted;
      setState('autoMode', {
        phase: exhausted ? 'exhausted' : status === 'warming' ? 'warming' : degraded ? 'degraded' : 'ready',
        activity: activity(degraded ? 'error' : 'done',
          exhausted ? 'autoMode.route.exhausted' : degraded ? 'autoMode.agent.retrying' : replacing ? 'autoMode.agent.steered' : 'autoMode.agent.queued', {
            note: replanNote,
            count: response?.items.length ?? 0,
            tracks: response?.items.slice(0, 2).map(item => item.title).join(' · ') ?? '',
            related: counts.related,
            node: counts.discovery,
            local: counts.local
          })
      });
    },
    dropOccurrence: dropAutoRouteOccurrence,
    confirmNormalMode,
  };

  const domainActions = {
    enterAutoMode(options?: {
      source: Track;
      deferPlanning: boolean;
    }): void {
      const current = state.playback.currentTrack;
      if (state.autoMode.active || current && isPodcastTrack(current) || options && isPodcastTrack(options.source)) return;
      evidence.start(directionRevision() + 1);
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
        directionRevision: directionRevision() + 1,
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
        generated()?.stop();
        return;
      }
      if (current) void ports.runway.ensureGeneratedQueue().start('auto_mode', current, state.autoMode.profile);else void openAutoFromCollection();
    },
    exitAutoMode(): void {
      evidence.end('exit');
      releaseDjWork();
      cancelRunwayReplan();
      pendingImmediateAutoTrack = null;
      autoOpeningAborter?.abort();
      autoOpeningAborter = null;
      // A blend that is already sounding finishes on its own; cancelling it would
      // revive the faded-out song while the UI names the new one. Anything merely
      // prepared is dropped.
      if (audioService.mixPhase() !== 'crossfading') audioService.cancelMix('exit');
      const prefix = state.playback.queue.slice(0, state.playback.index + 1);
      const survivors = futureEntries(state.playback.queue, state.playback.index).filter(entry => routeKind(entry) === 'user' || audioService.mixPhase() === 'crossfading' && committedTransition?.queueId === entry.queueId).map(entry => ({
        ...entry,
        queueLane: 'manual' as const,
        queueSource: 'add_to_queue' as const,
        autoRoute: undefined
      }));
      setState('playback', 'queue', [...prefix, ...survivors]);
      generated()?.stop('auto_mode');
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
      syncEvidence(); evidence.interaction('route_edit');
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
    startDjSelection(tracks: Track[], label: string): boolean {
      const music = tracks.filter(track => !isPodcastTrack(track) && !track.unavailable);
      if (!music.length || !state.autoMode.active) return false;
      // External selection owns a new session, including its transport. Drop
      // the old planner and both decks before loading the chosen opening.
      cancelRunwayReplan();
      autoOpeningAborter?.abort();
      autoOpeningAborter = null;
      if (autoOpeningRetry) lifetime.clearTimeout(autoOpeningRetry);
      autoOpeningRetry = null;
      generated()?.stop();
      pendingImmediateAutoTrack = null;
      autoSessionEpoch += 1;
      autoHandoffFailures = 0;
      autoHandoffCooldownUntil = 0;
      ports.discardFutureAutoplay();
      ports.cancelPendingRadio();
      ports.abandonContextMatches();
      commitSeq += 1;
      committedTransition = null;
      ports.stagedEntry = null;
      audioService.cancelMix('superseded');
      audioService.clearStaged();
      audioService.unlockAudio();
      const revision = directionRevision() + 1;
      const opening = routeEntry(music[0], revision);
      evidence.start(revision);
      setState('autoMode', {
        sources: [{ id: randomId(), label: label.trim() || music[0].title, tracks: music, activation: 1 }],
        heard: [], exploration: [], avoidedIdentities: [], plan: {}, staleSeams: [],
        directionRevision: revision,
        transition: IDLE_TRANSITION, pendingDirection: false, repairing: false,
        phase: 'planning', activity: null,
      });
      setState('playback', { queue: [opening], index: -1, shuffle: false, repeat: 'off',
        radioMode: false, radioLoading: false, radioSeedId: null });
      ports.loadIndex(0);
      void ports.runway.ensureGeneratedQueue().start('auto_mode', opening, state.autoMode.profile);
      ports.pushPlaybackState();
      return true;
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
      syncEvidence(); evidence.interaction('route_edit');
      return changeAutoSession(tracks, label);
    },
    retryAutoRoute(): void {
      syncEvidence(); evidence.interaction('route_edit');
      if (!state.playback.currentTrack) {
        void startAutoFromSources();
        return;
      }
      void generated()?.retry();
    },
    useAutoTrackAsSource(track: Track): void {
      syncEvidence(); evidence.interaction('route_edit');
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
      syncEvidence(); evidence.interaction('route_edit');
      if (!state.autoMode.active || state.autoMode.sources.length <= 1) return;
      setState('autoMode', 'sources', sources => sources.filter(source => source.id !== id));
      if (state.playback.currentTrack && state.autoMode.heard.length) {
        scheduleRunwayReplan(tr('autoMode.note.direction'));
      }
    },
    removeAutoRouteOccurrence(queueId: string): void {
      syncEvidence(); evidence.interaction('route_edit');
      const track = dropAutoRouteOccurrence(queueId);
      if (!track) return;
      toast.action(tr('autoMode.note.dropped', {
        title: track.title
      }), tr('autoMode.route.avoidSession'), () => {
        if (state.autoMode.active) avoidAutoIdentity(track);
      });
    },
    avoidAutoTrackForSession(queueId: string): void {
      syncEvidence(); evidence.interaction('route_edit');
      const track = dropAutoRouteOccurrence(queueId);
      if (track) avoidAutoIdentity(track);
    },
    reportAutoActivity(key: string, status: AutoActivity['status'], values?: Record<string, string | number>): void {
      if (!state.autoMode.active) return;
      setState('autoMode', 'activity', activity(status, key, values));
    },
    autoSessionToken(): number {
      return autoSessionEpoch;
    },
    async placeAutoTracks(tracks: Track[], beforeQueueId?: string, requestGroup?: string): Promise<void> {
      syncEvidence(); evidence.interaction('route_edit');
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active) return;
      const usable = tracks.filter(track => !isPodcastTrack(track));
      if (!usable.length) return;
      const group = requestGroup ?? (usable.length > 1 ? randomId() : undefined);
      if (usable.length === 1) return ports.actions.placeAutoTrack(usable[0], beforeQueueId, group);
      const epoch = autoSessionEpoch;
      if (!state.playback.currentTrack) {
        await ports.actions.placeAutoTrack(usable[0], undefined, group);
        if (!isCurrent()) return;
        if (!state.autoMode.active || epoch !== autoSessionEpoch) return;
        return ports.actions.placeAutoTracks(usable.slice(1), beforeQueueId, group);
      }
      const start = routeStart();
      const seed = state.playback.queue[start - 1] ?? state.playback.currentTrack;
      const route = state.playback.queue.slice(start);
      const signature = routeSignature(start);
      const destination = requestDestination(beforeQueueId);
      const occurrences = usable.map(track => ({
        ...createQueueEntry(track, 'generated', 'auto_mode'),
        autoRoute: {
          kind: 'user' as const,
          placement: destination ? 'fixed' as const : 'dj' as const,
          requestGroup: group
        }
      }));
      const progress = toast.loading(tr('musicExplorer.requesting'));
      const fallback = () => {
        if (!state.autoMode.active || epoch !== autoSessionEpoch) return;
        insertRequests(occurrences, destination);
        setState('autoMode', 'staleSeams', state.playback.queue.slice(routeStart()).map(row => row.queueId));
        ports.prefetchUpcoming();
      };
      try {
        const response = await api.placeDjTracks({
          seed: djItemRef(seed),
          route: route.map(row => ({
            ...djItemRef(row),
            queue_id: row.queueId
          })),
          requests: occurrences.map(row => ({
            track: row,
            requested_queue_id: row.queueId
          })),
          before_queue_id: destination,
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: directionRevision(),
          sources: state.autoMode.sources,
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) return;
        if (!state.autoMode.active || epoch !== autoSessionEpoch) {
          progress.dismiss();
          return;
        }
        if (routeStart() !== start || routeSignature(start) !== signature) {
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
            if (!Number.isInteger(placement.insert_at) || placement.insert_at < 0 || placement.insert_at > working.length) throw new Error('invalid insertion');
            placed.add(requested.queueId);
            let fromKey = queueIdentity(working[placement.insert_at - 1] ?? seed);
            const entries = placement.items.map((item, index) => {
              const entry = item.route_kind === 'user' ? requested : {
                ...createQueueEntry(planItemTrack(item, state.library), 'generated', 'auto_mode'),
                queueId: `${requested.queueId}:bridge:${index}`,
                autoRoute: {
                  kind: 'bridge' as const,
                  ownerQueueId: requested.queueId
                }
              };
              plan[entry.queueId] = routePlanEntry(item, queueIdentity(entry), fromKey);
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
          setState('playback', 'queue', queue => [...queue.slice(0, start), ...working]);
          setState('autoMode', 'plan', plan);
          ports.prefetchUpcoming();
        }
        progress.update('success', tr('musicExplorer.collectionDone', {
          count: occurrences.length
        }));
      } catch {
        if (!isCurrent()) return;
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
      syncEvidence(); evidence.interaction('route_edit');
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active || isPodcastTrack(track)) return;
      const start = routeStart();
      const route = state.playback.queue.slice(start);
      const seed = state.playback.queue[start - 1] ?? state.playback.currentTrack;
      const destination = requestDestination(beforeQueueId);
      const occurrence = {
        ...createQueueEntry(track, 'generated', 'auto_mode'),
        autoRoute: {
          kind: 'user' as const,
          placement: destination ? 'fixed' as const : 'dj' as const,
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
        void ports.runway.ensureGeneratedQueue().start('auto_mode', occurrence, state.autoMode.profile);
        return;
      }
      const sessionEpoch = autoSessionEpoch;
      const signature = routeSignature(start);
      setState('autoMode', 'activity', activity('working', 'autoMode.agent.placing', { title: track.title }));
      try {
        const response = await api.placeDjTrack({
          seed: djItemRef(seed),
          route: route.map(entry => ({
            ...djItemRef(entry),
            queue_id: entry.queueId
          })),
          track,
          requested_queue_id: occurrence.queueId,
          before_queue_id: destination,
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: directionRevision(),
          sources: sourceBodies(),
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) return;
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        if (routeStart() !== start || routeSignature(start) !== signature) {
          insertRequests([occurrence], destination);
          ports.prefetchUpcoming();
          return;
        }
        if (!Number.isInteger(response.insert_at) || response.insert_at < 0 || response.insert_at > route.length) throw new Error('invalid insertion');
        const entries = response.items.map(item => {
          const isUser = item.route_kind === 'user';
          const entry = isUser ? occurrence : createQueueEntry(planItemTrack(item, state.library), 'generated', 'auto_mode');
          return {
            ...entry,
            autoRoute: isUser ? occurrence.autoRoute : {
              kind: 'bridge' as const,
              ownerQueueId: occurrence.queueId
            }
          };
        });
        if (entries.filter(entry => entry.queueId === occurrence.queueId).length !== 1) throw new Error('missing request');
        const at = start + response.insert_at;
        setState('playback', 'queue', queue => [...queue.slice(0, at), ...entries, ...queue.slice(at)]);
        const plan = {
          ...state.autoMode.plan
        };
        let fromKey = queueIdentity(state.playback.queue[at - 1] ?? seed);
        entries.forEach((entry, index) => {
          plan[entry.queueId] = routePlanEntry(response.items[index], queueIdentity(entry), fromKey);
          fromKey = queueIdentity(entry);
        });
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
          activity: activity('done', 'autoMode.agent.placed', { title: track.title })
        });
        const insertedIds = new Set(entries.map(entry => entry.queueId));
        toast.action(tr('autoMode.note.added', {
          title: track.title
        }), tr('common.undo'), () => {
          if (!state.autoMode.active) return;
          setState('playback', 'queue', queue => queue.filter(entry => !insertedIds.has(entry.queueId)));
          setState('autoMode', 'plan', current => Object.fromEntries(Object.entries(current).filter(([queueId]) => !insertedIds.has(queueId))));
          void generated()?.ensureRunway();
        });
        ports.prefetchUpcoming();
      } catch {
        if (!isCurrent()) return;
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        // The user's placement is authoritative even if musical analysis is not.
        insertRequests([occurrence], destination);
        setState('autoMode', 'activity', activity('error', 'autoMode.agent.placedFallback', { title: track.title }));
        ports.prefetchUpcoming();
      }
    },
    async repairAutoRoute(): Promise<void> {
      syncEvidence(); evidence.interaction('route_edit');
      const isCurrent = lifetime.capture();
      if (!state.autoMode.active || state.autoMode.repairing) return;
      const start = routeStart();
      const seed = state.playback.queue[start - 1] ?? state.playback.currentTrack;
      const fullRoute = state.playback.queue.slice(start);
      const horizon = repairHorizon(routeRows(fullRoute), REPAIR_LIMIT);
      const route = fullRoute.slice(0, horizon);
      const untouchedTail = fullRoute.slice(horizon);
      // One seam is a transition, not a route. There is nothing to re-seam.
      if (!seed || route.length < 2) return;
      const sessionEpoch = autoSessionEpoch;
      const signature = routeSignature(start);
      const previousQueue = state.playback.queue.slice();
      const previousPlan = {
        ...state.autoMode.plan
      };
      const previousStaleSeams = state.autoMode.staleSeams.slice();
      const anchors = route.filter(entry => routeKind(entry) === 'user').map(entry => entry.queueId);
      setState('autoMode', {
        repairing: true,
        activity: activity('working', 'autoMode.agent.repairing')
      });
      try {
        const response = await api.repairDjRoute({
          seed: djItemRef(seed),
          route: route.map(entry => ({
            ...djItemRef(entry),
            queue_id: entry.queueId,
            route_kind: routeKind(entry)
          })),
          source_policy: 'explicit',
          exploration: state.autoMode.exploration ?? [],
          direction_revision: directionRevision(),
          sources: sourceBodies(),
          heard: state.autoMode.heard,
          exclude: state.autoMode.avoidedIdentities
        });
        if (!isCurrent()) return;
        if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
        const byQueueId = new Map(route.map(entry => [entry.queueId, entry] as const));
        // A handoff that committed mid-flight moves the start, so it shows up
        // here as a changed route and is caught by the same check. So does a
        // repair that names an occurrence it was never sent.
        const unchanged = routeStart() === start && routeSignature(start) === signature;
        const known = response.items.every(item => !item.queue_id || byQueueId.has(item.queue_id));
        // Cheap insurance against a server regression: a repair that lost one of
        // the listener's songs does nothing at all, rather than losing it here.
        const returned = response.items.filter(item => item.route_kind === 'user').map(item => item.queue_id ?? '');
        if (!unchanged || !known || returned.join('|') !== anchors.join('|')) {
          setState('autoMode', 'activity', activity('error', 'autoMode.agent.repairSkipped'));
          return;
        }
        const entries = response.items.map(item => {
          const kept = item.queue_id ? byQueueId.get(item.queue_id) : undefined;
          const autoRoute = item.route_kind === 'bridge' ? {
            kind: 'bridge' as const,
            ownerQueueId: item.owner_queue_id
          } : {
            kind: 'generated' as const,
            directionRevision: directionRevision()
          };
          // Spreading the kept entry preserves its lane and context, which is how
          // an explicitly queued song stays an explicit request through a repair.
          if (kept) return item.route_kind === 'user' ? kept : {
            ...kept,
            autoRoute
          };
          return {
            ...createQueueEntry(planItemTrack(item, state.library), 'generated', 'auto_mode'),
            autoRoute
          };
        });
        setState('playback', 'queue', queue => [...queue.slice(0, start), ...entries, ...untouchedTail]);

        // Everything before the editable start keeps its plan. Wiping it
        // wholesale would strip the cued handoff's own entry and turn a blend
        // that is already loaded into a fade at the moment it fires.
        const prefix = new Set(state.playback.queue.slice(0, start).map(entry => entry.queueId));
        const tail = new Set(untouchedTail.map(row => row.queueId));
        const plan: Record<string, AutoPlanItem> = Object.fromEntries(Object.entries(state.autoMode.plan).filter(([id]) => prefix.has(id) || tail.has(id)));
        let fromKey = queueIdentity(state.playback.queue[start - 1] ?? seed);
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
          activity: activity('done', 'autoMode.agent.repaired')
        });
        ports.prefetchUpcoming();
        toast.action(tr('autoMode.note.repaired'), tr('common.undo'), () => {
          if (!state.autoMode.active || autoSessionEpoch !== sessionEpoch) return;
          if (routeStart() !== start) return;
          if (state.playback.queue[start - 1]?.queueId !== previousQueue[start - 1]?.queueId) return;
          setState('playback', 'queue', previousQueue);
          setState('autoMode', {
            plan: previousPlan,
            staleSeams: previousStaleSeams
          });
          ports.prefetchUpcoming();
        });
      } catch {
        if (!isCurrent()) return;
        // Nothing was written — the queue is only touched once an answer lands —
        // so there is no half-repaired route to unwind.
        setState('autoMode', 'activity', activity('error', 'autoMode.agent.repairFailed'));
      } finally {
        setState('autoMode', 'repairing', false);
      }
    },
    async autoSkip(): Promise<void> {
      syncEvidence();
      evidence.interaction('skip');
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
          void generated()?.ensureRunway();
          return;
        }
        if (outcome === 'blend' || outcome === 'finished' && !owned) {
          ports.listeningLearning.skip(skipped, playingDuration());
          void generated()?.ensureRunway();
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
          commitTransition(next, fromKey, skipTransition(fromKey, state.autoMode.plan[next.queueId]), true);
        } else {
          ports.actions.next();
        }
        void generated()?.ensureRunway();
        return;
      }
      await generated()?.refillNow();
      if (!isCurrent()) return;

      // A failed final URL can happen while a refill is already in flight. Wait
      // briefly for that real plan instead of leaving Auto stopped on the error.
      for (let attempt = 0; attempt < 28 && state.autoMode.active; attempt += 1) {
        if (canAdvance()) {
          ports.actions.next();
          return;
        }
        await new Promise(resolve => lifetime.setTimeout(() => resolve(undefined), 250));
        if (!isCurrent()) return;
      }
    },
    promoteInAutoRoute(queueId: string): void {
      syncEvidence(); evidence.interaction('route_edit');
      const start = routeStart();
      const first = state.playback.queue[start]?.queueId;
      if (!first) return;
      const order = moveRouteBlock(routeRows(state.playback.queue), queueId, first, start - 1);
      if (!order) return;
      const byId = new Map(state.playback.queue.map(entry => [entry.queueId, entry] as const));
      setState('playback', 'queue', order.map(id => byId.get(id)!));
      ports.prefetchUpcoming();
    },
    moveAutoRoute(queueId: string, beforeQueueId?: string): void {
      syncEvidence(); evidence.interaction('route_edit');
      if (!state.autoMode.active || queueId === beforeQueueId) return;
      const current = state.playback.queue;
      const rows = routeRows(current);
      // Grabbing a bridge is a request to move what it leads into: on its own it
      // connects nothing, and leaving it behind would strand its owner. Never in
      // front of a handoff that is already loaded; the route panel stops
      // offering that seam, and this is what happens if anything else asks.
      const order = moveRouteBlock(rows, queueId, beforeQueueId, routeStart() - 1);
      if (!order) return;
      const blockIds = new Set(routeBlock(rows, queueId));
      const source = current.find(entry => entry.queueId === queueId)!;
      const ownerId = source.autoRoute?.kind === 'bridge' && source.autoRoute.ownerQueueId ? source.autoRoute.ownerQueueId : queueId;
      const byId = new Map(current.map(entry => [entry.queueId, entry.queueId === ownerId ? {
        ...entry,
        autoRoute: {
          kind: 'user' as const,
          placement: 'fixed' as const
        }
      } : entry] as const));
      const queue = order.map(id => byId.get(id)!);
      // The joins the move opened: into the block, out of it, and over the gap
      // it left (the row that now sits where the block started).
      const oldStart = current.findIndex(entry => blockIds.has(entry.queueId));
      const closed = current.filter(entry => !blockIds.has(entry.queueId))[oldStart]?.queueId;
      const firstMoved = queue.findIndex(entry => blockIds.has(entry.queueId));
      const after = queue[firstMoved + blockIds.size]?.queueId;
      const opened = [queue[firstMoved].queueId, closed, after].filter((id): id is string => Boolean(id));
      setState('playback', 'queue', queue);
      setState('autoMode', 'staleSeams', seams => {
        const live = new Set(queue.map(entry => entry.queueId));
        return [...new Set([...seams.filter(id => live.has(id)), ...opened])];
      });
      ports.prefetchUpcoming();
      const owner = current.find(entry => entry.queueId === ownerId) ?? source;
      toast.action(tr('autoMode.route.moved', {
        title: owner.title
      }), tr('autoMode.route.fix'), () => {
        if (state.autoMode.active) void ports.actions.repairAutoRoute();
      });
    }
  };
  return {
    dispose() {
      evidence.end('disposed');
      releaseDjWork();
      ++autoSessionEpoch;
      autoOpeningAborter?.abort();
    },
    actions: domainActions,
    runwayPort,
    insertionFloor,
    playingDuration,
    confirmNormalMode,
    mixAutoTrackNow,
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
    evaluateDjRunway
  };
}
