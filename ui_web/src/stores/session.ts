import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { user } from "../lib/session";
import { api, type RemotePlaybackState } from "../lib/api";
import { audioService } from "../lib/audio";
import { ProgramMediaSession, type MediaSessionSyncReason } from "../lib/mediaSession";
import { isPodcastTrack } from "../lib/track";
import { GeneratedQueueController } from "../lib/generatedQueue";
import { createQueueEntry, futureEntries, isPendingEntry, type PlaybackQueueEntry } from "../lib/playbackQueue";
import { buildPlaybackSession, readPlaybackSession, type PlaybackSessionSnapshot } from "../lib/playbackSession";
import type { Track } from "../types/music";
import { state, setState, resumeState, setResumeState, type RepeatMode } from "./core";
import type { PlayerActions, LoadOptions, PublishedPlaybackState } from "./contracts";
export interface SessionPorts {
  releasePreparation: () => void;
  runWhenAudible: (() => void) | null;
  cancelActiveAttempt: (reason?: string) => void;
  unmatchedSelection: {
    queueId: string;
    paused: boolean;
  } | null;
  abandonContextMatches: (keep?: (queueId: string) => boolean) => void;
  actions: Pick<PlayerActions, 'checkResume' | 'exitAutoMode' | 'playTrack' | 'seek'>;
  generatedQueue: GeneratedQueueController | null;
  stagedEntry: {
    queueId: string;
    attemptId: string;
    url: string;
  } | null;
  autoSessionEpoch: number;
  autoPlaybackPrefs: {
    shuffle: boolean;
    repeat: RepeatMode;
  } | null;
  userPlaybackStartedThisSession: boolean;
  ensureGeneratedQueue: () => GeneratedQueueController;
  loadIndex: (i: number, opts?: LoadOptions) => void;
  podcastProgressOwner: string | undefined;
  trackUrl: (track: Track) => string;
  levelFor: (entry: PlaybackQueueEntry | Track | null | undefined) => number;
}

/** Owns session behaviour; cross-domain work enters through explicit ports. */
export function createSession(ports: SessionPorts, lifetime: RuntimeLifetime) {
  const programMediaSession = new ProgramMediaSession();
  function updateMediaSession(track: Track | null, reason: MediaSessionSyncReason = 'track', forceMetadata = false): void {
    programMediaSession.sync(track, audioService.snapshot(), reason, forceMetadata);
  }
  function updatePositionState(reason: MediaSessionSyncReason = 'position'): void {
    updateMediaSession(state.playback.currentTrack, reason);
  }
  function osSeekStep(): number {
    const track = state.playback.currentTrack;
    if (track && isPodcastTrack(track)) return 15;
    return 10;
  }
  function sessionSnapshot(): PlaybackSessionSnapshot | null {
    const pb = state.playback;
    return buildPlaybackSession({
      queue: pb.queue,
      index: pb.index,
      shuffle: pb.shuffle,
      repeat: pb.repeat,
      radioMode: pb.radioMode,
      radioSeedId: pb.radioSeedId,
      auto: state.autoMode
    });
  }
  let publishedSession: string | null = null;
  function sessionOutOfDate(): boolean {
    return JSON.stringify(sessionSnapshot() ?? null) !== publishedSession;
  }
  function playbackStateBody(override: Partial<{
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
  }> = {}): {
    track_id: string | null;
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
    device_id: string;
    device_name: string;
    device_type: string;
    session?: PlaybackSessionSnapshot | null;
  } {
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
      ...(serialized === publishedSession ? {} : {
        session
      })
    };
  }
  function livePosition(): number {
    const live = audioService.snapshot().position;
    return Number.isFinite(live) ? live : state.playback.currentTime || 0;
  }
  const KEEPALIVE_BUDGET_BYTES = 56 * 1024;
  function pushPlaybackState(opts: {
    keepalive?: boolean;
    body?: PublishedPlaybackState;
  } = {}): void {
    const body = opts.body ?? playbackStateBody();
    const sent = 'session' in body ? JSON.stringify(body.session ?? null) : null;
    const keepalive = opts.keepalive && JSON.stringify(body).length <= KEEPALIVE_BUDGET_BYTES;
    void api.putPlaybackState(body, {
      keepalive
    })
    // Only once it is stored. A session dropped by a failed request has to ride
    // the next ping, or the device that picks this one up gets the song without
    // anything that was around it.
    .then(lifetime.guard(() => {
      if (sent !== null) publishedSession = sent;
    })).catch(lifetime.guard(() => {}));
  }
  function pushEmptyPlaybackState(opts: {
    keepalive?: boolean;
  } = {}): void {
    pushPlaybackState({
      keepalive: opts.keepalive,
      body: playbackStateBody({
        track: null,
        position_sec: 0,
        is_playing: false
      })
    });
  }
  function hydrateSessionEntry(entry: PlaybackQueueEntry): PlaybackQueueEntry {
    const owned = state.library.find(track => track.id === entry.id);
    if (!owned) return entry;
    const {
      queueId,
      queueLane,
      queueSource,
      queueContext,
      queueContextIndex,
      autoRoute
    } = entry;
    return {
      ...owned,
      queueId,
      queueLane,
      queueSource,
      queueContext,
      queueContextIndex,
      autoRoute
    };
  }
  function applySessionSnapshot(snapshot: PlaybackSessionSnapshot, position: number): PlaybackQueueEntry | null {
    const queue = snapshot.queue.map(hydrateSessionEntry);
    const index = Math.min(Math.max(snapshot.index, 0), queue.length - 1);
    const entry = queue[index];
    if (!entry) return null;
    ports.releasePreparation();
    ports.runWhenAudible = null;
    ports.cancelActiveAttempt('session_restored');
    ports.unmatchedSelection = null;
    ports.abandonContextMatches();
    // Auto's own teardown rewrites the queue, so it has to run before the
    // restored one is written rather than over the top of it.
    if (state.autoMode.active) ports.actions.exitAutoMode();
    ports.generatedQueue?.stop();
    ports.stagedEntry = null;
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
      radioSeedId: snapshot.radio.seedId
    });
    const auto = snapshot.auto;
    if (auto) {
      ports.autoSessionEpoch += 1;
      ports.autoPlaybackPrefs = null;
      setState('autoMode', {
        active: true,
        profile: auto.profile,
        djProfile: auto.djProfile,
        direction: auto.direction,
        sources: auto.sources,
        heard: auto.heard,
        exploration: auto.exploration ?? [],
        directionRevision: auto.directionRevision ?? 0,
        avoidedIdentities: auto.avoidedIdentities,
        plan: auto.plan,
        staleSeams: auto.staleSeams,
        transition: {
          status: 'idle'
        },
        pendingDirection: false,
        repairing: false,
        activity: null,
        // The planner is started by whoever presses play. Until then the route
        // that arrived is the runway, and `planning` would promise a request
        // nobody has made yet.
        phase: futureEntries(queue, index, 'generated').length > 0 ? 'ready' : 'idle'
      });
    }
    updateMediaSession(entry);
    return entry;
  }
  function sessionFor(remote: RemotePlaybackState): PlaybackSessionSnapshot | null {
    const session = readPlaybackSession(remote.session);
    return session && session.queue[session.index]?.id === remote.track_id ? session : null;
  }
  function playRestoredSession(session: PlaybackSessionSnapshot, position: number): boolean {
    const entry = applySessionSnapshot(session, position);
    if (!entry) return false;
    ports.userPlaybackStartedThisSession = true;
    // Before the load, not after: loading an entry asks the live session for more
    // runway in the same tick, and there has to be one to ask.
    if (state.autoMode.active) {
      void ports.ensureGeneratedQueue().start('auto_mode', entry, state.autoMode.profile);
    }
    ports.loadIndex(state.playback.index, {
      restart: true,
      trigger: 'resume'
    });
    if (position > 0) lifetime.setTimeout(() => ports.actions.seek(position), 400);
    return true;
  }
  function restoreSameDevicePlayback(remote: RemotePlaybackState): void {
    const track = state.library.find(t => t.id === remote.track_id) ?? remote.track ?? null;
    if (!track) return;
    const pos = Math.max(0, Number(remote.position_sec) || 0);
    const session = sessionFor(remote);
    const restored = session ? applySessionSnapshot(session, pos) : null;
    if (restored) {
      primeRestored(restored, pos);
      return;
    }
    ports.releasePreparation();
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
        label: track.artist
      })],
      index: 0
    });
    updateMediaSession(track);
    primeRestored(state.playback.queue[0], pos);
  }
  function primeRestored(entry: PlaybackQueueEntry, position: number): void {
    if (isPendingEntry(entry)) {
      ports.unmatchedSelection = {
        queueId: entry.queueId,
        paused: true
      };
      return;
    }
    ports.podcastProgressOwner = user()?.id;
    audioService.prime(ports.trackUrl(entry), position, ports.levelFor(entry));
  }
  const RESUME_SEARCH_INTERVAL_MS = 2000;
  const RESUME_SEARCH_ATTEMPTS = 3;
  const RESUME_HANDOFF_ATTEMPTS = 10;
  async function searchForResume(attempts: number): Promise<void> {
    const isCurrent = lifetime.capture();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) {
        await new Promise(resolve => lifetime.setTimeout(() => resolve(undefined), RESUME_SEARCH_INTERVAL_MS));
        if (!isCurrent()) {
          return;
        }
      }
      if (state.playback.currentTrack || ports.userPlaybackStartedThisSession || resumeState()) return;
      await ports.actions.checkResume();
      if (!isCurrent()) {
        return;
      }
    }
  }
  const domainActions = {
    async checkResume(): Promise<void> {
      const isCurrent = lifetime.capture();
      if (state.playback.currentTrack || ports.userPlaybackStartedThisSession) return;
      let remote: RemotePlaybackState | undefined;
      try {
        remote = await api.getPlaybackState(state.device.device_id);
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        return;
      }
      if (!remote || !remote.track_id || state.playback.currentTrack || ports.userPlaybackStartedThisSession) return;
      const updatedAt = Number(remote.updated_at) || 0;
      if (updatedAt && Date.now() / 1000 - updatedAt > 24 * 3600) return; // stale (>24h)
      if (remote.device_id === state.device.device_id) {
        restoreSameDevicePlayback(remote);
        return;
      }
      // Honour the 30-min "No" cooldown unless the other device has played since.
      const now = Date.now();
      const suppressUntil = Number(localStorage.getItem('resume_suppress_until')) || 0;
      const cooldownAt = Number(localStorage.getItem('resume_cooldown_at')) || 0;
      if (now < suppressUntil && updatedAt * 1000 <= cooldownAt) return;
      setResumeState(remote);
    },
    resumeHere(): void {
      const r = resumeState();
      setResumeState(null);
      if (!r?.track_id) return;
      const track = state.library.find(t => t.id === r.track_id) ?? r.track ?? null;
      if (!track) return;
      ports.userPlaybackStartedThisSession = true;
      const pos = Math.max(0, Number(r.position_sec) || 0);
      const session = sessionFor(r);
      if (session && playRestoredSession(session, pos)) return;
      ports.actions.playTrack(track);
      if (pos > 0) lifetime.setTimeout(() => ports.actions.seek(pos), 400);
    },
    publishSession(): void {
      if (!state.playback.currentTrack) return;
      pushPlaybackState({
        keepalive: true,
        body: playbackStateBody({
          position_sec: livePosition()
        })
      });
    },
    dismissResume(): void {
      setResumeState(null);
      const now = Date.now();
      localStorage.setItem('resume_suppress_until', String(now + 30 * 60 * 1000));
      localStorage.setItem('resume_cooldown_at', String(now));
    }
  };
  return {
    actions: domainActions,
    updateMediaSession,
    pushEmptyPlaybackState,
    pushPlaybackState,
    get RESUME_HANDOFF_ATTEMPTS() {
      return RESUME_HANDOFF_ATTEMPTS;
    },
    get RESUME_SEARCH_ATTEMPTS() {
      return RESUME_SEARCH_ATTEMPTS;
    },
    get programMediaSession() {
      return programMediaSession;
    },
    updatePositionState,
    osSeekStep,
    sessionFor,
    playRestoredSession,
    sessionOutOfDate,
    playbackStateBody,
    livePosition,
    searchForResume
  };
}
