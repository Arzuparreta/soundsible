import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api, type ListeningPlanItem, type ListeningPlanResponse, type PreviewPreparation } from '../lib/api';
import { audioService } from '../lib/audio';
import { playbackYoutubeId } from '../lib/media';
import { toast } from '../lib/toast';
import { isPodcastTrack } from '../lib/track';
import { queueIdentity, queueIndexOf } from '../lib/queueDiscovery';
import { GeneratedQueueController } from '../lib/generatedQueue';
import { t as tr } from '../lib/i18n';
import { createQueueEntry, futureEntries, isPendingEntry, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { replanRunway, routeKind, routeRows, runwayReplacement } from '../lib/djRoute';
import { planItemTrack, planSeed } from '../lib/planItems';
import type { Track } from '../types/music';
import { state, setState } from './core';
import type { PlayerActions } from './contracts';

type PlanStatus = 'planning' | 'ready' | 'exhausted' | 'warming' | 'degraded' | 'idle';
type GeneratedSessionContext = { id: string; segmentIndex: number; context: Track[] };

/** What the generated lanes need from the DJ session that owns Auto Mode. */
export interface DjRunwayPort {
  /** The occurrence whose handoff is loaded and cued, if any. */
  committedQueueId(): string | null;
  /** Called whenever the planner is touched while Auto Mode is on. */
  activateWork(): void;
  syncEvidence(): void;
  planningContext(): string;
  /** A DJ plan request, or null when the client has no DJ planner. */
  requestPlan(seed: ReturnType<typeof planSeed>, limit: number, exclude: string[], signal: AbortSignal, session?: GeneratedSessionContext): Promise<ListeningPlanResponse> | null;
  /** False for an answer to a direction the listener has since changed. */
  acceptsPlan(response: ListeningPlanResponse): boolean;
  /** A planned track as a DJ route occurrence. */
  routeEntry(track: Track): PlaybackQueueEntry;
  /** The route was written: record each entry's seam and provenance. */
  planApplied(response: ListeningPlanResponse, accepted: Map<ListeningPlanItem, PlaybackQueueEntry>, replace: boolean, anchor: Track): void;
  status(status: PlanStatus, response: ListeningPlanResponse | undefined, replacing: boolean | undefined): void;
  dropOccurrence(queueId: string): PlaybackQueueEntry | null;
  confirmNormalMode(kind: 'podcast' | 'radio', proceed: () => void | Promise<void>): Promise<void>;
}

export interface RunwayPorts {
  dj: DjRunwayPort;
  actions: Pick<PlayerActions, 'playFrom' | 'startRadio'>;
  prefetchUpcoming: () => void;
  stageNext: () => void;
  discardFutureAutoplay: () => void;
  cancelPendingRadio: () => void;
  abandonContextMatches: (keep?: (queueId: string) => boolean) => void;
  previewLookahead: () => string[];
  nextEntry: () => PlaybackQueueEntry | undefined;
  stagedEntry: { queueId: string; attemptId: string; url: string } | null;
  trackPrepared: (track: Track) => boolean;
  loadIndex: (i: number, opts?: { trigger?: 'ended' }) => void;
  emitPlaybackEvent: (phase: string, extra?: Record<string, number | boolean>, strings?: Record<string, string | undefined>) => void;
  runWhenAudible: (() => void) | null;
}

const AUTOPLAY_TARGET = 8;
const AUTOPLAY_PREPARE_THRESHOLD = 2;
const AUTOPLAY_REFILL_THRESHOLD = 5;
const RUNWAY_LEAD_SECONDS = 60;
const EMPTY_RUNWAY_RETRY_MS = 5_000;
const PREMATURE_END_SECONDS = 3;

/**
 * Owns the generated lanes — Autoplay, Radio and the DJ route's runway — and
 * what happens when they run dry. The DJ session plugs its own planning in
 * through `ports.dj`; everything here is shared by the three intents.
 */
export function createRunway(ports: RunwayPorts, lifetime: RuntimeLifetime) {
  let generatedQueue: GeneratedQueueController | null = null;

  function applyPlan(intent: 'autoplay' | 'radio' | 'auto_mode', response: ListeningPlanResponse, replace: boolean, anchor: Track): number {
    const dj = intent === 'auto_mode' ? ports.dj : null;
    if (dj && !dj.acceptsPlan(response)) return 0;
    const pb = state.playback;
    // What a replacing plan keeps: everything already played, the handoff that
    // is already loaded and cued, and every request with its bridges.
    const replacement = replace ? runwayReplacement(pb.queue, pb.index, ports.dj.committedQueueId()) : null;
    const retained = replacement?.retained ?? pb.queue;
    const candidates = response.items
      .map(item => ({ item, track: planItemTrack(item, state.library) }))
      .filter(({ track }) => queueIndexOf(retained, track) === -1);
    const planned = candidates.map(({ item, track }) => ({
      item,
      entry: dj ? dj.routeEntry(track) : createQueueEntry(track, 'generated', intent),
    }));
    if (replacement) {
      const { head, previous, future, kept } = replacement;
      const entries = planned.map(({ entry }) => entry);
      const order = replanRunway(future, routeRows(entries), kept);
      const placed = new Set(order);
      const written = planned.filter(({ entry }) => placed.has(entry.queueId));
      if (written.length === 0) return 0;
      const byKey = new Map([...previous, ...entries].map(entry => [entry.queueId, entry] as const));
      setState('playback', 'queue', [...head, ...order.map(key => byKey.get(key)!)]);
      return planWritten(response, written, true, anchor, dj);
    }
    if (planned.length === 0) return 0;
    setState('playback', 'queue', queue => [...queue, ...planned.map(({ entry }) => entry)]);
    return planWritten(response, planned, false, anchor, dj);
  }

  function planWritten(response: ListeningPlanResponse, written: Array<{ item: ListeningPlanItem; entry: PlaybackQueueEntry }>,
    replace: boolean, anchor: Track, dj: DjRunwayPort | null): number {
    if (dj) dj.planApplied(response, new Map(written.map(({ item, entry }) => [item, entry] as const)), replace, anchor);
    ports.prefetchUpcoming();
    // New runway. If the music ran out waiting for exactly this, start it
    // again — the plan arriving is the event, and nothing else is watching.
    ports.stageNext();
    resumeFromStarved();
    return written.length;
  }

  function ensureGeneratedQueue(): GeneratedQueueController {
    if (state.autoMode.active) ports.dj.activateWork();
    if (generatedQueue) return generatedQueue;
    generatedQueue = new GeneratedQueueController({
      snapshot: () => ({
        currentTrack: state.playback.currentTrack,
        queue: state.playback.queue.slice(),
        index: state.playback.index,
        committedQueueId: ports.dj.committedQueueId(),
      }),
      identity: queueIdentity,
      planningContext: () => ports.dj.planningContext(),
      requestPlan: (intent, profile, seed, limit, exclude, signal, generatedSession) => {
        const seedBody = planSeed(seed);
        const planned = intent === 'auto_mode' ? ports.dj.requestPlan(seedBody, limit, exclude, signal, generatedSession) : null;
        return planned ?? api.planMusicQueue({ intent, profile, seed: seedBody, exclude, limit }, signal);
      },
      applyPlan,
      onStatus: (intent, status, response, replacing) => {
        if (intent === 'autoplay') setState('playback', 'autoplayLoading', status === 'planning');
        else if (intent === 'radio') setState('playback', 'radioLoading', status === 'planning');
        else ports.dj.status(status, response, replacing);
      },
    });
    return generatedQueue;
  }

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

  let starvedQueueId: string | null = null;
  function enterStarved(): void {
    starvedQueueId = state.playback.queue[state.playback.index]?.queueId ?? null;
    setState('playback', { isPlaying: false, isLoading: false, phase: 'starved' });
    ports.emitPlaybackEvent('ui_queue_starved', {
      lane_remaining: futureEntries(state.playback.queue, state.playback.index).length,
      auto_mode: state.autoMode.active,
      radio: state.playback.radioMode,
      // Starving in the foreground is a spinner; starving with the phone locked is
      // a drive that goes quiet, because the refill it waits on cannot complete.
      hidden: typeof document !== 'undefined' && document.visibilityState === 'hidden',
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
    ports.loadIndex(state.playback.index + 1, { trigger: 'ended' });
  }

  /** Bring the nearest prepared generated entry forward when the next one is
   * not ready yet. True when the next entry can play. */
  function promotePreparedAutoSuccessor(): boolean {
    const pb = state.playback;
    const immediate = pb.queue[pb.index + 1];
    if (!immediate) return false;
    if (ports.trackPrepared(immediate)) return true;
    if (routeKind(immediate) !== 'generated' || ports.dj.committedQueueId() === immediate.queueId) return false;
    let readyIndex = -1;
    for (let index = pb.index + 2; index < pb.queue.length; index += 1) {
      const candidate = pb.queue[index];
      // Moving a single ready song must not split or overtake an explicit request.
      if (routeKind(candidate) !== 'generated') break;
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

  let runwayCheckedFor = '';
  let lastEmptyRefillAt = 0;
  function watchRunway(snapshot: { position: number; duration: number }): void {
    ports.dj.syncEvidence();
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
      starved: !next,
    };
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
          if (entry.queueLane === 'generated') ports.dj.dropOccurrence(entry.queueId);
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
        retry_after_sec: status.retry_after ?? 0,
      }, {
        video_id: videoId,
        queue_lane: matching[0]?.queueLane,
        queue_source: matching[0]?.queueSource,
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

  function normalQueueAfterRadio(): void {
    const cur = state.playback.queue[state.playback.index];
    const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
      queue: cur ? [cur, ...manual] : manual,
      index: cur ? 0 : -1,
    });
  }

  const actions = {
    async startRadio(seed: Track): Promise<void> {
      const isCurrent = lifetime.capture();
      if (isPodcastTrack(seed)) {
        toast.error(tr('toast.radioUnavailable'));
        return;
      }
      if (state.autoMode.active) {
        await ports.dj.confirmNormalMode('radio', () => ports.actions.startRadio(seed));
        return;
      }
      const t = toast.loading(tr('toast.startingRadio'));
      ports.discardFutureAutoplay();
      ports.cancelPendingRadio();
      setState('playback', { radioMode: true, radioLoading: true, radioSeedId: seed.id });
      const isCurrentPlaying = state.playback.currentTrack?.id === seed.id && state.playback.isPlaying;
      if (isCurrentPlaying) {
        ports.abandonContextMatches();
        const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
        setState('playback', {
          queue: [createQueueEntry(seed, 'context', 'radio', { id: `radio:${seed.id}`, kind: 'single', label: seed.title }), ...manual],
          index: 0,
        });
      } else {
        ports.actions.playFrom([seed], 0, { radio: true });
      }
      const ready = await ensureGeneratedQueue().start('radio', seed);
      if (!isCurrent()) return;
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
          source: seed.source ?? 'library',
        }).catch(lifetime.guard(() => {}));
        t.update('success', tr('toast.radioStarted'));
      } else {
        t.update('error', tr('toast.radioFailed', { ytId: seed.youtube_id || tr('toast.radioFailedFallback') }));
        generatedQueue.stop('radio');
        normalQueueAfterRadio();
      }
    },
    stopRadio(): void {
      ports.cancelPendingRadio();
      normalQueueAfterRadio();
    },
    async setAutoplayEnabled(enabled: boolean): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const previous = state.playback.autoplayEnabled;
      if (enabled === previous) return true;
      setState('playback', 'autoplayEnabled', enabled);
      if (enabled) queueMicrotask(() => void ensureAutoplay(true));
      else ports.discardFutureAutoplay();
      try {
        await api.setAutoplayEnabled(enabled);
        return isCurrent();
      } catch {
        if (!isCurrent()) return false;
        setState('playback', 'autoplayEnabled', previous);
        if (previous) queueMicrotask(() => void ensureAutoplay(true));
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    },
  };

  return {
    actions,
    dispose() {
      generatedQueue?.stop();
      generatedQueue = null;
    },
    get generatedQueue() {
      return generatedQueue;
    },
    set generatedQueue(value: GeneratedQueueController | null) {
      generatedQueue = value;
    },
    ensureGeneratedQueue,
    ensureAutoplay,
    enterStarved,
    resumeFromStarved,
    promotePreparedAutoSuccessor,
    watchRunway,
    boundaryFacts,
    onPreviewPreparation,
    PREMATURE_END_SECONDS,
  };
}
