import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api, type PreviewPreparation } from "../lib/api";
import { audioService } from "../lib/audio";
import { playbackYoutubeId } from "../lib/media";
import { prefetchPreviews, createPreparationOwner, upcomingPreviewIds } from "../lib/prefetch";
import { toast } from "../lib/toast";
import { isPodcastTrack } from "../lib/track";
import { GeneratedQueueController } from "../lib/generatedQueue";
import { t as tr } from "../lib/i18n";
import { createQueueEntry, futureEntries, isPendingEntry, manualInsertIndex, sameQueueSection, type PlaybackQueueEntry } from "../lib/playbackQueue";
import { shuffled } from "../lib/shuffle";
import type { Track } from "../types/music";
import { state, setState, randomId } from "./core";
import type { PlayerActions, ContextMatchOutcome, LoadOptions } from "./contracts";
export interface QueuePorts {
  onPreviewPreparation: (videoId: string, status: PreviewPreparation) => void;
  runWhenAudible: (() => void) | null;
  trackPrepared: (track: Track) => boolean;
  trackUrl: (track: Track) => string;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
  generatedQueue: GeneratedQueueController | null;
  actions: Pick<PlayerActions, 'clearManualQueue' | 'linkCatalogItem' | 'placeAutoTrack' | 'playTrack' | 'removeFromQueue'>;
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
  resumeFromStarved: () => void;
  insertionFloor: () => number;
  cancelActiveAttempt: (reason?: string) => void;
  loadIndex: (i: number, opts?: LoadOptions) => void;
}

/** Owns queue behaviour; cross-domain work enters through explicit ports. */
export function createQueue(ports: QueuePorts, lifetime: RuntimeLifetime) {
  function repeatCycle(queue: PlaybackQueueEntry[]): PlaybackQueueEntry[] {
    return queue.filter(entry => entry.queueLane !== 'manual' && entry.queueSource !== 'autoplay');
  }
  const currentPreparation = createPreparationOwner(lifetime.guard(ports.onPreviewPreparation));
  const upcomingPreparation = createPreparationOwner(lifetime.guard(ports.onPreviewPreparation));
  function releasePreparation(): void {
    currentPreparation.update([]);
    upcomingPreparation.update([]);
  }
  function revalidatePreparation(): void {
    currentPreparation.revalidate();
    upcomingPreparation.revalidate();
  }
  function previewLookahead(): string[] {
    const pb = state.playback;
    if (!pb.currentTrack || ports.runWhenAudible) return [];
    const unmatched = new Set(pb.queue.filter(isPendingEntry).map(entry => entry.id));
    return upcomingPreviewIds(pb.queue, pb.index, pb.repeat === 'all', 5).filter(id => !unmatched.has(id));
  }
  function updateUpcomingPreparation(): void {
    upcomingPreparation.update(previewLookahead().slice(0, 3));
  }
  function prefetchUpcoming(): void {
    if (!state.playback.currentTrack || ports.runWhenAudible) {
      upcomingPreparation.update([]);
      return;
    }
    matchUpcomingContext();
    const ids = previewLookahead();
    upcomingPreparation.update(ids.slice(0, 3));
    const warmOnly = ids.slice(3);
    if (warmOnly.length > 0) prefetchPreviews(warmOnly);
  }
  let stagedEntry: {
    queueId: string;
    attemptId: string;
    url: string;
  } | null = null;
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
    if (isPendingEntry(next)) {
      stagedEntry = null;
      audioService.clearStaged();
      void matchContextEntry(next.queueId).then(lifetime.guard(outcome => afterContextMatch(next.queueId, outcome)));
      return;
    }
    if (stagedEntry?.queueId === next.queueId) return;
    if (!ports.trackPrepared(next)) {
      stagedEntry = null;
      audioService.clearStaged();
      const videoId = playbackYoutubeId(next);
      if (videoId) prefetchUpcoming();
      return;
    }
    // Minted here rather than at playback so a handoff reports the same attempt
    // the deck was cued under. It identifies the attempt in telemetry only — it
    // is deliberately not in the URL, which has to stay cacheable.
    const attemptId = randomId();
    stagedEntry = {
      queueId: next.queueId,
      attemptId,
      url: ports.trackUrl(next)
    };
    audioService.stage(stagedEntry.url, ports.levelFor(next));
  }
  function discardFutureAutoplay(): void {
    ports.generatedQueue?.stop('autoplay');
    const pb = state.playback;
    const queue = pb.queue.filter((entry, index) => index <= pb.index || !(entry.queueLane === 'generated' && entry.queueSource === 'autoplay'));
    setState('playback', {
      queue,
      autoplayLoading: false
    });
    updateUpcomingPreparation();
  }
  function cancelPendingRadio(): void {
    ports.generatedQueue?.stop('radio');
  }
  const CONTEXT_MATCH_AHEAD = 3;
  const contextMatches = new Map<string, {
    task: Promise<ContextMatchOutcome>;
    controller: AbortController;
  }>();
  function abandonContextMatches(keep: (queueId: string) => boolean = () => false): void {
    for (const [queueId, match] of contextMatches) {
      if (keep(queueId)) continue;
      match.controller.abort();
      contextMatches.delete(queueId);
    }
  }
  function matchContextEntry(queueId: string): Promise<ContextMatchOutcome> {
    const inFlight = contextMatches.get(queueId);
    if (inFlight) return inFlight.task;
    const reference = state.playback.queue.find(entry => entry.queueId === queueId)?.pendingResolve;
    if (!reference) {
      return Promise.resolve(state.playback.queue.some(entry => entry.queueId === queueId) ? 'resolved' : 'gone');
    }
    const controller = new AbortController();
    const {
      signal
    } = controller;
    const task = Promise.resolve().then(lifetime.guard(() => api.resolveCatalogItem({
      artist: reference.artist,
      title: reference.title,
      duration: reference.duration
    }, signal))).then(lifetime.guard(resolved => resolved?.video_id || null), lifetime.guard(() => null)).then(lifetime.guard((videoId): ContextMatchOutcome => {
      const at = state.playback.queue.findIndex(entry => entry.queueId === queueId);
      if (signal.aborted || at === -1) return 'gone';
      if (!videoId) return 'unavailable';
      ports.actions.linkCatalogItem(reference.catalogItemId, videoId);
      const entry = state.playback.queue[at];
      const matched: PlaybackQueueEntry = {
        ...entry,
        id: videoId,
        pendingResolve: undefined
      };
      const current = state.playback.queue[state.playback.index]?.queueId === queueId;
      setState('playback', {
        queue: state.playback.queue.map(row => row.queueId === queueId ? matched : row),
        ...(current ? {
          currentTrack: matched
        } : {})
      });
      return 'resolved';
    })).finally(lifetime.guard(() => {
      if (contextMatches.get(queueId)?.task === task) contextMatches.delete(queueId);
    }));
    contextMatches.set(queueId, {
      task,
      controller
    });
    return task;
  }
  function matchUpcomingContext(): void {
    const pb = state.playback;
    if (state.autoMode.active || pb.index < 0) return;
    const ahead = pb.queue.slice(pb.index + 1, pb.index + 1 + CONTEXT_MATCH_AHEAD);
    if (ahead.length < CONTEXT_MATCH_AHEAD && pb.repeat === 'all') {
      ahead.push(...repeatCycle(pb.queue).slice(0, CONTEXT_MATCH_AHEAD - ahead.length));
    }
    for (const entry of ahead) {
      if (!isPendingEntry(entry) || contextMatches.has(entry.queueId)) continue;
      void matchContextEntry(entry.queueId).then(lifetime.guard(outcome => afterContextMatch(entry.queueId, outcome)));
    }
  }
  function afterContextMatch(queueId: string, outcome: ContextMatchOutcome): void {
    if (outcome === 'gone') return;
    if (outcome === 'unavailable') {
      const pb = state.playback;
      const at = pb.queue.findIndex(entry => entry.queueId === queueId);
      if (at === -1 || at === pb.index) return;
      const position = at - pb.index;
      setState('playback', {
        queue: pb.queue.filter(entry => entry.queueId !== queueId),
        index: at < pb.index ? pb.index - 1 : pb.index
      });
      ports.emitPlaybackEvent('ui_context_unmatched', {
        position
      });
      void ports.ensureAutoplay();
    }
    prefetchUpcoming();
    stageNext();
    ports.resumeFromStarved();
  }
  const domainActions = {
    enqueue(track: Track): void {
      if (state.autoMode.active && !isPodcastTrack(track)) {
        void ports.actions.placeAutoTrack(track);
        return;
      }
      if (state.playback.queue.length === 0) {
        ports.actions.playTrack(track);
        return;
      }
      discardFutureAutoplay();
      const at = manualInsertIndex(state.playback.queue, ports.insertionFloor(), 'last');
      const entry = createQueueEntry(track, 'manual', 'add_to_queue');
      setState('playback', 'queue', q => [...q.slice(0, at), entry, ...q.slice(at)]);
      toast.success(tr('toast.addedToQueue'));
      prefetchUpcoming();
    },
    playNext(track: Track): void {
      if (state.autoMode.active && !isPodcastTrack(track)) {
        void ports.actions.placeAutoTrack(track);
        return;
      }
      const pb = state.playback;
      if (pb.queue.length === 0) {
        ports.actions.playTrack(track);
        return;
      }
      discardFutureAutoplay();
      // Never in front of a handoff that is already loaded and cued.
      const at = ports.insertionFloor() + 1;
      const entry = createQueueEntry(track, 'manual', 'play_next');
      setState('playback', 'queue', q => [...q.slice(0, at), entry, ...q.slice(at)]);
      toast.success(tr('toast.playNextConfirmed'));
      prefetchUpcoming();
    },
    removeFromQueue(i: number): void {
      const pb = state.playback;
      if (i < 0 || i >= pb.queue.length) return;
      const next = pb.queue.filter((_, idx) => idx !== i);
      if (i === pb.index) {
        setState('playback', 'queue', next);
        if (next.length === 0) {
          releasePreparation();
          ports.cancelActiveAttempt('queue_empty');
          audioService.stop();
          setState('playback', {
            currentTrack: null,
            index: -1,
            isPlaying: false,
            isLoading: false,
            loadError: false,
            phase: 'idle'
          });
        } else {
          ports.loadIndex(Math.min(i, next.length - 1));
        }
        return;
      }
      setState('playback', 'queue', next);
      if (i < pb.index) setState('playback', 'index', pb.index - 1);
      prefetchUpcoming();
      if (state.playback.radioMode || state.autoMode.active) {
        void ports.generatedQueue?.ensureRunway();
      }
    },
    moveInQueue(from: number, to: number): void {
      const pb = state.playback;
      if (from === to || from < 0 || to < 0 || from >= pb.queue.length || to >= pb.queue.length) return;
      if (!sameQueueSection(pb.queue[from], pb.queue[to])) return;
      const q = pb.queue.slice();
      const [item] = q.splice(from, 1);
      q.splice(to, 0, item);
      let index = pb.index;
      if (from === pb.index) index = to;else {
        if (from < index) index--;
        if (to <= index) index++;
      }
      setState('playback', {
        queue: q,
        index
      });
      prefetchUpcoming();
    },
    clearManualQueue(): void {
      const pb = state.playback;
      const queue = pb.queue.filter((entry, index) => index <= pb.index || entry.queueLane !== 'manual');
      setState('playback', 'queue', queue);
      prefetchUpcoming();
    },
    clearQueue(): void {
      ports.actions.clearManualQueue();
    },
    removeContext(): void {
      if (state.autoMode.active) return;
      const pb = state.playback;
      const current = pb.queue[pb.index];
      const removed = new Set(futureEntries(pb.queue, pb.index, 'context').map(entry => entry.queueId));
      const cycling = pb.repeat === 'all';
      if (removed.size === 0 && !cycling) return;
      abandonContextMatches(queueId => queueId === current?.queueId);
      if (stagedEntry && removed.has(stagedEntry.queueId)) {
        stagedEntry = null;
        audioService.clearStaged();
      }
      setState('playback', {
        queue: pb.queue.filter(entry => !removed.has(entry.queueId)),
        ...(cycling ? {
          repeat: 'off' as const
        } : {})
      });
      prefetchUpcoming();
      if (pb.isPlaying && !pb.isLoading) stageNext();
      queueMicrotask(() => void ports.ensureAutoplay());
    },
    removeQueueEntry(queueId: string): void {
      const index = state.playback.queue.findIndex(entry => entry.queueId === queueId);
      if (index !== -1) ports.actions.removeFromQueue(index);
    },
    playQueueEntry(queueId: string): void {
      const pb = state.playback;
      const from = pb.queue.findIndex(entry => entry.queueId === queueId);
      if (from === -1 || from === pb.index) return;
      const queue = pb.queue.slice();
      const [entry] = queue.splice(from, 1);
      const at = pb.index + 1;
      queue.splice(at, 0, entry);
      setState('playback', 'queue', queue);
      ports.loadIndex(at);
    },
    toggleShuffle(): void {
      const pb = state.playback;
      const nextShuffle = !pb.shuffle;
      const prefix = pb.queue.slice(0, pb.index + 1);
      const upcoming = futureEntries(pb.queue, pb.index);
      const manual = upcoming.filter(entry => entry.queueLane === 'manual');
      const context = upcoming.filter(entry => entry.queueLane === 'context');
      const generated = upcoming.filter(entry => entry.queueLane === 'generated');
      const orderedContext = nextShuffle ? shuffled(context) : context.slice().sort((a, b) => (a.queueContextIndex ?? 0) - (b.queueContextIndex ?? 0));
      setState('playback', {
        shuffle: nextShuffle,
        queue: [...prefix, ...manual, ...orderedContext, ...generated]
      });
      prefetchUpcoming();
    }
  };
  return {
    dispose() {
      abandonContextMatches();
      currentPreparation.dispose();
      upcomingPreparation.dispose();
    },
    actions: domainActions,
    releasePreparation,
    matchContextEntry,
    get stagedEntry() {
      return stagedEntry;
    },
    set stagedEntry(value: {
      queueId: string;
      attemptId: string;
      url: string;
    } | null) {
      stagedEntry = value;
    },
    get currentPreparation() {
      return currentPreparation;
    },
    prefetchUpcoming,
    nextEntry,
    discardFutureAutoplay,
    cancelPendingRadio,
    abandonContextMatches,
    repeatCycle,
    updateUpcomingPreparation,
    stageNext,
    previewLookahead,
    revalidatePreparation
  };
}
