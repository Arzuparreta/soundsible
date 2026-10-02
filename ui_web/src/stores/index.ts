/** Composition root for playback domains and the public UI actions.
 * Domain modules depend on explicit host contracts; none imports this barrel. */
import { Lifetime } from '../lib/lifetime';
import { disposeLibrarySync } from './library';
import { createTransport } from './playbackTransport';
import { createSession } from './playbackSession';
import { createDj } from './playbackDj';
import type { PlaybackTrigger, PlaybackAttempt } from './playbackTransport';

import { createSocket, type AppSocket, dispatchDiscoverSeed } from '../lib/socket';
import { api, type DjDirection, type DjProfile, type ListeningPlanItem, type LibraryScanStatus, type RemotePlaybackState } from '../lib/api';
import { audioService, onProgramEvent, setProgramOutputReporter, setProgramTransportReporter, type ProgramMediaEventName, type ProgramPlaybackSnapshot, type ProgramTransportOrigin } from '../lib/audio';

import { podcastStreamUrl, bustCovers, playbackYoutubeId } from '../lib/media';

import { toast } from '../lib/toast';

import { vibrate } from '../lib/haptics';
import { isPodcastTrack, podcastEpisodeToTrack } from '../lib/track';
import { queueIdentity, queueIndexOf } from '../lib/queueDiscovery';
import { savedFromTrack, savedVideoId } from '../lib/saved';
import { trackKeys } from '../lib/playbackIdentity';
import { GeneratedQueueController, type AutoActivity, type AutoMusicSet, type AutoPlanItem, type AutoProfile } from '../lib/generatedQueue';
import { createShortcutHandler } from '../lib/shortcuts';
import { nudgeVolumeGain } from '../lib/volumeScale';
import { t as tr } from '../lib/i18n';
import { ListeningLearning } from '../lib/listeningLearning';
import { createQueueEntry, defaultContext, futureEntries, manualInsertIndex, sameQueueSection, contextSource, type PlaybackContextDescriptor, type PlaybackQueueEntry, type QueueSource } from '../lib/playbackQueue';

import { liveHandoffPending } from '../lib/liveHandoff';
import { shuffled } from '../lib/shuffle';
import type { Track, SavedEntry, PlaylistMap, LibrarySettings } from '../types/music';
import type { PodcastSubscription, PodcastEpisode } from '../types/podcast';
import type { DownloadEvent } from '../types/download';
import { applyVisualPreferences, persistHighContrast, persistInterfaceSize, type InterfaceSize } from '../lib/visualPreferences';

// The store shape and its primitives live in `./core`; this module composes
// behaviour on top of them and stays the public surface every component
// imports from.

// The store shape and its primitives live in `./core`; this module composes
// behaviour on top of them and stays the public surface every component
// imports from.
export * from './core';
export { invalidateLibrarySync, syncLibrary, syncLibrarySoon } from './library';
import { invalidateLibrarySync, syncLibrary, syncLibrarySoon } from './library';
export { addRecentCompleted, applyDownloadEvent, downloadCounts } from './downloads';
import { applyDownloadEvent } from './downloads';

import { refreshLinkReading } from '../lib/linkQuality';
export * from './identity';
import { isFavouriteKeys, isSavedKeys, ownedTrackForKeys, savedEntryForKeys, setCatalogLinks } from './identity';
import { state, setState, nowPlayingOpen, setNowPlayingOpen, randomId, resumeState, setResumeState, type RepeatMode, type Theme } from './core';

const playbackHost = {
  get onPreviewPreparation() { return dj.onPreviewPreparation; },
  get generatedQueue() { return generatedQueue; },
  set generatedQueue(value: GeneratedQueueController | null) { generatedQueue = value; },
  get AUTOPLAY_PREPARE_THRESHOLD() { return AUTOPLAY_PREPARE_THRESHOLD; },
  get AUTOPLAY_REFILL_THRESHOLD() { return AUTOPLAY_REFILL_THRESHOLD; },
  get AUTOPLAY_TARGET() { return AUTOPLAY_TARGET; },
  get ensureGeneratedQueue() { return ensureGeneratedQueue; },
  get userPlaybackStartedThisSession() { return userPlaybackStartedThisSession; },
  set userPlaybackStartedThisSession(value: boolean) { userPlaybackStartedThisSession = value; },
  get actions() { return actions; },
  get cancelActiveAttempt() { return transport.cancelActiveAttempt; },
  get updateMediaSession() { return transport.updateMediaSession; },
  get stagedEntry() { return transport.stagedEntry; },
  set stagedEntry(value: { queueId: string; attemptId: string; url: string } | null) { transport.stagedEntry = value; },
  get autoSessionEpoch() { return autoSessionEpoch; },
  set autoSessionEpoch(value: number) { autoSessionEpoch = value; },
  get autoPlaybackPrefs() { return autoPlaybackPrefs; },
  set autoPlaybackPrefs(value: { shuffle: boolean; repeat: RepeatMode } | null) { autoPlaybackPrefs = value; },
  get loadIndex() { return transport.loadIndex; },
  get trackUrl() { return transport.trackUrl; },
  get levelFor() { return transport.levelFor; },
  get listeningLearning() { return listeningLearning; },
  get concludeAttempt() { return transport.concludeAttempt; },
  get activeAttempt() { return transport.activeAttempt; },
  set activeAttempt(value: PlaybackAttempt | null) { transport.activeAttempt = value; },
  get pushPlaybackState() { return sessionController.pushPlaybackState; },
  get pendingImmediateAutoTrack() { return pendingImmediateAutoTrack; },
  set pendingImmediateAutoTrack(value: Track | null) { pendingImmediateAutoTrack = value; },
  get prefetchUpcoming() { return transport.prefetchUpcoming; },
  get trackPrepared() { return transport.trackPrepared; },
  get generatedActivityId() { return generatedActivityId; },
  set generatedActivityId(value: number) { generatedActivityId = value; },
  get discardFutureAutoplay() { return transport.discardFutureAutoplay; },
  get cancelPendingRadio() { return transport.cancelPendingRadio; },
  get planItemTrack() { return planItemTrack; },
  get autoReasonKey() { return autoReasonKey; },
  get autoOpeningAborter() { return autoOpeningAborter; },
  set autoOpeningAborter(value: AbortController | null) { autoOpeningAborter = value; },
  get emitPlaybackEvent() { return transport.emitPlaybackEvent; },
  get ensureAutoplay() { return transport.ensureAutoplay; },
  get stageNext() { return transport.stageNext; },
  get nextEntry() { return transport.nextEntry; },
  get recoverCurrent() { return transport.recoverCurrent; }
};
let transport = createTransport(playbackHost);
let sessionController = createSession(playbackHost);
let dj = createDj(playbackHost);
let userPlaybackStartedThisSession = false;
let generatedQueue: GeneratedQueueController | null = null;
let autoPlaybackPrefs: { shuffle: boolean; repeat: RepeatMode } | null = null;
let autoSessionEpoch = 0;
let pendingImmediateAutoTrack: Track | null = null;
let autoOpeningAborter: AbortController | null = null;
const AUTOPLAY_TARGET = 8;
const AUTOPLAY_PREPARE_THRESHOLD = 2;
/** Matches REFILL_THRESHOLD.autoplay in generatedQueue: deep enough that a
 * refill has room to fail and retry before the lane actually runs out. */
const AUTOPLAY_REFILL_THRESHOLD = 5;
function applyPlaylistMutation(res: { playlists?: PlaylistMap; settings?: LibrarySettings }): void {
  if (res.playlists) setState('playlists', res.playlists);
  if (res.settings) setState('librarySettings', res.settings);
}

export const actions = {
  syncLibrary,
  syncLibrarySoon,

  /** Record that a catalog row resolved to this video. Cheap, local, and the
   * only way a Deezer row can know it is the song that just finished
   * downloading — the two share no id until this link exists. */
  linkCatalogItem(itemId: string, videoId: string): void {
    if (!itemId || !videoId) return;
    setCatalogLinks((prev) => {
      if (prev.get(itemId) === videoId) return prev; // no write, no invalidation
      const next = new Map(prev);
      next.set(itemId, videoId);
      return next;
    });
  },

  /**
   * Add a song to the library, or take it back out. No file involved.
   *
   * Whether it is downloaded never enters into it — the entry carries its own
   * identity and snapshot, so the same call works from a library row, a YouTube
   * result and a Deezer row alike. Downloading afterwards is a separate act
   * that rewrites nothing here: the entry simply starts resolving to the file.
   *
   * Unsaving takes the favourite mark with it. There is nothing left to mark.
   */
  toggleSaved(entry: SavedEntry): void {
    if (!entry.keys.length) return;
    vibrate();
    const prev = state.saved.slice();
    const has = isSavedKeys(entry.keys);
    const next = has
      ? prev.filter((f) => !f.keys.some((k) => entry.keys.includes(k)))
      : [entry, ...prev];
    setState('saved', next); // optimistic
    api.toggleSaved(entry).catch(() => setState('saved', prev)); // revert on failure
  },

  /** Save or unsave the song this track is, whatever id the surface holds. */
  toggleSavedTrack(track: Track): void {
    actions.toggleSaved(savedFromTrack(track));
  },

  /**
   * Mark a song out among the ones you have, or take the mark off.
   *
   * Marking a song the library does not hold saves it in the same act — you
   * cannot single out a song you do not have, and the UI only offers the heart
   * once a song is yours, so this is the safety net rather than the usual path.
   * Unmarking is only ever that: the song stays in the library.
   */
  toggleFavourite(entry: SavedEntry): void {
    if (!entry.keys.length) return;
    vibrate();
    const prev = state.saved.slice();
    const has = isFavouriteKeys(entry.keys);
    const existing = savedEntryForKeys(entry.keys);
    const next = existing
      ? prev.map((f) => (f === existing ? { ...f, favourite: !has } : f))
      : [{ ...entry, favourite: true }, ...prev];
    setState('saved', next); // optimistic
    api.toggleFavourite(entry)
      .then(() => {
        if (has) return;
        const owned = ownedTrackForKeys(entry.keys);
        void api.emitDiscoveryEvent('music_favourited', {
          media_type: 'music_track',
          track_id: owned?.id,
          title: entry.title ?? owned?.title,
          artist: entry.artist ?? owned?.artist,
          album: entry.album ?? owned?.album,
          youtube_id: owned?.youtube_id ?? savedVideoId(entry) ?? undefined,
          source: owned ? 'library' : 'preview',
        }).catch(() => {});
      })
      .catch(() => setState('saved', prev)); // revert on failure
  },

  /** Mark or unmark the song this track is, whatever id the surface holds. */
  toggleFavouriteTrack(track: Track): void {
    actions.toggleFavourite(savedFromTrack(track));
  },

  /** Enter the DJ workspace. It may be empty; Auto no longer invents a seed. */
  enterAutoMode(): void {
    const current = state.playback.currentTrack;
    if (state.autoMode.active || (current && isPodcastTrack(current))) return;
    autoSessionEpoch += 1;
    pendingImmediateAutoTrack = null;
    autoOpeningAborter?.abort();
    autoOpeningAborter = null;
    dj.autoHandoffFailures = 0;
    dj.autoHandoffCooldownUntil = 0;
    autoPlaybackPrefs = {
      shuffle: state.playback.shuffle,
      repeat: state.playback.repeat,
    };
    transport.discardFutureAutoplay();
    transport.cancelPendingRadio();
    // Take the wheel while preserving explicit queue occurrences.
    const prefix = state.playback.queue.slice(0, state.playback.index + 1);
    const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
    setState('playback', {
      shuffle: false,
      repeat: 'off',
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
      queue: [...prefix, ...manual],
    });
    setState('autoMode', {
      active: true,
      phase: current ? 'planning' : 'idle',
      activity: null,
      plan: {},
      sources: [],
      heard: current ? [current] : [],
      avoidedIdentities: [],
      transition: { status: 'idle' },
      pendingDirection: false,
      repairing: false,
      staleSeams: [],
    });
    // Entering the workspace is what starts the session. What decides that is
    // whether there is a song to plan *from* — never what the transport is
    // doing. The two used to be one condition, and `isPlaying` is false in far
    // more places than "the listener pressed pause": a page thawed after a
    // spell frozen in a pocket, a `pause` delivered from a deck, a session put
    // back on boot. In every one of them Auto opened with an empty route that
    // only a play press would fill — the transport driving the mode instead of
    // the other way round.
    if (current) {
      // Normally a no-op — the graph was built at the session's first touch —
      // but it also covers a listener who reached Auto Mode without one (a
      // keyboard shortcut, a restored session) and resumes a context that was
      // interrupted while the app sat in the background.
      audioService.unlockAudio();
      void ensureGeneratedQueue().start('auto_mode', current, state.autoMode.profile);
    }
  },

  /** Leave Auto: generated guesses disappear; user route occurrences survive. */
  exitAutoMode(): void {
    dj.cancelRunwayReplan();
    pendingImmediateAutoTrack = null;
    autoOpeningAborter?.abort();
    autoOpeningAborter = null;
    // A blend that is already sounding finishes on its own; cancelling it would
    // revive the faded-out song while the UI names the new one. Anything merely
    // prepared is dropped.
    if (audioService.mixPhase() !== 'crossfading') audioService.cancelMix('exit');
    const prefix = state.playback.queue.slice(0, state.playback.index + 1);
    const survivors = futureEntries(state.playback.queue, state.playback.index)
      .filter((entry) => (
        entry.queueLane === 'manual'
        || entry.autoRoute?.kind === 'user'
        || (audioService.mixPhase() === 'crossfading' && dj.committedTransition?.queueId === entry.queueId)
      ))
      .map((entry) => ({ ...entry, queueLane: 'manual' as const, queueSource: 'add_to_queue' as const, autoRoute: undefined }));
    setState('playback', 'queue', [...prefix, ...survivors]);
    generatedQueue?.stop('auto_mode');
    if (autoPlaybackPrefs) {
      setState('playback', {
        shuffle: autoPlaybackPrefs.shuffle,
        repeat: autoPlaybackPrefs.repeat,
      });
      autoPlaybackPrefs = null;
    }
    setState('autoMode', {
      active: false,
      phase: 'idle',
      sources: [],
      heard: [],
      avoidedIdentities: [],
      plan: {},
      pendingDirection: false,
      repairing: false,
      staleSeams: [],
    });
  },

  addAutoSource(tracks: Track[], label: string): void {
    const usable = tracks.filter((track) => !isPodcastTrack(track));
    if (!state.autoMode.active || usable.length === 0) return;
    const source: AutoMusicSet = {
      id: randomId(),
      label: label.trim() || usable[0].title,
      tracks: usable,
      activation: Math.max(0, ...state.autoMode.sources.map((item) => item.activation)) + 1,
    };
    setState('autoMode', 'sources', (sources) => [...sources, source]);
    // A source is direction, never an implied playback request — and rewriting
    // the runway is not one, so a session waiting on a red light takes the
    // steer exactly like a sounding one. `removeAutoSource` always did.
    if (state.playback.currentTrack) dj.scheduleRunwayReplan(tr('autoMode.note.direction'));
    else void dj.startAutoFromSources();
  },

  /** Steer the session from one song.
   *
   * It answers out loud in both directions: the tray is a drop target you can
   * reach from a panel it is not on, and dropping a song that was already a
   * source used to land on silence indistinguishable from a missed target. */
  useAutoTrackAsSource(track: Track): void {
    if (!state.autoMode.active || isPodcastTrack(track)) return;
    const identity = queueIdentity(track);
    const existing = state.autoMode.sources.find((source) => (
      source.tracks.length === 1 && queueIdentity(source.tracks[0]) === identity
    ));
    if (existing) {
      toast.info(tr('autoMode.source.already', { title: track.title }));
      return;
    }
    actions.addAutoSource([track], track.title);
    toast.info(tr('autoMode.source.added', { title: track.title }));
  },

  removeAutoSource(id: string): void {
    if (!state.autoMode.active) return;
    setState('autoMode', 'sources', (sources) => sources.filter((source) => source.id !== id));
    if (state.playback.currentTrack && state.autoMode.heard.length) {
      dj.scheduleRunwayReplan(tr('autoMode.note.direction'));
    }
  },

  /** Drop one occurrence.
   *
   * The toast carries the stronger reading of the same gesture — "and don't
   * bring it back" — which is why the route row needs no overflow menu to
   * reach it. Removing and avoiding are the same act at two strengths, so they
   * belong on one control rather than two.
   */
  removeAutoRouteOccurrence(queueId: string): void {
    const track = dj.dropAutoRouteOccurrence(queueId);
    if (!track) return;
    toast.action(tr('autoMode.note.dropped', { title: track.title }), tr('autoMode.route.avoidSession'), () => {
      if (state.autoMode.active) dj.avoidAutoIdentity(track);
    });
  },

  avoidAutoTrackForSession(queueId: string): void {
    const track = dj.dropAutoRouteOccurrence(queueId);
    if (track) dj.avoidAutoIdentity(track);
  },

  setAutoProfile(profile: AutoProfile): void {
    try {
      localStorage.setItem('auto:profile', profile);
    } catch {
      /* private mode / storage disabled */
    }
    setState('autoMode', 'profile', profile);
    dj.scheduleRunwayReplan(tr(`autoMode.note.crate.${profile}`));
  },

  setAutoDjProfile(profile: DjProfile): void {
    try {
      localStorage.setItem('auto:dj-profile', profile);
    } catch {
      /* private mode / storage disabled */
    }
    setState('autoMode', 'djProfile', profile);
    dj.scheduleRunwayReplan(tr(`autoMode.note.dj.${profile}`));
  },

  /** `note` is what the listener asked for, for the booth to repeat back: their
   * own words when they typed them, otherwise the control they moved. */
  setAutoDirection(direction: Partial<DjDirection>, note?: string): void {
    setState('autoMode', 'direction', (current) => ({ ...current, ...direction }));
    dj.scheduleRunwayReplan(note ?? tr('autoMode.note.direction'));
  },

  /** Say something in the booth's voice without touching the route — used while
   * a spoken request is being looked up, and when nothing answers to the name. */
  reportAutoActivity(key: string, status: AutoActivity['status'], values?: Record<string, string | number>): void {
    if (!state.autoMode.active) return;
    setState('autoMode', 'activity', { id: ++generatedActivityId, status, key, values });
  },

  async placeAutoTrack(track: Track, beforeQueueId?: string): Promise<void> {
    if (!state.autoMode.active || isPodcastTrack(track)) return;
    const floor = dj.insertionFloor();
    const route = state.playback.queue.slice(floor + 1);
    const seed = state.playback.queue[floor] ?? state.playback.currentTrack;
    const occurrence = {
      ...createQueueEntry(track, 'generated', 'auto_mode'),
      autoRoute: { kind: 'user' as const, placement: beforeQueueId ? 'fixed' as const : 'dj' as const },
    };
    if (!seed) {
      setState('playback', { queue: [occurrence], index: 0, shuffle: false, repeat: 'off' });
      transport.loadIndex(0);
      void ensureGeneratedQueue().start('auto_mode', occurrence, state.autoMode.profile);
      return;
    }
    const sessionEpoch = autoSessionEpoch;
    const routeSignature = route.map((entry) => entry.queueId).join('|');
    const fallbackIndex = beforeQueueId
      ? Math.max(floor + 1, state.playback.queue.findIndex((entry) => entry.queueId === beforeQueueId))
      : floor + 1;
    setState('autoMode', 'activity', {
      id: ++generatedActivityId,
      status: 'working',
      key: 'autoMode.agent.placing',
      values: { title: track.title },
    });
    try {
      const response = await api.placeDjTrack({
        dj_profile: state.autoMode.djProfile,
        seed: dj.djItemRef(seed),
        route: route.map((entry) => ({ ...dj.djItemRef(entry), queue_id: entry.queueId })),
        track,
        requested_queue_id: occurrence.queueId,
        before_queue_id: beforeQueueId,
        sources: state.autoMode.sources.map(({ id, label, tracks, activation }) => ({ id, label, tracks, activation })),
        heard: state.autoMode.heard,
        exclude: state.autoMode.avoidedIdentities,
      });
      if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
      const currentRoute = state.playback.queue.slice(dj.insertionFloor() + 1);
      if (currentRoute.map((entry) => entry.queueId).join('|') !== routeSignature) {
        const currentFloor = dj.insertionFloor();
        const before = beforeQueueId
          ? state.playback.queue.findIndex((entry) => entry.queueId === beforeQueueId)
          : currentFloor + 1;
        const at = before > currentFloor ? before : currentFloor + 1;
        setState('playback', 'queue', (queue) => [...queue.slice(0, at), occurrence, ...queue.slice(at)]);
        transport.prefetchUpcoming();
        return;
      }
      const entries = response.items.map((item) => {
        const isUser = item.route_kind === 'user';
        const entry = isUser
          ? occurrence
          : createQueueEntry(planItemTrack(item), 'generated', 'auto_mode');
        return {
          ...entry,
          autoRoute: isUser
            ? occurrence.autoRoute
            : { kind: 'bridge' as const, ownerQueueId: occurrence.queueId },
        };
      });
      const at = Math.min(state.playback.queue.length, floor + 1 + response.insert_at);
      setState('playback', 'queue', (queue) => [...queue.slice(0, at), ...entries, ...queue.slice(at)]);
      const plan = { ...state.autoMode.plan };
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
          lineage: item.lineage,
        };
        fromKey = queueIdentity(entry);
      }
      const following = state.playback.queue[at + entries.length];
      if (following && response.following_transition) {
        plan[following.queueId] = {
          ...(plan[following.queueId] ?? {
            trackId: queueIdentity(following),
            source: 'local',
            reasonKey: 'autoMode.reason.library',
          }),
          fromKey,
          transition: response.following_transition,
        };
      }
      setState('autoMode', {
        plan,
        activity: {
          id: ++generatedActivityId,
          status: 'done',
          key: 'autoMode.agent.placed',
          values: { title: track.title },
        },
      });
      const insertedIds = new Set(entries.map((entry) => entry.queueId));
      toast.action(tr('autoMode.note.added', { title: track.title }), tr('common.undo'), () => {
        if (!state.autoMode.active) return;
        setState('playback', 'queue', (queue) => queue.filter((entry) => !insertedIds.has(entry.queueId)));
        setState('autoMode', 'plan', (current) => Object.fromEntries(
          Object.entries(current).filter(([queueId]) => !insertedIds.has(queueId)),
        ));
        void generatedQueue?.ensureRunway();
      });
      transport.prefetchUpcoming();
    } catch {
      // The user's placement is authoritative even if musical analysis is not.
      setState('playback', 'queue', (queue) => [
        ...queue.slice(0, fallbackIndex),
        occurrence,
        ...queue.slice(fallbackIndex),
      ]);
      setState('autoMode', 'activity', {
        id: ++generatedActivityId,
        status: 'error',
        key: 'autoMode.agent.placedFallback',
        values: { title: track.title },
      });
      transport.prefetchUpcoming();
    }
  },

  /**
   * Re-seam the route around whatever the listener has done to it.
   *
   * Every song they put there keeps its slot and the depth they gave it; the
   * material between those songs is re-chosen so each seam mixes. Nothing here
   * runs on its own — dragging a row into a bad position leaves a plain fade,
   * which is the honest fallback, and this is the one thing that rebuilds.
   *
   * Unlike `placeAutoTrack`, a stale answer is discarded rather than applied.
   * A placement is authoritative even when the analysis behind it is not, but a
   * repair describes a route that no longer exists: applying one would
   * resurrect removed songs and reorder around a handoff that has since
   * committed. Do not "fix" this into symmetry with `placeAutoTrack`.
   */
  async repairAutoRoute(): Promise<void> {
    if (!state.autoMode.active || state.autoMode.repairing) return;
    const floor = dj.insertionFloor();
    const seed = state.playback.queue[floor] ?? state.playback.currentTrack;
    const route = state.playback.queue.slice(floor + 1);
    // One seam is a transition, not a route. There is nothing to re-seam.
    if (!seed || route.length < 2) return;

    const sessionEpoch = autoSessionEpoch;
    const routeSignature = route.map((entry) => entry.queueId).join('|');
    const previousQueue = state.playback.queue.slice();
    const previousPlan = { ...state.autoMode.plan };
    const previousStaleSeams = state.autoMode.staleSeams.slice();
    const anchors = route.filter((entry) => dj.autoRouteKind(entry) === 'user').map((entry) => entry.queueId);

    setState('autoMode', {
      repairing: true,
      activity: { id: ++generatedActivityId, status: 'working', key: 'autoMode.agent.repairing' },
    });
    try {
      const response = await api.repairDjRoute({
        dj_profile: state.autoMode.djProfile,
        seed: dj.djItemRef(seed),
        route: route.map((entry) => ({
          ...dj.djItemRef(entry),
          queue_id: entry.queueId,
          route_kind: dj.autoRouteKind(entry),
        })),
        sources: state.autoMode.sources.map(({ id, label, tracks, activation }) => ({ id, label, tracks, activation })),
        heard: state.autoMode.heard,
        exclude: state.autoMode.avoidedIdentities,
      });
      if (!state.autoMode.active || sessionEpoch !== autoSessionEpoch) return;
      const currentFloor = dj.insertionFloor();
      const unchanged = state.playback.queue
        .slice(currentFloor + 1)
        .map((entry) => entry.queueId)
        .join('|') === routeSignature;
      // A handoff that committed mid-flight moves the floor, so it shows up
      // here as a changed route and is caught by the same check.
      if (!unchanged) {
        setState('autoMode', 'activity', {
          id: ++generatedActivityId, status: 'error', key: 'autoMode.agent.repairSkipped',
        });
        return;
      }
      // Cheap insurance against a server regression: a repair that lost one of
      // the listener's songs does nothing at all, rather than losing it here.
      const returned = response.items.filter((item) => item.route_kind === 'user').map((item) => item.queue_id ?? '');
      if (returned.join('|') !== anchors.join('|')) {
        setState('autoMode', 'activity', {
          id: ++generatedActivityId, status: 'error', key: 'autoMode.agent.repairSkipped',
        });
        return;
      }

      const byQueueId = new Map(route.map((entry) => [entry.queueId, entry] as const));
      const entries = response.items.map((item) => {
        const kept = item.queue_id ? byQueueId.get(item.queue_id) : undefined;
        const autoRoute = item.route_kind === 'bridge'
          ? { kind: 'bridge' as const, ownerQueueId: item.owner_queue_id }
          : { kind: 'generated' as const };
        // Spreading the kept entry preserves its lane and context, which is how
        // an explicitly queued song stays an explicit request through a repair.
        if (kept) return item.route_kind === 'user' ? kept : { ...kept, autoRoute };
        return { ...createQueueEntry(planItemTrack(item), 'generated', 'auto_mode'), autoRoute };
      });
      setState('playback', 'queue', (queue) => [...queue.slice(0, floor + 1), ...entries]);

      // Everything up to and including the floor keeps its plan. Wiping it
      // wholesale would strip the cued handoff's own entry and turn a blend
      // that is already loaded into a fade at the moment it fires.
      const prefix = new Set(state.playback.queue.slice(0, floor + 1).map((entry) => entry.queueId));
      const plan: Record<string, AutoPlanItem> = Object.fromEntries(
        Object.entries(state.autoMode.plan).filter(([id]) => prefix.has(id)),
      );
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
          key: item.analysis?.key,
        };
        fromKey = queueIdentity(entry);
      });
      setState('autoMode', {
        plan,
        // The whole route was just re-seamed: every join it covers is planned
        // again, which is exactly what this list was tracking.
        staleSeams: [],
        activity: { id: ++generatedActivityId, status: 'done', key: 'autoMode.agent.repaired' },
      });
      transport.prefetchUpcoming();
      toast.action(tr('autoMode.note.repaired'), tr('common.undo'), () => {
        if (!state.autoMode.active || autoSessionEpoch !== sessionEpoch) return;
        if (dj.insertionFloor() !== floor) return;
        if (state.playback.queue[floor]?.queueId !== previousQueue[floor]?.queueId) return;
        setState('playback', 'queue', previousQueue);
        setState('autoMode', { plan: previousPlan, staleSeams: previousStaleSeams });
        transport.prefetchUpcoming();
      });
    } catch {
      // Nothing was written — the queue is only touched once an answer lands —
      // so there is no half-repaired route to unwind.
      setState('autoMode', 'activity', {
        id: ++generatedActivityId, status: 'error', key: 'autoMode.agent.repairFailed',
      });
    } finally {
      setState('autoMode', 'repairing', false);
    }
  },

  /**
   * "Next" inside Auto Mode.
   *
   * A skip is still a mix, just a short one: the listener asked for the next
   * track, not for a hard cut. The handoff is reported immediately — they
   * already know the track changed — while the blend itself lands underneath.
   */
  async autoSkip(): Promise<void> {
    const canAdvance = () => state.playback.index < state.playback.queue.length - 1;
    if (canAdvance()) {
      const pb = state.playback;
      const next = pb.queue[pb.index + 1];
      const current = pb.currentTrack;
      listeningLearning.skip(current, dj.playingDuration());
      if (audioService.mixPhase() !== 'idle') {
        // A blend was already prepared for this exact pair: bring it forward.
        audioService.startMixNow();
      } else if (next && current) {
        const fromKey = queueIdentity(current);
        const item = state.autoMode.plan[next.queueId];
        const chained = item?.fromKey === fromKey ? item.transition : undefined;
        const trusted = (chained?.confidence ?? 0) >= dj.TRUSTED_CONFIDENCE;
        dj.commitTransition(next, fromKey, {
          technique: trusted ? chained!.technique : 'safe_fade',
          out_cue: 0, // a manual skip blends from wherever the track is now
          in_cue: trusted ? chained!.in_cue : 0,
          overlap_seconds: 1.6,
          overlap_bars: chained?.overlap_bars ?? 0,
          playback_rate: trusted ? chained!.playback_rate : 1,
          confidence: chained?.confidence ?? 0,
        }, true);
      } else {
        actions.next();
      }
      void generatedQueue?.ensureRunway();
      return;
    }
    await generatedQueue?.refillNow();
    // A failed final URL can happen while a refill is already in flight. Wait
    // briefly for that real plan instead of leaving Auto stopped on the error.
    for (let attempt = 0; attempt < 28 && state.autoMode.active; attempt += 1) {
      if (canAdvance()) {
        actions.next();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },

  /** Play a list starting at index `i`; its remaining tracks become the finite
   * context. Explicitly queued tracks survive the context switch and are placed
   * immediately after the selected track.
   *
   * Pass `{ radio: true }` when the queue is the seed-only radio placeholder so
   * `radioMode`/`radioSeedId` are set; `radioLoading` is preserved (the caller
   * manages it through the async mix resolution). Without `radio`, all radio
   * flags are reset — `playTrack`/`playShuffled`/external callers therefore
   * cancel any active radio session. */
  playFrom(
    tracks: Track[],
    i: number,
    opts?: {
      radio?: boolean;
      context?: PlaybackContextDescriptor;
      shuffled?: boolean;
      preserveManual?: boolean;
    },
  ): void {
    if (!tracks[i]) return;
    transport.discardFutureAutoplay();
    const isRadio = opts?.radio === true;
    if (!isRadio) transport.cancelPendingRadio();
    if (!isRadio && state.autoMode.active) {
      const selected = tracks[i];
      if (isPodcastTrack(selected)) {
        void dj.confirmNormalMode('podcast', () => actions.playFrom(tracks, i, opts));
      } else {
        dj.mixAutoTrackNow(selected);
      }
      return;
    }
    const context = opts?.context ?? defaultContext(tracks);
    const source: QueueSource = isRadio ? 'radio' : contextSource(context.kind);
    const contextQueue = tracks.map((track, contextIndex) =>
      createQueueEntry(track, 'context', source, context, contextIndex));
    const preservedManual =
      opts?.preserveManual === false ? [] : futureEntries(state.playback.queue, state.playback.index, 'manual');
    const queue = [
      ...contextQueue.slice(0, i + 1),
      ...preservedManual,
      ...contextQueue.slice(i + 1),
    ];
    setState('playback', {
      queue,
      shuffle: opts?.shuffled === true,
      radioMode: isRadio,
      radioLoading: isRadio ? state.playback.radioLoading : false,
      radioSeedId: isRadio ? (tracks[i]?.id ?? null) : null,
    });
    transport.loadIndex(i);
  },

  /** Play a single track (queue = just this track). */
  playTrack(track: Track): void {
    actions.playFrom([track], 0);
  },

  /** Play a list with shuffle on, starting from a random entry. */
  playShuffled(tracks: Track[], context?: PlaybackContextDescriptor): void {
    if (tracks.length === 0) return;
    if (state.autoMode.active) {
      actions.addAutoSource(tracks, context?.label || tr('autoMode.source.selection'));
      return;
    }
    actions.playFrom(shuffled(tracks), 0, { context, shuffled: true });
  },

  /** Play a podcast episode: queue = just this episode; stream via a minted token. */
  async playEpisode(ep: PodcastEpisode, showTitle?: string, feedId?: string): Promise<void> {
    if (state.autoMode.active) {
      await dj.confirmNormalMode('podcast', () => actions.playEpisode(ep, showTitle, feedId));
      return;
    }
    transport.discardFutureAutoplay();
    transport.cancelPendingRadio();
    const track = podcastEpisodeToTrack(ep, showTitle, feedId);
    // Tapping the same episode again while its token is still being minted must
    // not mint a second one.
    const pb = state.playback;
    if (pb.currentTrack?.id === track.id && (pb.isLoading || pb.isPlaying)) return;
    userPlaybackStartedThisSession = true;
    const generation = transport.beginLoad();
    transport.createPlaybackAttempt(track, generation, 'podcast');
    setState('playback', {
      currentTrack: track,
      queue: [createQueueEntry(track, 'context', 'podcast', {
        id: feedId || ep.guid,
        kind: 'podcast',
        label: showTitle || track.artist,
      })],
      index: 0,
      isPlaying: true,
      isLoading: true,
      loadError: false,
      phase: 'loading',
      currentTime: 0,
      duration: 0,
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    transport.updateMediaSession(track);
    try {
      const { stream_token } = await api.podcastPeek(ep.enclosure_url);
      if (!stream_token) throw new Error('no token');
      await audioService.load(podcastStreamUrl(stream_token), 1);
    } catch {
      transport.onPlaybackFailed(generation, 'load');
    }
  },

  /** Enqueue a podcast episode for download. */
  async downloadEpisode(ep: PodcastEpisode, sub: PodcastSubscription | null): Promise<void> {
    const t = toast.loading(tr('toast.addingDownloads'));
    try {
      await api.enqueuePodcastEpisode({
        enclosure_url: ep.enclosure_url,
        guid: ep.guid,
        title: ep.title,
        show_title: sub?.title,
        thumbnail_url: ep.image,
        duration_sec: ep.duration_sec,
        podcast_feed_id: sub?.id,
        podcast_rss_url: sub?.rss_url,
      });
      void actions.loadDownloads();
      t.update('success', tr('toast.episodeInDownloads'));
    } catch {
      t.update('error', tr('toast.downloadFailed'));
    }
  },

  togglePlay(): void {
    const pb = state.playback;
    if (!pb.currentTrack) return;
    // A failed track's transport button is a retry, not a play button — and it
    // is that whichever way the state happens to be leaning.
    if (pb.loadError) {
      vibrate();
      actions.retryCurrent();
      return;
    }
    if (pb.isPlaying) actions.pausePlayback();
    else actions.resumePlayback();
  },

  /**
   * Start, or carry on. Separate from `togglePlay` because the OS asks for this
   * by name: a lock screen, a steering wheel or a car head unit sends `play`,
   * and answering it with a toggle means a stale `isPlaying` — which is exactly
   * what a page that has been frozen in a pocket has — pauses the music the
   * listener just asked to hear.
   */
  resumePlayback(origin: ProgramTransportOrigin = 'ui'): void {
    const pb = state.playback;
    if (!pb.currentTrack) return;
    userPlaybackStartedThisSession = true;
    vibrate();
    // A failed track's transport button is a retry, not a play button.
    if (pb.loadError) {
      actions.retryCurrent();
      return;
    }
    // The track this deck holds is over. Play means "carry on", not "hear that
    // one again" — and this is also the gesture a platform may have been waiting
    // for, so it is the moment to reclaim the audio session.
    if (pb.phase === 'starved') {
      audioService.unlockAudio();
      setState('playback', 'needsGesture', false);
      dj.resumeFromStarved();
      return;
    }
    // An Auto session with nobody planning for it: the workspace was entered
    // before there was anything to plan from, or it was restored from another
    // device, which brings the route and the sources but no planner behind
    // them. Pressing play is what starts one.
    if (state.autoMode.active && generatedQueue?.activeIntent() !== 'auto_mode') {
      if (state.autoMode.sources.length === 0) {
        setState('autoMode', { heard: [pb.currentTrack], phase: 'planning' });
      }
      void ensureGeneratedQueue().start('auto_mode', pb.currentTrack, state.autoMode.profile);
    }
    const generation = transport.beginLoad();
    const attempt = transport.createPlaybackAttempt(pb.currentTrack, generation, 'resume');
    setState('playback', { isLoading: true, phase: 'loading' });
    void audioService.resume(origin).catch(() => transport.onPlaybackFailed(attempt.generation, 'load'));
  },

  /** Stop, and mean it. The other half of the pair above. */
  pausePlayback(origin: ProgramTransportOrigin = 'ui'): void {
    const pb = state.playback;
    if (!pb.currentTrack) return;
    vibrate();
    if (pb.loadError) return;
    if (pb.phase === 'loading' || pb.phase === 'recovering') {
      transport.cancelActiveAttempt('user_pause');
      setState('playback', { isPlaying: false, isLoading: false, phase: 'paused' });
      const previewId = pb.currentTrack.source === 'preview' ? playbackYoutubeId(pb.currentTrack) : null;
      if (previewId) void api.cancelPreview(previewId).catch(() => {});
    }
    audioService.pause(origin);
  },

  /** Re-request the current entry after a failure (transport retry button). */
  retryCurrent(): void {
    const pb = state.playback;
    if (!pb.currentTrack || pb.index < 0) return;
    transport.consecutiveLoadFailures = 0;
    transport.loadIndex(pb.index, { restart: true, trigger: 'retry', freshDeck: true });
  },

  next(trigger: PlaybackTrigger = 'next'): void {
    // Every path out of here either loads a deck or does nothing; loading
    // cancels the mixer, which reports back and clears the DJ state itself.
    if (audioService.mixPhase() !== 'idle') audioService.cancelMix('load');
    const pb = state.playback;
    if (pb.queue.length === 0) return;
    if (pb.index < pb.queue.length - 1) transport.loadIndex(pb.index + 1, { trigger });
    else if (pb.repeat === 'all') {
      const cycle = transport.repeatCycle(pb.queue);
      if (cycle.length > 0) {
        setState('playback', { queue: cycle, index: 0 });
        transport.loadIndex(0, { trigger });
      }
    }
  },

  prev(): void {
    if (state.playback.currentTime > 3) {
      actions.seek(0);
      return;
    }
    const pb = state.playback;
    if (pb.index > 0) transport.loadIndex(pb.index - 1);
    else actions.seek(0);
  },

  seek(t: number): void {
    audioService.seek(t);
    setState('playback', 'currentTime', Math.max(0, t));
    sessionController.pushPlaybackState();
  },

  /** Jump to a specific entry in the current queue. */
  jumpTo(i: number): void {
    transport.loadIndex(i);
  },

  // ── Queue management (client-side; the playback queue lives in the store) ──
  /** Append a track to the end of the queue (starts playback if idle). */
  enqueue(track: Track): void {
    if (state.autoMode.active && !isPodcastTrack(track)) {
      void actions.placeAutoTrack(track);
      return;
    }
    if (state.playback.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    transport.discardFutureAutoplay();
    const at = manualInsertIndex(state.playback.queue, dj.insertionFloor(), 'last');
    const entry = createQueueEntry(track, 'manual', 'add_to_queue');
    setState('playback', 'queue', (q) => [...q.slice(0, at), entry, ...q.slice(at)]);
    toast.success(tr('toast.addedToQueue'));
    transport.prefetchUpcoming();
  },

  /** Play a track right now WITHOUT discarding the queue: jumps to it if it is
   * already queued (cross-source: a preview and its downloaded twin match),
   * otherwise inserts it right after the current entry and plays it. The rest
   * of the queue keeps playing afterwards. */
  playNow(track: Track): void {
    const pb = state.playback;
    if (pb.queue.length === 0 && !state.autoMode.active) {
      actions.playTrack(track);
      return;
    }
    if (pb.currentTrack && queueIndexOf([pb.currentTrack], track) === 0) {
      if (pb.isLoading || pb.isPlaying) return;
      if (pb.loadError) actions.retryCurrent();
      else void audioService.resume();
      return;
    }
    if (state.autoMode.active) {
      if (isPodcastTrack(track)) void dj.confirmNormalMode('podcast', () => actions.playNow(track));
      else dj.mixAutoTrackNow(track);
      return;
    }
    // Explicitly requested a different track: cancel generators but preserve
    // the manual/context runway behind the interruption.
    transport.discardFutureAutoplay();
    transport.cancelPendingRadio();
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    const insertAt = pb.index + 1;
    const entry = createQueueEntry(track, 'manual', 'play_next');
    setState('playback', 'queue', (q) => [...q.slice(0, insertAt), entry, ...q.slice(insertAt)]);
    transport.loadIndex(insertAt);
  },

  /** Insert a track right after the current one (starts playback if idle). */
  playNext(track: Track): void {
    if (state.autoMode.active && !isPodcastTrack(track)) {
      void actions.placeAutoTrack(track);
      return;
    }
    const pb = state.playback;
    if (pb.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    transport.discardFutureAutoplay();
    // Never in front of a handoff that is already loaded and cued.
    const at = dj.insertionFloor() + 1;
    const entry = createQueueEntry(track, 'manual', 'play_next');
    setState('playback', 'queue', (q) => [...q.slice(0, at), entry, ...q.slice(at)]);
    toast.success(tr('toast.playNextConfirmed'));
    transport.prefetchUpcoming();
  },

  /** Remove the queue entry at `i`, keeping playback coherent. */
  removeFromQueue(i: number): void {
    const pb = state.playback;
    if (i < 0 || i >= pb.queue.length) return;
    const next = pb.queue.filter((_, idx) => idx !== i);
    if (i === pb.index) {
      setState('playback', 'queue', next);
      if (next.length === 0) {
        transport.cancelActiveAttempt('queue_empty');
        audioService.stop();
        setState('playback', {
          currentTrack: null,
          index: -1,
          isPlaying: false,
          isLoading: false,
          loadError: false,
          phase: 'idle',
        });
      } else {
        transport.loadIndex(Math.min(i, next.length - 1));
      }
      return;
    }
    setState('playback', 'queue', next);
    if (i < pb.index) setState('playback', 'index', pb.index - 1);
    if (state.playback.radioMode || state.autoMode.active) {
      void generatedQueue?.ensureRunway();
    }
  },

  /** Reorder a queue entry, tracking the current index across the move. */
  moveInQueue(from: number, to: number): void {
    const pb = state.playback;
    if (from === to || from < 0 || to < 0 || from >= pb.queue.length || to >= pb.queue.length) return;
    if (!sameQueueSection(pb.queue[from], pb.queue[to])) return;
    const q = pb.queue.slice();
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    let index = pb.index;
    if (from === pb.index) index = to;
    else {
      if (from < index) index--;
      if (to <= index) index++;
    }
    setState('playback', { queue: q, index });
    transport.prefetchUpcoming();
  },

  /**
   * Bring a track from the prepared route forward.
   *
   * Inside Auto Mode a runway card is a plan, not a destination: promoting it
   * keeps the session running, where jumping to it used to hard-load a stream
   * over whatever the DJ had already prepared. It never lands in front of a
   * committed handoff.
   */
  promoteInAutoRoute(queueId: string): void {
    const pb = state.playback;
    const from = pb.queue.findIndex((entry) => entry.queueId === queueId);
    const to = dj.insertionFloor() + 1;
    if (from <= pb.index || from === to || to > from) return;
    const queue = pb.queue.slice();
    const [entry] = queue.splice(from, 1);
    queue.splice(to, 0, entry);
    setState('playback', 'queue', queue);
    transport.prefetchUpcoming();
  },

  /**
   * Move one route entry, carrying the bridges that belong with it.
   *
   * A bridge exists only to reach the song it leads into, so the two travel as
   * one block: dragging either row moves the pair, and dragging the owner no
   * longer deletes the bridge out from under the cursor mid-drag. Landing marks
   * the entry as the listener's, which is what makes a later repair re-seam
   * *around* it instead of putting it back.
   *
   * What a move deliberately does not do is mend the mix. The joins it opens go
   * into `staleSeams` for the route to show, and the toast carries the repair —
   * re-planning on every drag would spend a round trip per nudge and rewrite
   * rows the listener is still aiming at.
   */
  moveAutoRoute(queueId: string, beforeQueueId?: string): void {
    if (!state.autoMode.active || queueId === beforeQueueId) return;
    const source = state.playback.queue.find((entry) => entry.queueId === queueId);
    if (!source) return;
    // Grabbing a bridge is a request to move what it leads into: on its own it
    // connects nothing, and leaving it behind would strand its owner.
    const ownerId = source.autoRoute?.kind === 'bridge' && source.autoRoute.ownerQueueId
      ? source.autoRoute.ownerQueueId
      : queueId;
    const blockIds = new Set(state.playback.queue
      .filter((entry) => entry.queueId === ownerId
        || (entry.autoRoute?.kind === 'bridge' && entry.autoRoute.ownerQueueId === ownerId))
      .map((entry) => entry.queueId));
    if (!blockIds.has(ownerId) || (beforeQueueId && blockIds.has(beforeQueueId))) return;

    const floor = dj.insertionFloor();
    const start = state.playback.queue.findIndex((entry) => blockIds.has(entry.queueId));
    if (start <= floor) return;
    const block = state.playback.queue.filter((entry) => blockIds.has(entry.queueId));
    const rest = state.playback.queue.filter((entry) => !blockIds.has(entry.queueId));
    // Everything before the block is untouched by lifting it out, so the row
    // that closes over the gap is the one that lands on its old index.
    const closed = rest[start]?.queueId;
    const target = beforeQueueId ? rest.findIndex((entry) => entry.queueId === beforeQueueId) : rest.length;
    // Never in front of a handoff that is already loaded. The route panel stops
    // offering that seam; this is what happens if anything else asks for it.
    const at = Math.max(floor + 1, target === -1 ? rest.length : target);
    const moved = block.map((entry) => (entry.queueId === ownerId
      ? { ...entry, autoRoute: { kind: 'user' as const, placement: 'fixed' as const } }
      : entry));
    const queue = [...rest.slice(0, at), ...moved, ...rest.slice(at)];

    const opened = [moved[0].queueId, closed, rest[at]?.queueId]
      .filter((id): id is string => Boolean(id));
    setState('playback', 'queue', queue);
    setState('autoMode', 'staleSeams', (seams) => {
      const live = new Set(queue.map((entry) => entry.queueId));
      return [...new Set([...seams.filter((id) => live.has(id)), ...opened])];
    });
    transport.prefetchUpcoming();
    const owner = block.find((entry) => entry.queueId === ownerId) ?? source;
    toast.action(tr('autoMode.route.moved', { title: owner.title }), tr('autoMode.route.fix'), () => {
      if (state.autoMode.active) void actions.repairAutoRoute();
    });
  },

  /** Clear explicit upcoming requests without touching context or generators. */
  clearManualQueue(): void {
    const pb = state.playback;
    const queue = pb.queue.filter((entry, index) => index <= pb.index || entry.queueLane !== 'manual');
    setState('playback', 'queue', queue);
    transport.prefetchUpcoming();
  },

  /** Backwards-compatible name for callers outside the queue panel. */
  clearQueue(): void {
    actions.clearManualQueue();
  },

  removeQueueEntry(queueId: string): void {
    const index = state.playback.queue.findIndex((entry) => entry.queueId === queueId);
    if (index !== -1) actions.removeFromQueue(index);
  },

  /** Play one occurrence now without silently discarding earlier manual requests. */
  playQueueEntry(queueId: string): void {
    const pb = state.playback;
    const from = pb.queue.findIndex((entry) => entry.queueId === queueId);
    if (from === -1 || from === pb.index) return;
    const queue = pb.queue.slice();
    const [entry] = queue.splice(from, 1);
    const at = pb.index + 1;
    queue.splice(at, 0, entry);
    setState('playback', 'queue', queue);
    transport.loadIndex(at);
  },

  /** Start a radio station seeded from a track.
   *
   * The seed starts immediately and the shared generated-queue coordinator
   * fills behind every explicit request. Unlike the old one-shot related mix,
   * the coordinator keeps Radio replenished until the listener stops it.
   *
   * Continuity semantics:
   * - If the seed is the currentTrack AND it's currently playing, we DON'T
   *   reload audio — A keeps playing and the mix appends behind it. When A
   *   finishes, the next mix track (different from A) plays.
   * - Otherwise (seed differs from currentTrack, or nothing playing), we
   *   swap to the seed immediately. The mix loads behind it.
   * - If the first plan fails, we show a toast and exit Radio; later refill
   *   failures degrade quietly and retry without interrupting playback.
   */
  async startRadio(seed: Track): Promise<void> {
    if (isPodcastTrack(seed)) {
      toast.error(tr('toast.radioUnavailable'));
      return;
    }
    if (state.autoMode.active) {
      await dj.confirmNormalMode('radio', () => actions.startRadio(seed));
      return;
    }
    const t = toast.loading(tr('toast.startingRadio'));
    transport.discardFutureAutoplay();
    transport.cancelPendingRadio();
    setState('playback', {
      radioMode: true,
      radioLoading: true,
      radioSeedId: seed.id,
    });

    const isCurrentPlaying =
      state.playback.currentTrack?.id === seed.id && state.playback.isPlaying;

    if (isCurrentPlaying) {
      const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
      setState('playback', {
        queue: [
          createQueueEntry(seed, 'context', 'radio', {
            id: `radio:${seed.id}`,
            kind: 'single',
            label: seed.title,
          }),
          ...manual,
        ],
        index: 0,
      });
    } else {
      actions.playFrom([seed], 0, { radio: true });
    }

    const ready = await ensureGeneratedQueue().start('radio', seed);
    if (
      generatedQueue?.activeIntent() !== 'radio'
      || !state.playback.radioMode
      || state.playback.radioSeedId !== seed.id
    ) {
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
      }).catch(() => {});
      t.update('success', tr('toast.radioStarted'));
    } else {
      t.update('error', tr('toast.radioFailed', { ytId: seed.youtube_id || tr('toast.radioFailedFallback') }));
      generatedQueue.stop('radio');
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
  },

  /** Stop the active radio session. The current track keeps playing, but the
   * rest of the pending mix is dropped from the queue. Invoked from the radio
   * badge popup in the player. */
  stopRadio(): void {
    transport.cancelPendingRadio();
    const cur = state.playback.queue[state.playback.index];
    const manual = futureEntries(state.playback.queue, state.playback.index, 'manual');
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
      queue: cur ? [cur, ...manual] : manual,
      index: cur ? 0 : -1,
    });
  },

  /** Delete a track from the library (optimistic; reverts on failure). */
  async deleteTrack(id: string): Promise<void> {
    const prevLib = state.library.slice();
    const prevPlaylists = Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.slice()]));
    const prevPlayback = { ...state.playback, queue: state.playback.queue.slice() };
    invalidateLibrarySync();
    sessionController.removeTrackReferences(id);
    try {
      await api.deleteTrack(id);
      await actions.syncLibrary();
      toast.success(tr('toast.trackDeleted'));
    } catch {
      setState({ library: prevLib, playlists: prevPlaylists });
      sessionController.restorePlaybackSnapshot(prevPlayback);
      toast.error(tr('toast.deleteFailed'));
      void actions.syncLibrary();
    }
  },

  // ── Track metadata + cover ──
  async updateTrackMetadata(
    id: string,
    meta: { title?: string; artist?: string; album?: string; album_artist?: string | null },
  ): Promise<boolean> {
    const patch: Partial<Track> = {};
    if (meta.title !== undefined) patch.title = meta.title;
    if (meta.artist !== undefined) patch.artist = meta.artist;
    if (meta.album !== undefined) patch.album = meta.album;
    if (meta.album_artist !== undefined) patch.album_artist = meta.album_artist;
    // Write through the row's path rather than rebuilding the array: `.map`
    // hands the store a new array of new objects, so every subscriber to
    // `state.library` re-runs — including the identity index — instead of the
    // one row that changed.
    const index = state.library.findIndex((t) => t.id === id);
    if (index === -1) return false;
    const restore: Partial<Track> = {};
    for (const key of Object.keys(patch) as (keyof Track)[]) {
      restore[key] = state.library[index][key] as never;
    }
    setState('library', index, patch);
    if (state.playback.currentTrack?.id === id)
      setState('playback', 'currentTrack', (c) => (c ? { ...c, ...patch } : c));
    try {
      await api.updateTrackMetadata(id, meta);
      toast.success(tr('toast.dataUpdated'));
      return true;
    } catch {
      setState('library', index, restore);
      toast.error(tr('toast.updateFailed'));
      return false;
    }
  },

  async uploadTrackCover(id: string, file: File): Promise<void> {
    const t = toast.loading(tr('toast.uploadingCover'));
    try {
      await api.uploadTrackCover(id, file);
      bustCovers();
      t.update('success', tr('toast.coverUpdated'));
    } catch {
      t.update('error', tr('toast.coverUploadFailed'));
    }
  },

  async clearTrackCover(id: string): Promise<void> {
    try {
      await api.clearTrackCover(id);
      bustCovers();
      toast.success(tr('toast.coverRemoved'));
    } catch {
      toast.error(tr('toast.coverRemoveFailed'));
    }
  },

  toggleShuffle(): void {
    const pb = state.playback;
    const nextShuffle = !pb.shuffle;
    const prefix = pb.queue.slice(0, pb.index + 1);
    const upcoming = futureEntries(pb.queue, pb.index);
    const manual = upcoming.filter((entry) => entry.queueLane === 'manual');
    const context = upcoming.filter((entry) => entry.queueLane === 'context');
    const generated = upcoming.filter((entry) => entry.queueLane === 'generated');
    const orderedContext = nextShuffle
      ? shuffled(context)
      : context.slice().sort((a, b) => (a.queueContextIndex ?? 0) - (b.queueContextIndex ?? 0));
    setState('playback', {
      shuffle: nextShuffle,
      queue: [...prefix, ...manual, ...orderedContext, ...generated],
    });
    transport.prefetchUpcoming();
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
    if (next !== 'off') transport.discardFutureAutoplay();
    setState('playback', 'repeat', next);
    if (next === 'off') queueMicrotask(() => void transport.ensureAutoplay());
  },

  async setAutoplayEnabled(enabled: boolean): Promise<boolean> {
    const previous = state.playback.autoplayEnabled;
    if (enabled === previous) return true;
    setState('playback', 'autoplayEnabled', enabled);
    if (enabled) queueMicrotask(() => void transport.ensureAutoplay(true));
    else transport.discardFutureAutoplay();
    try {
      await api.setAutoplayEnabled(enabled);
      return true;
    } catch {
      setState('playback', 'autoplayEnabled', previous);
      if (previous) queueMicrotask(() => void transport.ensureAutoplay(true));
      toast.error(tr('toast.updateFailed'));
      return false;
    }
  },

  async setVolumeLeveling(enabled: boolean): Promise<boolean> {
    const previous = state.playback.volumeLeveling;
    if (enabled === previous) return true;
    transport.applyVolumeLeveling(enabled);
    try {
      await api.setVolumeLeveling(enabled);
      return true;
    } catch {
      transport.applyVolumeLeveling(previous);
      toast.error(tr('toast.updateFailed'));
      return false;
    }
  },

  // ── Downloads ──
  /** Enqueue a preview track for download into the library. `source` labels the
   * surface it was asked from, for the discovery signals. */
  async downloadTrack(track: Track, source = 'library'): Promise<void> {
    if (track.source !== 'preview') return;
    // Exclude podcast episodes (handled by downloadEpisode).
    if (isPodcastTrack(track)) return;
    const alreadySaved = state.library.some(
      (t) => t.youtube_id === track.id || t.id === track.id,
    );
    if (alreadySaved) {
      toast.info(tr('toast.alreadyInLibrary'));
      return;
    }
    const alreadyDownloading = state.downloads.queue.some(
      (i) => i.video_id === track.id && i.status !== 'failed' && i.status !== 'interrupted',
    );
    if (alreadyDownloading) {
      toast.info(tr('toast.alreadyInDownloadsQueue'));
      return;
    }
    const t = toast.loading(tr('toast.addingDownloads'));
    try {
      await api.enqueueDownload([
        {
          source_type: 'youtube_url',
          song_str: `https://www.youtube.com/watch?v=${track.id}`,
          video_id: track.id,
          display_title: track.title,
          display_artist: track.artist,
          thumbnail_url: track.cover,
          duration_sec: track.duration,
          metadata_evidence: null,
        },
      ]);
      void actions.loadDownloads();
      void api.emitDiscoveryEvent('music_added_to_queue', {
        title: track.title,
        artist: track.artist,
        source,
        youtube_id: track.id,
      }).catch(() => {});
      t.update('success', tr('toast.addedToDownloads'));
    } catch {
      t.update('error', tr('toast.addToDownloadsFailed'));
    }
  },

  /**
   * Give a saved song a file — the second, optional half of having it.
   *
   * Works from any surface, because the entry is all it needs. A song saved
   * from YouTube already carries its `yt:` key and goes straight to the queue;
   * one saved from a Deezer or MusicBrainz row carries no source at all, so it
   * is resolved first through the same permanently-cached matcher the catalog
   * uses. Nothing about the entry changes either way: when the download lands,
   * it simply starts resolving to the library track.
   */
  async downloadSaved(entry: SavedEntry, source = 'library'): Promise<void> {
    const preview = (videoId: string): Track => ({
      id: videoId,
      title: entry.title ?? '',
      artist: entry.artist ?? '',
      album: entry.album,
      duration: entry.duration,
      cover: entry.thumbnail,
      source: 'preview',
    });

    const known = savedVideoId(entry);
    if (known) {
      await actions.downloadTrack(preview(known), source);
      return;
    }
    if (!entry.title || !entry.artist) {
      toast.error(tr('search.noPreview'));
      return;
    }
    const t = toast.loading(tr('collection.resolving'));
    try {
      const resolved = await api.resolveCatalogItem({
        artist: entry.artist,
        title: entry.title,
        duration: entry.duration,
      });
      if (!resolved.video_id) throw new Error('not-found');
      t.dismiss();
      await actions.downloadTrack(preview(resolved.video_id), source);
    } catch {
      t.update('error', tr('search.noPreview'));
    }
  },

  /** Seed the live queue from the engine (called on connect + when opening the view). */
  async loadDownloads(): Promise<void> {
    try {
      const d = await api.getDownloadQueue();
      setState('downloads', { queue: d.queue ?? [], isProcessing: !!d.is_processing });
    } catch {
      // Engine down or unauthorized — leave whatever we have.
    }
  },

  retryDownload(id: string): void {
    // Path write, so only the retried row's subscribers re-run.
    setState(
      'downloads',
      'queue',
      (item) => item.id === id,
      { status: 'pending', progress_percent: null, error: undefined, error_message: undefined },
    );
    api.retryDownload(id).catch(() => void actions.loadDownloads()); // resync on failure
  },

  removeDownload(id: string): void {
    const prev = state.downloads.queue;
    setState('downloads', 'queue', (q) => q.filter((i) => i.id !== id)); // optimistic
    api.removeDownload(id).catch(() => setState('downloads', 'queue', prev)); // revert
  },

  clearFailedDownloads(): void {
    const prev = state.downloads.queue;
    setState('downloads', 'queue', (q) =>
      q.filter((i) => i.status !== 'failed' && i.status !== 'interrupted'),
    );
    api.clearFailedDownloads().catch(() => setState('downloads', 'queue', prev));
  },

  clearDownloads(): void {
    const prev = state.downloads.queue;
    setState('downloads', 'queue', (q) => q.filter((i) => i.status === 'downloading'));
    api.clearDownloads().catch(() => setState('downloads', 'queue', prev));
  },

  async rescanLibrary(): Promise<LibraryScanStatus> {
    let status = await api.startLibraryScan();
    while (status.state === 'queued' || status.state === 'scanning') {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      status = await api.getLibraryScan();
    }
    if (status.state === 'failed') {
      throw new Error(status.error || 'Library scan failed');
    }
    await actions.syncLibrary();
    return status;
  },

  // ── Playlists ──
  async createPlaylist(name: string): Promise<boolean> {
    const clean = name.trim();
    if (!clean) return false;
    if (state.playlists[clean]) {
      toast.error(tr('toast.playlistExists'));
      return false;
    }
    try {
      applyPlaylistMutation(await api.createPlaylist(clean));
      toast.success(tr('toast.playlistCreated'));
      return true;
    } catch {
      toast.error(tr('toast.playlistCreateFailed'));
      return false;
    }
  },

  async deletePlaylist(name: string): Promise<void> {
    try {
      applyPlaylistMutation(await api.deletePlaylist(name));
      toast.success(tr('toast.playlistDeleted'));
    } catch {
      toast.error(tr('toast.playlistDeleteFailed'));
    }
  },

  async renamePlaylist(name: string, newName: string): Promise<boolean> {
    const clean = newName.trim();
    if (!clean || clean === name) return false;
    try {
      applyPlaylistMutation(await api.renamePlaylist(name, clean));
      toast.success(tr('toast.playlistRenamed'));
      return true;
    } catch {
      toast.error(tr('toast.playlistRenameFailed'));
      return false;
    }
  },

  async duplicatePlaylist(name: string): Promise<void> {
    const ids = state.playlists[name] ?? [];
    let copy = `${name}${tr('toast.playlistDuplicateSuffix')}`;
    let n = 2;
    while (state.playlists[copy]) copy = `${name}${tr('toast.playlistDuplicateSuffixN', { n: n++ })}`;
    try {
      await api.createPlaylist(copy);
      applyPlaylistMutation(await api.setPlaylistTracks(copy, ids));
      toast.success(tr('toast.playlistDuplicated'));
    } catch {
      toast.error(tr('toast.playlistDuplicateFailed'));
    }
  },

  async addToPlaylist(name: string, track: Track): Promise<void> {
    if ((state.playlists[name] ?? []).includes(track.id)) {
      toast.info(tr('toast.alreadyInPlaylist'));
      return;
    }
    try {
      applyPlaylistMutation(await api.addTrackToPlaylist(name, track.id));
      // A playlist membership is a durable claim on the song, same as a
      // favourite — a track played from Auto Mode/DJ or a search result has
      // no other way to stay resolvable once the session that played it ends.
      if (!isSavedKeys(trackKeys(track))) actions.toggleSaved(savedFromTrack(track));
      void api.emitDiscoveryEvent('music_added_to_playlist', {
        media_type: 'music_track',
        track_id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        youtube_id: track.youtube_id,
        playlist_name: name,
        source: track.source === 'preview' ? 'preview' : 'library',
      }).catch(() => {});
      toast.success(tr('toast.addedToPlaylist', { name }));
    } catch {
      toast.error(tr('toast.addToPlaylistFailed'));
    }
  },

  async removeFromPlaylist(name: string, trackId: string): Promise<void> {
    try {
      applyPlaylistMutation(await api.removeTrackFromPlaylist(name, trackId));
      toast.success(tr('toast.removedFromPlaylist'));
    } catch {
      toast.error(tr('toast.removeFromPlaylistFailed'));
    }
  },

  async reorderPlaylists(order: string[]): Promise<void> {
    const prev = state.playlists;
    try {
      applyPlaylistMutation(await api.reorderPlaylists(order));
    } catch {
      setState('playlists', prev);
      toast.error(tr('toast.reorderFailed'));
    }
  },

  async setPlaylistCover(name: string, coverTrackId: string | null): Promise<void> {
    try {
      applyPlaylistMutation(await api.setPlaylistCover(name, coverTrackId));
      toast.success(tr('toast.playlistCoverUpdated'));
    } catch {
      toast.error(tr('toast.playlistCoverFailed'));
    }
  },

  setDeviceName(name: string): void {
    setState('device', 'device_name', name);
    localStorage.setItem('device_name', name);
  },

  setTheme(theme: Theme): void {
    setState('theme', theme);
    localStorage.setItem('theme', theme);
    applyTheme(theme, true);
  },

  setInterfaceSize(interfaceSize: InterfaceSize): void {
    setState('interfaceSize', interfaceSize);
    persistInterfaceSize(interfaceSize);
    applyVisualPreferences({ interfaceSize, highContrast: state.highContrast });
  },

  setHighContrast(highContrast: boolean): void {
    setState('highContrast', highContrast);
    persistHighContrast(highContrast);
    applyVisualPreferences({ interfaceSize: state.interfaceSize, highContrast });
  },

  setHaptics(on: boolean): void {
    setState('haptics', on);
    localStorage.setItem('haptics', on ? 'on' : 'off');
  },

  // ── Cross-device resume ──
  /** On boot: if a device has recent playback and we're idle, offer to resume it. */
  async checkResume(): Promise<void> {
    if (state.playback.currentTrack || userPlaybackStartedThisSession) return;
    let remote: RemotePlaybackState | undefined;
    try {
      remote = await api.getPlaybackState(state.device.device_id);
    } catch {
      return;
    }
    if (!remote || !remote.track_id || state.playback.currentTrack || userPlaybackStartedThisSession) return;
    const updatedAt = Number(remote.updated_at) || 0;
    if (updatedAt && Date.now() / 1000 - updatedAt > 24 * 3600) return; // stale (>24h)
    if (remote.device_id === state.device.device_id) {
      sessionController.restoreSameDevicePlayback(remote);
      return;
    }
    // Honour the 30-min "No" cooldown unless the other device has played since.
    const now = Date.now();
    const suppressUntil = Number(localStorage.getItem('resume_suppress_until')) || 0;
    const cooldownAt = Number(localStorage.getItem('resume_cooldown_at')) || 0;
    if (now < suppressUntil && updatedAt * 1000 <= cooldownAt) return;
    setResumeState(remote);
  },
  /**
   * Accept the resume offer: carry on here, from the same place in the same
   * session — the queue, the mode, and the whole workspace when Auto was the
   * one driving. Only a state published without a session, by a build that had
   * none to publish, falls back to the single song it named.
   */
  resumeHere(): void {
    const r = resumeState();
    setResumeState(null);
    if (!r?.track_id) return;
    const track = state.library.find((t) => t.id === r.track_id) ?? r.track ?? null;
    if (!track) return;
    userPlaybackStartedThisSession = true;
    const pos = Math.max(0, Number(r.position_sec) || 0);
    const session = sessionController.sessionFor(r);
    if (session && sessionController.playRestoredSession(session, pos)) return;
    actions.playTrack(track);
    if (pos > 0) storeLifetime.timeout(() => actions.seek(pos), 400);
  },
  /**
   * Publish this session now, because it is about to be somebody else's.
   *
   * Called on the way out of a deliberate handoff — following the secure
   * station's address is one — so the arriving page has something to find at
   * the moment it starts looking, instead of whatever the last position ping
   * happened to leave behind up to fifteen seconds ago.
   */
  publishSession(): void {
    if (!state.playback.currentTrack) return;
    sessionController.pushPlaybackState({ keepalive: true, body: sessionController.playbackStateBody({ position_sec: sessionController.livePosition() }) });
  },
  /** Decline the resume offer and suppress it for 30 minutes. */
  dismissResume(): void {
    setResumeState(null);
    const now = Date.now();
    localStorage.setItem('resume_suppress_until', String(now + 30 * 60 * 1000));
    localStorage.setItem('resume_cooldown_at', String(now));
  },
};

/** Gap between boot-time asks for a session to pick up. */
const RESUME_SEARCH_INTERVAL_MS = 2000;
/** Asks an ordinary boot makes: enough to cover a device that published a
 * moment after this one started asking. */
const RESUME_SEARCH_ATTEMPTS = 3;
/** Asks a boot that arrived carrying a handoff makes. The page being left
 * publishes its session as it unloads and the page arriving asks for it as it
 * boots — the same instant, in two browsing contexts that cannot see each
 * other. Keeping the question open is what turns that race into a wait. */
const RESUME_HANDOFF_ATTEMPTS = 10;

/**
 * Look for a session to pick up, and keep looking for a little while.
 *
 * Stops at the first answer: a same-device session restores itself, and a
 * session from elsewhere raises the banner. Either way there is nothing left to
 * ask about — and neither is worth asking about once the listener has started
 * playing something themselves.
 */
async function searchForResume(attempts: number): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RESUME_SEARCH_INTERVAL_MS));
    }
    if (state.playback.currentTrack || userPlaybackStartedThisSession || resumeState()) return;
    await actions.checkResume();
  }
}

let generatedActivityId = 0;

function planItemTrack(item: ListeningPlanItem): Track {
  const local = item.track_id
    ? state.library.find((track) => track.id === item.track_id)
    : null;
  const base: Track = local
    ? { ...local }
    : {
        id: item.youtube_id || item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        duration: item.duration,
        cover: item.cover,
        source: 'preview',
      };
  return {
    ...base,
    youtube_id: item.youtube_id ?? base.youtube_id,
    discovery_youtube_id: item.discovery_youtube_id,
    playback_source_kind: item.playback_source_kind,
    canonical_identity: item.canonical_identity,
    recommendation: {
      identity: item.recommendation_identity,
      source: item.recommendation_source,
      reason: item.recommendation_source === 'autoplay' ? tr('autoplay.reason') : item.reason,
      reason_code: item.reason_code,
      discovery_youtube_id: item.discovery_youtube_id ?? undefined,
    },
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
      index: state.playback.index,
    }),
    identity: queueIdentity,
    isCommitted: (entry) => dj.committedTransition?.queueId === entry.queueId,
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
        duration: seed.duration,
      };
      if (intent === 'auto_mode' && typeof api.planDjQueue === 'function') {
        return api.planDjQueue({
          dj_profile: state.autoMode.djProfile,
          direction: state.autoMode.direction,
          session_id: generatedSession?.id,
          segment_index: generatedSession?.segmentIndex,
          context: state.autoMode.heard.slice(-8).map(dj.djItemRef),
          seed: seedBody,
          sources: state.autoMode.sources.map(({ id, label, tracks, activation }) => ({ id, label, tracks, activation })),
          heard: state.autoMode.heard,
          exclude: [...new Set([...exclude, ...state.autoMode.avoidedIdentities])],
          limit,
        }, signal);
      }
      return api.planMusicQueue({ intent, profile, seed: seedBody, exclude, limit }, signal);
    },
    applyPlan: (intent, response, replace, anchor) => {
      // What a replacing plan keeps: everything already played, every explicit
      // request, and the one handoff that is already loaded and cued.
      const previousUpcoming = replace
        ? futureEntries(state.playback.queue, state.playback.index)
        : [];
      const held = replace
        ? previousUpcoming.filter((entry) => (
            entry.queueLane === 'manual'
            || entry.autoRoute?.kind === 'user'
            || dj.committedTransition?.queueId === entry.queueId
          ))
        : [];
      const retained = replace
        ? [...state.playback.queue.slice(0, state.playback.index + 1), ...held]
        : state.playback.queue;
      const candidates = response.items
        .map((item) => ({ item, track: planItemTrack(item) }))
        .filter(({ track }) => queueIndexOf(retained, track) === -1);
      if (candidates.length === 0) return 0;
      const entries = candidates.map(({ track }) => ({
        ...createQueueEntry(track, 'generated', intent),
        autoRoute: intent === 'auto_mode' ? { kind: 'generated' as const } : undefined,
      }));
      if (replace) {
        let generatedIndex = 0;
        const runway = previousUpcoming.map((entry) => {
          const preserved = entry.queueLane === 'manual'
            || entry.autoRoute?.kind === 'user'
            || dj.committedTransition?.queueId === entry.queueId;
          return preserved ? entry : entries[generatedIndex++];
        }).filter((entry): entry is PlaybackQueueEntry => Boolean(entry));
        runway.push(...entries.slice(generatedIndex));
        setState('playback', 'queue', [
          ...state.playback.queue.slice(0, state.playback.index + 1),
          ...runway,
        ]);
      } else {
        setState('playback', 'queue', (queue) => [...queue, ...entries]);
      }
      if (intent === 'auto_mode') {
        const plan: Record<string, AutoPlanItem> = replace ? {} : { ...state.autoMode.plan };
        // The server chains a route: item N's transition is planned out of item
        // N-1, starting at the anchor. Walk the response in order so each entry
        // records which track its cue belongs to. An item dropped as a duplicate
        // breaks the chain, and the entry behind it loses a transition it can no
        // longer honour — a plain fade, rather than a cue from the wrong song.
        let previousKey = queueIdentity(anchor);
        let chained = true;
        const accepted = new Map(candidates.map(({ item }, index) => [item, entries[index]] as const));
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
            reasonValues: item.source_pool === 'related'
              ? { title: state.playback.currentTrack?.title ?? '' }
              : undefined,
            fromKey: previousKey,
            transition: chained ? item.transition : undefined,
            bpm: item.analysis?.bpm,
            key: item.analysis?.key,
            sourceSetId: item.source_set_id,
            sourceSetLabel: item.source_set_label,
            lineage: item.lineage,
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
        setState('autoMode', 'staleSeams', (seams) => {
          if (!replace) return seams;
          const live = new Set(state.playback.queue.map((entry) => entry.queueId));
          return seams.filter((id) => live.has(id) && plan[id] === undefined);
        });
      }
      transport.prefetchUpcoming();
      // New runway. If the music ran out waiting for exactly this, start it
      // again — the plan arriving is the event, and nothing else is watching.
      if (entries.length > 0) {
        transport.stageNext();
        dj.resumeFromStarved();
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
        setState('autoMode', { phase: 'idle', pendingDirection: false });
        return;
      }
      if (status === 'planning') {
        setState('autoMode', {
          phase: 'planning',
          activity: {
            id: ++generatedActivityId,
            status: 'working',
            key: replacing ? 'autoMode.agent.redrawing' : 'autoMode.agent.searching',
            values: replacing
              ? { note: dj.replanNote }
              : { title: state.playback.currentTrack?.title ?? '' },
          },
        });
        return;
      }
      const counts = response?.pool_counts ?? { local: 0, related: 0, discovery: 0 };
      const degraded = status === 'degraded';
      setState('autoMode', {
        phase: degraded ? 'degraded' : 'ready',
        activity: {
          id: ++generatedActivityId,
          status: degraded ? 'error' : 'done',
          key: degraded
            ? 'autoMode.agent.retrying'
            : replacing
              ? 'autoMode.agent.steered'
              : 'autoMode.agent.queued',
          values: {
            note: dj.replanNote,
            count: response?.items.length ?? 0,
            tracks: response?.items.slice(0, 2).map((item) => item.title).join(' · ') ?? '',
            related: counts.related,
            node: counts.discovery,
            local: counts.local,
          },
        },
      });
    },
  });
  return generatedQueue;
}

/** Whether the OS/browser currently prefers a dark colour scheme.
 * Universal across desktop and mobile (iOS Safari, Android Chrome, etc.)
 * via the CSS media query `prefers-color-scheme`. Falls back to dark when
 * matchMedia is unavailable. */
export { applyTheme, resolveTheme, systemPrefersDark } from './theme';
import { applyTheme } from './theme';

let socket: AppSocket | null = null;
let storeLifetime = new Lifetime();
let _warmTimer: ReturnType<typeof setTimeout> | null = null;
const listeningLearning = new ListeningLearning((event, payload) => {
  void api.emitDiscoveryEvent(event, payload).catch(() => {});
});

/** Single source of truth bootstrap: wires audio + engine events, Media Session,
 * and pulls the initial library. */
/** `standalone` for an installed PWA, `browser` for a tab. */
function displayMode(): string {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'unknown';
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
    ? 'standalone'
    : 'browser';
}

/**
 * Claim the audio session at the first touch of the session.
 *
 * Not at the tap that opens Auto Mode: by then a deck is already playing, and
 * routing a sounding element into a brand new AudioContext is the exact sequence
 * that left the installed app silent. Here the decks have never played, the
 * gesture is real, and `unlockAudio` can prove the context runs before anything
 * depends on it.
 */
function installAudioUnlock(): void {
  if (typeof window === 'undefined') return;
  const unlock = () => {
    audioService.unlockAudio();
    // Carrying on from an interruption, never starting something nobody asked
    // for: this fires on any tap on the page, so the only thing it may act on is
    // music that was playing until the platform took the audio session away.
    // `needsGesture` is set from exactly that and nothing else.
    if (state.playback.needsGesture && state.playback.currentTrack) {
      setState('playback', 'needsGesture', false);
      void audioService.resume().catch(() => {});
    }
  };
  // Capture, so it runs ahead of the click handler that starts the first track.
  storeLifetime.listen(window, 'pointerdown', unlock, { capture: true });
  storeLifetime.listen(window, 'touchend', unlock, { capture: true });
  storeLifetime.listen(window, 'keydown', unlock, { capture: true });
}

export function initStore(): void {
  if (socket) return;
  storeLifetime = new Lifetime();

  // Read now, spent later. Live clears the marker as soon as it has opened the
  // room it was sent here to open, and that can happen before the library sync
  // this decision waits on has come back.
  const resumeAttempts = liveHandoffPending() ? RESUME_HANDOFF_ATTEMPTS : RESUME_SEARCH_ATTEMPTS;

  installAudioUnlock();
  setProgramOutputReporter((event) => {
    transport.emitPlaybackEvent(
      'ui_program_output',
      {
        carrier_playing: event.carrierPlaying,
        carrier_paused: event.carrierPaused,
        carrier_ready_state: event.carrierReadyState,
      },
      {
        output_mode: event.mode,
        output_event: event.event,
        failure_reason: event.reason,
        context_state: event.contextState,
        display_mode: displayMode(),
      },
    );
    if (state.playback.currentTrack) {
      const modeChanged = event.event === 'fallback_entered' || event.event === 'fallback_recovered';
      transport.updateMediaSession(state.playback.currentTrack, 'output_change', modeChanged);
    }
  });
  transport.programMediaSession.setReporter((event) => {
    transport.emitPlaybackEvent(
      'ui_media_session_sync',
      {
        metadata_revision: event.revision,
        carrier_playing: event.carrierPlaying,
        source_playing: event.sourcePlaying,
        state_matches: event.expectedState === event.declaredState,
      },
      {
        output_mode: event.outputMode,
        media_session_state: event.declaredState,
        sync_reason: event.reason,
        display_mode: displayMode(),
      },
    );
  });
  setProgramTransportReporter((event) => {
    transport.emitPlaybackEvent(
      event.kind === 'inactive_deck_play' ? 'ui_inactive_deck_play' : 'ui_program_transport',
      {
        active_deck: event.activeIndex,
        dominant: event.dominant,
        hidden: event.hidden,
        deck_0_playing: event.deck0Playing,
        deck_1_playing: event.deck1Playing,
      },
      {
        transport_action: event.kind,
        transport_origin: event.origin,
        mix_phase: event.mixPhase,
        display_mode: displayMode(),
      },
    );
    // A stale element just tried to reclaim the platform session. Publish the
    // canonical programme again after the audio layer has stopped it.
    if (event.kind === 'inactive_deck_play' && state.playback.currentTrack) {
      transport.updateMediaSession(state.playback.currentTrack, 'source_anomaly', true);
    }
  });

  applyVisualPreferences({
    interfaceSize: state.interfaceSize,
    highContrast: state.highContrast,
  });
  applyTheme(state.theme);
  try {
    void api
      .getDiscoverySettings()
      .then((settings) => {
        if (typeof settings.autoplay_enabled === 'boolean') {
          setState('playback', 'autoplayEnabled', settings.autoplay_enabled);
          if (settings.autoplay_enabled) queueMicrotask(() => void transport.ensureAutoplay());
          else transport.discardFutureAutoplay();
        }
        // Reconcile the localStorage mirror the store booted from. A ramp
        // rather than a jump, so a device that disagreed with the account
        // corrects itself without a lurch a second into the session.
        if (typeof settings.volume_leveling === 'boolean'
          && settings.volume_leveling !== state.playback.volumeLeveling) {
          transport.applyVolumeLeveling(settings.volume_leveling);
        }
      })
      .catch(() => {});
  } catch {
    // Test doubles and older engines may not expose this setting yet.
  }

  /** The store consumes one programme, never either implementation deck. */
  const a = { addEventListener: (
    type: ProgramMediaEventName,
    handler: (snapshot: ProgramPlaybackSnapshot, event: Event) => void,
  ) => storeLifetime.add(onProgramEvent(type, handler)) };
  a.addEventListener('play', () => {
    setState('playback', 'isPlaying', true);
    sessionController.pushPlaybackState();
  });
  a.addEventListener('pause', () => {
    transport.clearStallTimer();
    if (state.playback.phase !== 'loading' && state.playback.phase !== 'recovering') {
      setState('playback', { isPlaying: false, isLoading: false, phase: 'paused' });
    }
    transport.updateMediaSession(state.playback.currentTrack, 'paused');
    sessionController.pushPlaybackState();
  });
  a.addEventListener('ended', () => dj.onEnded());
  a.addEventListener('error', (snapshot) => {
    // `stop()` clears src, which some engines report as an error. Nothing is
    // loaded and nothing is expected to be — not a playback failure.
    if (!snapshot.hasSource) return;
    // Restoring this device's last session primes the track while leaving it
    // paused. A stale or temporarily unreachable stream may reject that
    // best-effort preload, but nobody asked Soundsible to play it. Only a real
    // playback attempt is allowed to fail visibly.
    if (!transport.activeAttempt) return;
    transport.onPlaybackFailed(transport.loadGeneration, 'media_error', {
      media_error_code: snapshot.mediaErrorCode,
      network_state: snapshot.networkState,
      ready_state: snapshot.readyState,
    });
  });
  // A seek the listener asked for. Remembered so that the `waiting` it is about
  // to cause is not filed as a stream that died.
  a.addEventListener('seeking', () => {
    if (transport.activeAttempt) transport.activeAttempt.seekPending = true;
  });
  // Buffering, both cold (nothing has sounded yet) and mid-track. Either way the
  // transport shows progress instead of a stuck play button — but only the second
  // one is a delivery failure, and they are counted apart.
  a.addEventListener('waiting', () => {
    if (!state.playback.currentTrack) return;
    const attempt = transport.activeAttempt;
    if (attempt && attempt.bufferStartedAt === null) {
      attempt.bufferStartedAt = performance.now();
      if (attempt.audibleAt !== null) {
        if (attempt.seekPending) attempt.seekRebufferCount += 1;
        else attempt.rebufferCount += 1;
      }
    }
    setState('playback', { isLoading: true, phase: 'buffering' });
    // A wait long enough to notice is a wait worth explaining. The reading is
    // throttled inside, so a track that stalls repeatedly asks once.
    void refreshLinkReading();
    transport.scheduleStallRecovery(attempt?.audibleAt == null ? transport.STARTUP_RECOVERY_MS : transport.STALL_RECOVERY_MS);
  });
  a.addEventListener('canplay', () => {
    // `canplay` can precede actual audio by a noticeable amount; `playing` is
    // the only event that closes the user's click-to-sound attempt.
    const attempt = transport.activeAttempt;
    if (attempt && attempt.canPlayAt === null) attempt.canPlayAt = performance.now();
  });
  // First 'playing' after a user-initiated load → click-to-sound latency.
  a.addEventListener('playing', (snapshot) => {
    transport.clearStallTimer();
    setState('playback', { isLoading: false, loadError: false, phase: 'playing' });
    transport.updateMediaSession(state.playback.currentTrack, 'playing');
    transport.consecutiveLoadFailures = 0;
    transport.flushWhenAudible();
    // Only verified previews can reach this deck, so staging here reads the
    // engine's disk cache instead of competing with the track that just began.
    transport.stageNext();
    const attempt = transport.activeAttempt;
    if (!attempt || state.playback.currentTrack?.id !== attempt.trackId) return;
    const now = performance.now();
    const spell = attempt.bufferStartedAt === null ? 0 : Math.max(0, now - attempt.bufferStartedAt);
    attempt.bufferStartedAt = null;
    if (attempt.audibleAt === null) attempt.startupStallMs += spell;
    else attempt.rebufferMs += spell;
    attempt.seekPending = false;
    if (attempt.audibleAt === null) {
      attempt.audibleAt = now;
      // No stall counters here. At this instant nothing can have stalled yet —
      // the sound has only just started — so any number reported here describes
      // the wait that `click_to_playing_ms` already describes. `ui_play_delivery`
      // asks the stall question at a time when it has an answer.
      transport.emitAttempt(attempt, 'ui_click_to_playing', 'playing', {
        click_to_playing_ms: Math.round(now - attempt.startedAt),
        ...(attempt.loadedMetadataAt === null ? {} : {
          loadedmetadata_ms: Math.round(attempt.loadedMetadataAt - attempt.startedAt),
        }),
        ...(attempt.canPlayAt === null ? {} : {
          canplay_ms: Math.round(attempt.canPlayAt - attempt.startedAt),
        }),
        startup_stall_ms: Math.round(attempt.startupStallMs),
        recovery_count: attempt.recoveryCount,
        ready_state: snapshot.readyState,
        network_state: snapshot.networkState,
        buffered_ahead_ms: Math.max(0, Math.round((snapshot.bufferedEnd - snapshot.position) * 1000)),
      });
    } else if (attempt.recoveryCount > attempt.reportedRecoveryCount) {
      transport.emitAttempt(attempt, 'ui_recovery_succeeded', 'playing', {
        rebuffer_count: attempt.rebufferCount,
        rebuffer_ms: Math.round(attempt.rebufferMs),
        recovery_count: attempt.recoveryCount,
      });
      attempt.reportedRecoveryCount = attempt.recoveryCount;
    }
  });
  a.addEventListener('timeupdate', (snapshot) => {
    const position = snapshot.position;
    setState('playback', 'currentTime', position);
    listeningLearning.update(state.playback.currentTrack, position, snapshot.playing);
    dj.evaluateDjRunway();
    dj.watchRunway(snapshot);
  });
  const setDur = (snapshot: ProgramPlaybackSnapshot) => {
    setState('playback', 'duration', snapshot.duration);
    transport.updatePositionState();
  };
  a.addEventListener('durationchange', setDur);
  a.addEventListener('loadedmetadata', (snapshot) => {
    const attempt = transport.activeAttempt;
    if (attempt && attempt.loadedMetadataAt === null) attempt.loadedMetadataAt = performance.now();
    setDur(snapshot);
  });
  // A seek from anywhere — our transport, the lock screen, a car button — has
  // to re-anchor the OS scrubber or it keeps counting from the old position.
  a.addEventListener('seeked', () => transport.updatePositionState());
  a.addEventListener('ratechange', () => transport.updatePositionState());
  let hiddenSince: number | null = null;
  storeLifetime.listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      return;
    }
    // Coming back from a freeze. The store's clock stopped where the page did,
    // so anything derived from it — the scrubber, the OS position, the DJ
    // runway — has been reading a position the music left behind long ago.
    const snapshot = audioService.snapshot();
    const position = snapshot.position;
    const drift = Math.abs(position - (state.playback.currentTime || 0));
    if (state.playback.currentTrack) {
      setState('playback', {
        currentTime: position,
        duration: snapshot.duration > 0 ? snapshot.duration : state.playback.duration,
        isPlaying: snapshot.playing,
      });
      // The element is the authority after a spell asleep, and the OS card may
      // have been reading a state nobody corrected while the page was frozen.
      transport.updateMediaSession(state.playback.currentTrack, 'visibility_resume', true);
      if (hiddenSince !== null && drift > 1) {
        transport.emitPlaybackEvent('ui_visibility_resume', {
          hidden_sec: Math.round((Date.now() - hiddenSince) / 1000),
          drift_sec: Math.round(drift),
        });
      }
    }
    hiddenSince = null;
    // A context can come back from the background suspended, and a `resume()`
    // attempted while we were away has no gesture behind it to succeed with.
    // Only ever a resume: building the graph outside a gesture is the one
    // sequence WebKit punishes, so a page that never had one waits for a tap.
    if (audioService.graphReady()) audioService.unlockAudio();
    // Whatever stopped while we were away gets one more chance now.
    dj.resumeFromStarved();
    if (state.playback.phase === 'buffering') {
      const attempt = transport.activeAttempt;
      transport.scheduleStallRecovery(attempt?.audibleAt == null ? transport.STARTUP_RECOVERY_MS : transport.STALL_RECOVERY_MS);
    }
  });
  // Page Lifecycle's counterpart to the above, fired on the document: iOS can
  // freeze a backgrounded page outright, and a page that is thawed rather than
  // merely revealed does not always get a `visibilitychange` of its own.
  storeLifetime.listen(document, 'resume', () => {
    if (audioService.graphReady()) audioService.unlockAudio();
    dj.resumeFromStarved();
  });

  transport.programMediaSession.installActions({
    play: () => actions.resumePlayback('media_session'),
    pause: () => actions.pausePlayback('media_session'),
    next: () => {
      if (state.autoMode.active) void actions.autoSkip();
      else actions.next();
    },
    previous: () => actions.prev(),
    seekTo: (position) => actions.seek(position),
    seekBackward: (offset) =>
      actions.seek(Math.max(0, state.playback.currentTime - (offset ?? transport.osSeekStep('backward')))),
    seekForward: (offset) =>
      actions.seek(state.playback.currentTime + (offset ?? transport.osSeekStep('forward'))),
  });

  socket = createSocket();
  socket.on('connect', () => {
    setState('online', true);
    socket!.emit('playback_register', state.device);
    void api.registerDevice(state.device).catch(() => {});
    void actions.loadDownloads(); // re-seed the queue after a (re)connect
    invalidateLibrarySync(); // recover library and loudness events missed offline
    void actions.syncLibrary();
    // The station is reachable again: if the music ran out while it was not,
    // this is the moment that ends the silence.
    dj.resumeFromStarved();
  });
  socket.on('disconnect', () => setState('online', false));
  // A sweep measured more of the library. Nothing re-levels mid-song; the new
  // numbers ride the refreshed library and apply from the next track on.
  socket.on('loudness_updated', () => {
    invalidateLibrarySync();
    // New numbers landed, so what was asked for before is now answerable from
    // the library. Anything still missing after the resync is worth asking again.
    transport.loudnessAsked.clear();
    actions.syncLibrarySoon();
  });

  socket.on('library_updated', (payload?: { cover_changed?: boolean }) => {
    // Cover edits on another device only reach this tab through this event —
    // bust the local cache-buster so the new art is fetched instead of the
    // long-lived cached image. Gated on the flag so unrelated library changes
    // (scans, renames, deletes) don't force every visible cover to refetch.
    if (payload?.cover_changed) bustCovers();
    // Shares the coalescing window with download completions, which arrive for
    // the same writes moments earlier.
    actions.syncLibrarySoon();
    // Note: Debounced discover cache warming — when the library changes (new
    // saves, favourites, deletes) the top seeds may shift, so re-warm the
    // persistent related-mix cache in the background. The server picks its own
    // top seeds; this is fire-and-forget.
    if (_warmTimer) storeLifetime.clearTimeout(_warmTimer);
    _warmTimer = storeLifetime.timeout(() => { void api.warmDiscoverSeeds([]).catch(() => {}); }, 4000);
  });
  // The collection changes without the library changing — a song saved or
  // hearted on another device, or a catalog row that just finished resolving to
  // a playable video.
  socket.on('favourites_updated', () => {
    void api.getSaved()
      .then((saved) => setState('saved', saved))
      .catch(() => {});
  });
  socket.on('downloader_update', (data) => applyDownloadEvent((data ?? {}) as DownloadEvent));
  socket.on('discover_seed_ready', (data) => dispatchDiscoverSeed(data as { request_id: string; seed_track_id: string; recs: unknown[] }));

  // ── Remote control: this device acts on commands from another device. ──
  socket.on('playback_stop_requested', () => {
    if (state.playback.isPlaying) audioService.pause();
  });
  socket.on('playback_start_requested', (data) => {
    const trk = data?.track;
    // A handoff from another device carries that device's whole session, so
    // this one continues it rather than starting the same song over on its own.
    const handedOver = trk && typeof trk.id === 'string'
      ? sessionController.sessionFor({ ...(data?.state ?? {}), track_id: trk.id })
      : null;
    const handoffPosition = Number(data?.state?.position_sec);
    if (handedOver && sessionController.playRestoredSession(
      handedOver,
      Number.isFinite(handoffPosition) ? Math.max(0, handoffPosition) : 0,
    )) {
      return;
    }
    if (trk && typeof trk.id === 'string') {
      const t: Track = {
        id: trk.id,
        title: typeof trk.title === 'string' ? trk.title : '',
        artist: typeof trk.artist === 'string' ? trk.artist : '',
        album: typeof trk.album === 'string' ? trk.album : undefined,
        duration: typeof trk.duration === 'number' ? trk.duration : undefined,
        youtube_id: typeof trk.youtube_id === 'string' ? trk.youtube_id : undefined,
        media_kind: typeof trk.media_kind === 'string' ? trk.media_kind : undefined,
      };
      actions.playTrack(t);
      const pos = Number(data?.state?.position_sec);
      if (Number.isFinite(pos) && pos > 0) storeLifetime.timeout(() => actions.seek(pos), 400);
    } else if (state.playback.currentTrack) {
      void audioService.resume().catch(() => {});
    }
  });
  socket.on('playback_next_requested', () => {
    if (state.autoMode.active) void actions.autoSkip();
    else actions.next();
  });
  socket.on('playback_previous_requested', () => actions.prev());
  socket.on('playback_seek_requested', (data) => {
    const p = Number(data?.position_sec);
    if (Number.isFinite(p)) actions.seek(p);
  });

  // Keep the published position fresh so other devices resume near where we are
  // — and the session with it, including while paused: a route reordered or a
  // source added during a break is part of what a handoff hands over.
  storeLifetime.interval(() => {
    if (!state.playback.currentTrack) return;
    if (state.playback.isPlaying || sessionController.sessionOutOfDate()) sessionController.pushPlaybackState();
  }, 15000);

  const pushStateOnUnload = () => {
    if (!state.playback.currentTrack) return;
    sessionController.pushPlaybackState({
      keepalive: true,
      body: sessionController.playbackStateBody({ position_sec: sessionController.livePosition(), is_playing: false }),
    });
  };
  storeLifetime.listen(window, 'beforeunload', pushStateOnUnload);
  storeLifetime.listen(window, 'pagehide', pushStateOnUnload);

  void actions.syncLibrary().then(() => searchForResume(resumeAttempts));
  void actions.loadDownloads();
  // Warm the discovery feed so Search and Podcasts render cached rails instantly.
  void import('../lib/discover').then((m) => m.ensureDiscover());

  // Global keyboard shortcuts (desktop). The decision table lives in
  // lib/shortcuts so it can be tested without a DOM; the store only supplies
  // the context snapshot and the callbacks.
  if (typeof window !== 'undefined') {
    storeLifetime.listen(
      window, 'keydown',
      createShortcutHandler(
        () => ({
          autoModeActive: state.autoMode.active,
          nowPlayingOpen: nowPlayingOpen(),
          autoModeAvailable:
            !state.playback.currentTrack || !isPodcastTrack(state.playback.currentTrack),
        }),
        {
          togglePlay: () => actions.togglePlay(),
          // Auto Mode owns the queue: skipping has to go through the generated
          // session coordinator
          // so it can pick a replacement, not walk a queue it is rewriting.
          next: () => {
            if (state.autoMode.active) void actions.autoSkip();
            else actions.next();
          },
          prev: () => actions.prev(),
          seekBy: (delta) => actions.seek(Math.max(0, state.playback.currentTime + delta)),
          // `setVolume` clamps, and already lifts mute when the level goes
          // above zero — turning it up is a request to hear something.
          nudgeVolume: (delta) => actions.setVolume(nudgeVolumeGain(state.playback.volume, delta)),
          toggleMute: () => actions.toggleMute(),
          toggleShuffle: () => actions.toggleShuffle(),
          cycleRepeat: () => actions.cycleRepeat(),
          toggleFavourite: () => {
            const track = state.playback.currentTrack;
            // Whatever is playing can be saved — owning the file is not a
            // precondition, only being a song is (podcasts have their own shelf).
            if (track && !isPodcastTrack(track)) actions.toggleFavouriteTrack(track);
          },
          enterAutoMode: () => actions.enterAutoMode(),
          exitAutoMode: () => actions.exitAutoMode(),
          closeNowPlaying: () => setNowPlayingOpen(false),
        },
      ),
    );
  }
}

/** End the session before another account or root owns the same audio service. */
export function disposeStore(): void {
  storeLifetime.dispose();
  disposeLibrarySync();
  autoSessionEpoch += 1;
  autoOpeningAborter?.abort();
  generatedQueue?.stop();
  generatedQueue = null;
  transport.dispose();
  sessionController.dispose();
  dj.dispose();
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  setProgramOutputReporter(null);
  setProgramTransportReporter(null);
  audioService.stop();
  setState('online', false);
  userPlaybackStartedThisSession = false;
  transport = createTransport(playbackHost);
  sessionController = createSession(playbackHost);
  dj = createDj(playbackHost);
}
