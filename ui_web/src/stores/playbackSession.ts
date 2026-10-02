import { Lifetime } from '../lib/lifetime';

import { api, type RemotePlaybackState } from '../lib/api';
import { audioService } from '../lib/audio';
import { type MediaSessionSyncReason } from '../lib/mediaSession';

import { isPodcastTrack } from '../lib/track';

import { GeneratedQueueController } from '../lib/generatedQueue';

import { createQueueEntry, futureEntries, type PlaybackQueueEntry } from '../lib/playbackQueue';
import { buildPlaybackSession, readPlaybackSession, type PlaybackSessionSnapshot } from '../lib/playbackSession';

import type { Track } from '../types/music';

import { state, setState, type PlaybackState, type RepeatMode } from './core';

import type { PlaybackTrigger } from './playbackTransport';

export interface SessionHost {
  cancelActiveAttempt: (reason?: string) => void;
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  actions: {
    exitAutoMode: () => void;
    seek: (t: number) => void;
  };
  generatedQueue: GeneratedQueueController | null;
  stagedEntry: { queueId: string; attemptId: string; url: string } | null;
  autoSessionEpoch: number;
  autoPlaybackPrefs: { shuffle: boolean; repeat: RepeatMode } | null;
  userPlaybackStartedThisSession: boolean;
  ensureGeneratedQueue: () => GeneratedQueueController;
  loadIndex: (i: number, opts?: { restart?: boolean; trigger?: PlaybackTrigger; freshDeck?: boolean }) => void;
  trackUrl: (track: Track) => string;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
}

export function createSession(host: SessionHost) {
  const lifetime = new Lifetime();
  function sessionSnapshot(): PlaybackSessionSnapshot | null {
    const pb = state.playback;
    return buildPlaybackSession({
      queue: pb.queue,
      index: pb.index,
      shuffle: pb.shuffle,
      repeat: pb.repeat,
      radioMode: pb.radioMode,
      radioSeedId: pb.radioSeedId,
      auto: state.autoMode,
    });
  }

  /**
   * The session as the engine last accepted it, serialized.
   *
   * Position is published every fifteen seconds and on every transport event; the
   * queue and the workspace behind it change far more rarely. Comparing against
   * what was actually stored is what keeps a fifty-entry route out of a ping that
   * only had a new position to report.
   */
  let publishedSession: string | null = null;

  /** Whether this device holds a session the engine has not been told about. */
  function sessionOutOfDate(): boolean {
    return JSON.stringify(sessionSnapshot() ?? null) !== publishedSession;
  }

  function playbackStateBody(
    override: Partial<{
      track: Track | null;
      position_sec: number;
      is_playing: boolean;
    }> = {},
  ): Parameters<typeof api.putPlaybackState>[0] {
    const pb = state.playback;
    const track = override.track !== undefined ? override.track : pb.currentTrack;
    // No track is the end of a session, not a session nobody described: clearing
    // it explicitly is what stops another device offering to resume music this
    // one has already stopped playing.
    const session = track ? sessionSnapshot() : null;
    const serialized = JSON.stringify(session ?? null);
    return {
      track_id: track?.id ?? null,
      track: track ?? null,
      position_sec: override.position_sec ?? pb.currentTime ?? 0,
      is_playing: override.is_playing ?? pb.isPlaying,
      device_id: state.device.device_id,
      device_name: state.device.device_name,
      device_type: state.device.device_type,
      ...(serialized === publishedSession ? {} : { session }),
    };
  }

  /** Where the music actually is. The store's clock stops with the page; the
   * element's does not, and a state published as the page leaves has to say where
   * the listener was, not where the last frame left them. */
  function livePosition(): number {
    const live = audioService.snapshot().position;
    return Number.isFinite(live) ? live : state.playback.currentTime || 0;
  }

  /**
   * What a `keepalive` request may weigh.
   *
   * The platform limit is 64 KB across all in-flight keepalive requests, and over
   * it the fetch is rejected outright — so a session big enough to need the
   * guarantee is exactly the one that would lose the position report with it.
   * Past the budget the request is sent as an ordinary one instead: it goes out
   * immediately and usually lands, rather than being refused for certain.
   */
  const KEEPALIVE_BUDGET_BYTES = 56 * 1024;

  /** Publish this device's current playback to the engine so other devices can
   * offer to resume it. Best-effort: fire-and-forget, errors swallowed. */
  function pushPlaybackState(opts: { keepalive?: boolean; body?: ReturnType<typeof playbackStateBody> } = {}): void {
    const body = opts.body ?? playbackStateBody();
    const sent = 'session' in body ? JSON.stringify(body.session ?? null) : null;
    const keepalive = opts.keepalive && JSON.stringify(body).length <= KEEPALIVE_BUDGET_BYTES;
    void api.putPlaybackState(body, { keepalive })
      // Only once it is stored. A session dropped by a failed request has to ride
      // the next ping, or the device that picks this one up gets the song without
      // anything that was around it.
      .then(() => {
        if (!lifetime.disposed && sent !== null) publishedSession = sent;
      })
      .catch(() => {});
  }

  function pushEmptyPlaybackState(opts: { keepalive?: boolean } = {}): void {
    pushPlaybackState({ keepalive: opts.keepalive, body: playbackStateBody({ track: null, position_sec: 0, is_playing: false }) });
  }

  function removeTrackReferences(id: string): void {
    setState('library', (l) => l.filter((t) => t.id !== id));
    // Favourites are deliberately left alone: deleting the file is not
    // unfavouriting the song. The entry stops resolving to a library track and
    // degrades to a preview on its own — and re-downloading the same audio mints
    // the same content hash, so it silently becomes local again.
    setState(
      'playlists',
      Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.filter((x) => x !== id)])),
    );

    const pb = state.playback;
    const nextQueue = pb.queue.filter((t) => t.id !== id);
    if (nextQueue.length !== pb.queue.length) {
      const nextIndex = pb.currentTrack ? nextQueue.findIndex((t) => t.id === pb.currentTrack?.id) : -1;
      setState('playback', { queue: nextQueue, index: nextIndex });
    }

    if (pb.currentTrack?.id === id) {
      host.cancelActiveAttempt('track_removed');
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
        index: -1,
      });
      host.updateMediaSession(null);
      pushEmptyPlaybackState();
    }
  }

  function restorePlaybackSnapshot(snapshot: PlaybackState): void {
    setState('playback', {
      ...snapshot,
      queue: snapshot.queue.slice(),
    });
    host.updateMediaSession(snapshot.currentTrack);
  }

  /** A restored occurrence, told against the library this device actually has:
   * the song may have been downloaded since it was queued somewhere else. */
  function hydrateSessionEntry(entry: PlaybackQueueEntry): PlaybackQueueEntry {
    const owned = state.library.find((track) => track.id === entry.id);
    if (!owned) return entry;
    const { queueId, queueLane, queueSource, queueContext, queueContextIndex, autoRoute } = entry;
    return { ...owned, queueId, queueLane, queueSource, queueContext, queueContextIndex, autoRoute };
  }

  /**
   * Rebuild a session — one another device published, or this device's own from
   * before a reload.
   *
   * Everything the session was made of travels together: the queue and the place
   * in it, the transport preferences that belong to the session rather than to
   * the device, and, when Auto was driving, its sources, direction, route plan
   * and what it had already heard. Restoring used to mean a queue of one song,
   * which handed an Auto session back as an ordinary Now Playing one.
   *
   * Leaves the transport paused and the decks untouched. Whether this is a resume
   * the listener asked for out loud or a session quietly put back where they left
   * it is the caller's to decide.
   */
  function applySessionSnapshot(
    snapshot: PlaybackSessionSnapshot,
    position: number,
  ): PlaybackQueueEntry | null {
    const queue = snapshot.queue.map(hydrateSessionEntry);
    const index = Math.min(Math.max(snapshot.index, 0), queue.length - 1);
    const entry = queue[index];
    if (!entry) return null;

    host.cancelActiveAttempt('session_restored');
    // Auto's own teardown rewrites the queue, so it has to run before the
    // restored one is written rather than over the top of it.
    if (state.autoMode.active) host.actions.exitAutoMode();
    host.generatedQueue?.stop();
    host.stagedEntry = null;
    audioService.clearStaged();

    setState('playback', {
      currentTrack: entry,
      queue,
      index,
      isPlaying: false,
      isLoading: false,
      loadError: false,
      needsGesture: false,
      phase: 'paused',
      currentTime: position,
      duration: entry.duration ?? 0,
      shuffle: snapshot.shuffle,
      repeat: snapshot.repeat,
      radioMode: snapshot.radio.active,
      radioLoading: false,
      radioSeedId: snapshot.radio.seedId,
    });

    const auto = snapshot.auto;
    if (auto) {
      host.autoSessionEpoch += 1;
      host.autoPlaybackPrefs = null;
      setState('autoMode', {
        active: true,
        profile: auto.profile,
        djProfile: auto.djProfile,
        direction: auto.direction,
        sources: auto.sources,
        heard: auto.heard,
        avoidedIdentities: auto.avoidedIdentities,
        plan: auto.plan,
        staleSeams: auto.staleSeams,
        transition: { status: 'idle' },
        pendingDirection: false,
        repairing: false,
        activity: null,
        // The planner is started by whoever presses play. Until then the route
        // that arrived is the runway, and `planning` would promise a request
        // nobody has made yet.
        phase: futureEntries(queue, index, 'generated').length > 0 ? 'ready' : 'idle',
      });
    }
    host.updateMediaSession(entry);
    return entry;
  }

  /** The session behind a published state, when it describes the same song that
   * state is a position into. Anything else is a state from a build that did not
   * publish sessions, or one that has moved on since. */
  function sessionFor(remote: RemotePlaybackState): PlaybackSessionSnapshot | null {
    const session = readPlaybackSession(remote.session);
    return session && session.queue[session.index]?.id === remote.track_id ? session : null;
  }

  /** Restore a session and carry on playing it from where it was left. */
  function playRestoredSession(session: PlaybackSessionSnapshot, position: number): boolean {
    const entry = applySessionSnapshot(session, position);
    if (!entry) return false;
    host.userPlaybackStartedThisSession = true;
    // Before the load, not after: loading an entry asks the live session for more
    // runway in the same tick, and there has to be one to ask.
    if (state.autoMode.active) {
      void host.ensureGeneratedQueue().start('auto_mode', entry, state.autoMode.profile);
    }
    host.loadIndex(state.playback.index, { restart: true, trigger: 'resume' });
    if (position > 0) lifetime.timeout(() => host.actions.seek(position), 400);
    return true;
  }

  function restoreSameDevicePlayback(remote: RemotePlaybackState): void {
    const track = state.library.find((t) => t.id === remote.track_id) ?? remote.track ?? null;
    if (!track) return;
    const pos = Math.max(0, Number(remote.position_sec) || 0);
    const session = sessionFor(remote);
    const restored = session ? applySessionSnapshot(session, pos) : null;
    if (restored) {
      audioService.prime(host.trackUrl(restored), pos, host.levelFor(restored));
      return;
    }
    setState('playback', {
      currentTrack: track,
      isPlaying: false,
      isLoading: false,
      loadError: false,
      phase: 'paused',
      currentTime: pos,
      duration: track.duration ?? 0,
      queue: [createQueueEntry(track, 'context', isPodcastTrack(track) ? 'podcast' : 'single', {
        id: 'resume',
        kind: isPodcastTrack(track) ? 'podcast' : 'single',
        label: track.artist,
      })],
      index: 0,
    });
    host.updateMediaSession(track);
    audioService.prime(host.trackUrl(track), pos, host.levelFor(track));
  }

    return {
      dispose() { lifetime.dispose(); publishedSession = null; },
      pushPlaybackState,
      removeTrackReferences,
      restorePlaybackSnapshot,
      restoreSameDevicePlayback,
      sessionFor,
      playRestoredSession,
      playbackStateBody,
      livePosition,
      sessionOutOfDate
    };
}
