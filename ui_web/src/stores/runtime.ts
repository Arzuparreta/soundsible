import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { syncSavedEntities } from "../lib/savedEntities";
import { user } from "../lib/session";
import { createSocket, type AppSocket, dispatchDiscoverSeed } from "../lib/socket";
import { api, type RemotePlaybackState } from "../lib/api";
import { audioService, onProgramEvent, setProgramOutputReporter, setProgramTransportReporter, type ProgramMediaEventName, type ProgramPlaybackSnapshot } from "../lib/audio";
import { ProgramMediaSession, type MediaSessionSyncReason } from "../lib/mediaSession";
import { recordPlaybackDiagnostic, startAutomaticPlaybackDiagnostics } from "../lib/playbackDiagnostics";
import { bustCovers } from "../lib/media";
import { isPodcastTrack } from "../lib/track";
import { createShortcutHandler } from "../lib/shortcuts";
import { nudgeVolumeGain } from "../lib/volumeScale";
import { ListeningLearning } from "../lib/listeningLearning";
import { type PlaybackSessionSnapshot } from "../lib/playbackSession";
import { liveHandoffPending } from "../lib/liveHandoff";
import type { Track } from "../types/music";
import type { DownloadEvent } from "../types/download";
import { applyVisualPreferences } from "../lib/visualPreferences";
import { applyDownloadEvent } from "./downloads";
import { refreshLinkReading } from "../lib/linkQuality";
import { state, setState, nowPlayingOpen, setNowPlayingOpen } from "./core";
import { announceTheme, applyTheme } from "./theme";
import type { PlayerActions, PlaybackAttempt, PublishedPlaybackState } from "./contracts";
export interface RuntimePorts {
  RESUME_HANDOFF_ATTEMPTS: number;
  RESUME_SEARCH_ATTEMPTS: number;
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
  updateMediaSession: (track: Track | null, reason?: MediaSessionSyncReason, forceMetadata?: boolean) => void;
  programMediaSession: ProgramMediaSession;
  ensureAutoplay: (force?: boolean) => Promise<boolean>;
  discardFutureAutoplay: () => void;
  applyVolumeLeveling: (enabled: boolean) => void;
  applyDjMixing: (enabled: boolean) => void;
  clearStallTimer: () => void;
  cancelActiveAttempt: (reason?: string) => void;
  pushPlaybackState: (opts?: {
    keepalive?: boolean;
    body?: PublishedPlaybackState;
  }) => void;
  unmatchedSelection: {
    queueId: string;
    paused: boolean;
  } | null;
  beginLoad: () => number;
  onEnded: () => void;
  activeAttempt: PlaybackAttempt | null;
  onPlaybackFailed: (generation: number, reason?: string, media?: Record<string, number | boolean>) => void;
  loadGeneration: number;
  scheduleStallRecovery: (delayMs?: number) => void;
  STARTUP_RECOVERY_MS: number;
  STALL_RECOVERY_MS: number;
  rememberDjExploration: () => void;
  consecutiveLoadFailures: number;
  flushWhenAudible: () => void;
  stageNext: () => void;
  emitAttempt: (attempt: PlaybackAttempt, phase: string, terminalState: string, extra?: Record<string, number | boolean>, failureReason?: string) => void;
  podcastProgressSavedAt: number;
  savePodcastProgress: (completed?: boolean, position?: number) => void;
  listeningLearning: ListeningLearning;
  evaluateDjRunway: () => void;
  watchRunway: (snapshot: ProgramPlaybackSnapshot) => void;
  updatePositionState: (reason?: MediaSessionSyncReason) => void;
  revalidatePreparation: () => void;
  resumeFromStarved: () => void;
  actions: Pick<PlayerActions, 'autoSkip' | 'cycleRepeat' | 'enterAutoMode' | 'exitAutoMode' | 'loadDownloads' | 'next' | 'pausePlayback' | 'playTrack' | 'prev' | 'resumePlayback' | 'seek' | 'seekBy' | 'setVolume' | 'syncLibrary' | 'syncLibrarySoon' | 'toggleFavouriteTrack' | 'toggleMute' | 'togglePlay' | 'toggleShuffle'>;
  osSeekStep: () => number;
  loudnessAsked: Set<string>;
  sessionFor: (remote: RemotePlaybackState) => PlaybackSessionSnapshot | null;
  playRestoredSession: (session: PlaybackSessionSnapshot, position: number) => boolean;
  sessionOutOfDate: () => boolean;
  playbackStateBody: (override?: Partial<{
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
  }>) => {
    track_id: string | null;
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
    device_id: string;
    device_name: string;
    device_type: string;
    session?: PlaybackSessionSnapshot | null;
  };
  livePosition: () => number;
  searchForResume: (attempts: number) => Promise<void>;
}

/** Owns runtime behaviour; cross-domain work enters through explicit ports. */
export function createRuntime(ports: RuntimePorts, lifetime: RuntimeLifetime) {
  let socket: AppSocket | null = null;
  let _warmTimer: ReturnType<typeof setTimeout> | null = null;
  function displayMode(): string {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'unknown';
    return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & {
      standalone?: boolean;
    }).standalone === true ? 'standalone' : 'browser';
  }
  function installAudioUnlock(): void {
    if (typeof window === 'undefined') return;
    const unlock = () => {
      recordPlaybackDiagnostic('gesture.audio_unlock');
      audioService.unlockAudio();
      // A generic tap may initialize audio, but only Play may lift a pause.
    };
    // Capture, so it runs ahead of the click handler that starts the first track.
    lifetime.listen(window, 'pointerdown', unlock, {
      capture: true
    });
    lifetime.listen(window, 'touchend', unlock, {
      capture: true
    });
    lifetime.listen(window, 'keydown', unlock, {
      capture: true
    });
  }
  function initStore(): void {
    if (socket) return;
    lifetime.start();
    const diagnosticUser = user()?.id;
    if (diagnosticUser) lifetime.own(startAutomaticPlaybackDiagnostics({
      userId: diagnosticUser,
      deviceId: state.device.device_id,
      platform: /(?:iPhone|iPad|iPod)/.test(navigator.userAgent) ? `ios-reported-${navigator.userAgent.match(/OS ([\d_]+)/)?.[1]?.replaceAll('_', '.') ?? 'unknown'}` : 'other',
      displayMode: displayMode()
    }, api.sendPlaybackTrace, () => user()?.id === diagnosticUser));

    // Read now, spent later. Live clears the marker as soon as it has opened the
    // room it was sent here to open, and that can happen before the library sync
    // this decision waits on has come back.
    const resumeAttempts = liveHandoffPending() ? ports.RESUME_HANDOFF_ATTEMPTS : ports.RESUME_SEARCH_ATTEMPTS;
    installAudioUnlock();
    setProgramOutputReporter(event => {
      ports.emitPlaybackEvent('ui_program_output', {
        carrier_playing: event.carrierPlaying,
        carrier_paused: event.carrierPaused,
        carrier_ready_state: event.carrierReadyState
      }, {
        output_mode: event.mode,
        output_event: event.event,
        failure_reason: event.reason,
        context_state: event.contextState,
        display_mode: displayMode()
      });
      if (state.playback.currentTrack) {
        const modeChanged = event.event === 'fallback_entered' || event.event === 'fallback_recovered';
        ports.updateMediaSession(state.playback.currentTrack, 'output_change', modeChanged);
      }
    });
    ports.programMediaSession.setReporter(event => {
      ports.emitPlaybackEvent('ui_media_session_sync', {
        metadata_revision: event.revision,
        carrier_playing: event.carrierPlaying,
        source_playing: event.sourcePlaying,
        state_matches: event.expectedState === event.declaredState
      }, {
        output_mode: event.outputMode,
        media_session_state: event.declaredState,
        sync_reason: event.reason,
        display_mode: displayMode()
      });
    });
    setProgramTransportReporter(event => {
      ports.emitPlaybackEvent(event.kind === 'inactive_deck_play' ? 'ui_inactive_deck_play' : 'ui_program_transport', {
        active_deck: event.activeIndex,
        dominant: event.dominant,
        hidden: event.hidden,
        deck_0_playing: event.deck0Playing,
        deck_1_playing: event.deck1Playing
      }, {
        transport_action: event.kind,
        transport_origin: event.origin,
        mix_phase: event.mixPhase,
        display_mode: displayMode()
      });
      // A stale element just tried to reclaim the platform session. Publish the
      // canonical programme again after the audio layer has stopped it.
      if (event.kind === 'inactive_deck_play' && state.playback.currentTrack) {
        ports.updateMediaSession(state.playback.currentTrack, 'source_anomaly', true);
      }
    });
    applyVisualPreferences({
      interfaceSize: state.interfaceSize,
      highContrast: state.highContrast
    });
    applyTheme(state.theme);
    // Catch the shell up on a preference chosen before it could be told — an
    // upgrade, or a theme set in a browser and first met on the desktop.
    announceTheme(state.theme);
    try {
      void api.getDiscoverySettings().then(lifetime.guard(settings => {
        if (typeof settings.autoplay_enabled === 'boolean') {
          setState('playback', 'autoplayEnabled', settings.autoplay_enabled);
          if (settings.autoplay_enabled) queueMicrotask(() => void ports.ensureAutoplay());else ports.discardFutureAutoplay();
        }
        // Reconcile the localStorage mirror the store booted from. A ramp
        // rather than a jump, so a device that disagreed with the account
        // corrects itself without a lurch a second into the session.
        if (typeof settings.volume_leveling === 'boolean' && settings.volume_leveling !== state.playback.volumeLeveling) {
          ports.applyVolumeLeveling(settings.volume_leveling);
        }
        if (typeof settings.dj_mixing === 'boolean' && settings.dj_mixing !== state.playback.djMixing) {
          ports.applyDjMixing(settings.dj_mixing);
        }
      })).catch(lifetime.guard(() => {}));
    } catch {
      // Test doubles and older engines may not expose this setting yet.
    }

    /** The store consumes one programme, never either implementation deck. */
    const a = {
      addEventListener: (type: ProgramMediaEventName, handler: (snapshot: ProgramPlaybackSnapshot, event: Event) => void) => lifetime.own(onProgramEvent(type, lifetime.guard(handler)))
    };
    a.addEventListener('sourcesettled', () => {
      // Retiring/preloading a source can change WebKit's selected media element.
      // Reconcile after ownership changes, even while hidden, without play().
      ports.updateMediaSession(state.playback.currentTrack, 'sources_settled');
    });
    a.addEventListener('outputhealth', () => {
      const health = audioService.outputHealth();
      if (health === 'healthy') return;
      ports.clearStallTimer();
      if (health === 'recovering') {
        setState('playback', {
          isPlaying: false,
          isLoading: true,
          phase: 'recovering'
        });
      } else {
        ports.cancelActiveAttempt('output_recovery_failed');
        setState('playback', {
          isPlaying: false,
          isLoading: false,
          phase: 'paused',
          needsGesture: true
        });
      }
      ports.updateMediaSession(state.playback.currentTrack, 'output_change');
      ports.pushPlaybackState();
    });
    a.addEventListener('play', () => {
      setState('playback', 'isPlaying', true);
      ports.pushPlaybackState();
    });
    a.addEventListener('pause', () => {
      // The outgoing song stopping for a selection that is still being matched.
      if (ports.unmatchedSelection && !ports.unmatchedSelection.paused) return;
      ports.beginLoad();
      ports.clearStallTimer();
      if (state.playback.phase === 'loading' || state.playback.phase === 'recovering') ports.cancelActiveAttempt('program_pause');
      setState('playback', {
        isPlaying: false,
        isLoading: false,
        phase: 'paused'
      });
      ports.updateMediaSession(state.playback.currentTrack, 'paused');
      ports.pushPlaybackState();
    });
    a.addEventListener('ended', () => ports.onEnded());
    a.addEventListener('error', snapshot => {
      // `stop()` clears src, which some engines report as an error. Nothing is
      // loaded and nothing is expected to be — not a playback failure.
      if (!snapshot.hasSource) return;
      // Restoring this device's last session primes the track while leaving it
      // paused. A stale or temporarily unreachable stream may reject that
      // best-effort preload, but nobody asked Soundsible to play it. Only a real
      // playback attempt is allowed to fail visibly.
      if (!ports.activeAttempt) return;
      ports.onPlaybackFailed(ports.loadGeneration, 'media_error', {
        media_error_code: snapshot.mediaErrorCode,
        network_state: snapshot.networkState,
        ready_state: snapshot.readyState
      });
    });
    // A seek the listener asked for. Remembered so that the `waiting` it is about
    // to cause is not filed as a stream that died.
    a.addEventListener('seeking', () => {
      if (ports.activeAttempt) ports.activeAttempt.seekPending = true;
    });
    // Buffering, both cold (nothing has sounded yet) and mid-track. Either way the
    // transport shows progress instead of a stuck play button — but only the second
    // one is a delivery failure, and they are counted apart.
    a.addEventListener('waiting', () => {
      if (!state.playback.currentTrack) return;
      const attempt = ports.activeAttempt;
      if (attempt && attempt.bufferStartedAt === null) {
        attempt.bufferStartedAt = performance.now();
        if (attempt.audibleAt !== null) {
          if (attempt.seekPending) attempt.seekRebufferCount += 1;else attempt.rebufferCount += 1;
        }
      }
      setState('playback', {
        isLoading: true,
        phase: 'buffering'
      });
      // A wait long enough to notice is a wait worth explaining. The reading is
      // throttled inside, so a track that stalls repeatedly asks once.
      void refreshLinkReading();
      ports.scheduleStallRecovery(attempt?.audibleAt == null ? ports.STARTUP_RECOVERY_MS : ports.STALL_RECOVERY_MS);
    });
    a.addEventListener('canplay', () => {
      // `canplay` can precede actual audio by a noticeable amount; `playing` is
      // the only event that closes the user's click-to-sound attempt.
      const attempt = ports.activeAttempt;
      if (attempt && attempt.canPlayAt === null) attempt.canPlayAt = performance.now();
    });
    // First 'playing' after a user-initiated load → click-to-sound latency.
    a.addEventListener('playing', snapshot => {
      ports.rememberDjExploration();
      ports.clearStallTimer();
      setState('playback', {
        isLoading: false,
        loadError: false,
        phase: 'playing'
      });
      ports.updateMediaSession(state.playback.currentTrack, 'playing');
      ports.consecutiveLoadFailures = 0;
      ports.flushWhenAudible();
      // Only verified previews can reach this deck, so staging here reads the
      // engine's disk cache instead of competing with the track that just began.
      ports.stageNext();
      const attempt = ports.activeAttempt;
      if (!attempt || state.playback.currentTrack?.id !== attempt.trackId) return;
      const now = performance.now();
      const spell = attempt.bufferStartedAt === null ? 0 : Math.max(0, now - attempt.bufferStartedAt);
      attempt.bufferStartedAt = null;
      if (attempt.audibleAt === null) attempt.startupStallMs += spell;else attempt.rebufferMs += spell;
      attempt.seekPending = false;
      if (attempt.audibleAt === null) {
        attempt.audibleAt = now;
        // No stall counters here. At this instant nothing can have stalled yet —
        // the sound has only just started — so any number reported here describes
        // the wait that `click_to_playing_ms` already describes. `ui_play_delivery`
        // asks the stall question at a time when it has an answer.
        ports.emitAttempt(attempt, 'ui_click_to_playing', 'playing', {
          click_to_playing_ms: Math.round(now - attempt.startedAt),
          ...(attempt.loadedMetadataAt === null ? {} : {
            loadedmetadata_ms: Math.round(attempt.loadedMetadataAt - attempt.startedAt)
          }),
          ...(attempt.canPlayAt === null ? {} : {
            canplay_ms: Math.round(attempt.canPlayAt - attempt.startedAt)
          }),
          startup_stall_ms: Math.round(attempt.startupStallMs),
          recovery_count: attempt.recoveryCount,
          ready_state: snapshot.readyState,
          network_state: snapshot.networkState,
          buffered_ahead_ms: Math.max(0, Math.round((snapshot.bufferedEnd - snapshot.position) * 1000))
        });
      } else if (attempt.recoveryCount > attempt.reportedRecoveryCount) {
        ports.emitAttempt(attempt, 'ui_recovery_succeeded', 'playing', {
          rebuffer_count: attempt.rebufferCount,
          rebuffer_ms: Math.round(attempt.rebufferMs),
          recovery_count: attempt.recoveryCount
        });
        attempt.reportedRecoveryCount = attempt.recoveryCount;
      }
    });
    a.addEventListener('timeupdate', snapshot => {
      const position = snapshot.position;
      setState('playback', 'currentTime', position);
      if (Date.now() - ports.podcastProgressSavedAt >= 5000) ports.savePodcastProgress();
      ports.listeningLearning.update(state.playback.currentTrack, position, snapshot.playing);
      if (snapshot.playing) ports.rememberDjExploration();
      ports.evaluateDjRunway();
      ports.watchRunway(snapshot);
    });
    const setDur = (snapshot: ProgramPlaybackSnapshot) => {
      setState('playback', 'duration', snapshot.duration);
      ports.updatePositionState();
    };
    a.addEventListener('durationchange', setDur);
    a.addEventListener('loadedmetadata', snapshot => {
      const attempt = ports.activeAttempt;
      if (attempt && attempt.loadedMetadataAt === null) attempt.loadedMetadataAt = performance.now();
      setDur(snapshot);
    });
    // A seek from anywhere — our transport, the lock screen, a car button — has
    // to re-anchor the OS scrubber or it keeps counting from the old position.
    a.addEventListener('seeked', () => ports.updatePositionState('seeked'));
    a.addEventListener('ratechange', () => ports.updatePositionState());
    let hiddenSince: number | null = null;
    lifetime.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') ports.savePodcastProgress();
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
          isPlaying: snapshot.playing
        });
        // The element is the authority after a spell asleep, and the OS card may
        // have been reading a state nobody corrected while the page was frozen.
        ports.updateMediaSession(state.playback.currentTrack, 'visibility_resume', true);
        if (hiddenSince !== null && drift > 1) {
          ports.emitPlaybackEvent('ui_visibility_resume', {
            hidden_sec: Math.round((Date.now() - hiddenSince) / 1000),
            drift_sec: Math.round(drift)
          });
        }
      }
      hiddenSince = null;
      ports.revalidatePreparation();
      // Whatever stopped while we were away gets one more chance now.
      ports.resumeFromStarved();
      if (state.playback.phase === 'buffering') {
        const attempt = ports.activeAttempt;
        ports.scheduleStallRecovery(attempt?.audibleAt == null ? ports.STARTUP_RECOVERY_MS : ports.STALL_RECOVERY_MS);
      }
    });
    // Page Lifecycle's counterpart to the above, fired on the document: iOS can
    // freeze a backgrounded page outright, and a page that is thawed rather than
    // merely revealed does not always get a `visibilitychange` of its own.
    lifetime.listen(document, 'resume', () => {
      ports.revalidatePreparation();
      ports.resumeFromStarved();
    });
    ports.programMediaSession.installActions({
      play: () => ports.actions.resumePlayback('media_session'),
      pause: () => ports.actions.pausePlayback('media_session'),
      next: () => {
        if (state.autoMode.active) void ports.actions.autoSkip();else ports.actions.next();
      },
      previous: () => ports.actions.prev(),
      seekTo: position => ports.actions.seek(position),
      seekBackward: offset => ports.actions.seekBy(-(offset ?? ports.osSeekStep())),
      seekForward: offset => ports.actions.seekBy(offset ?? ports.osSeekStep())
    });
    socket = createSocket();
    const ownedSocket = socket;
    lifetime.own(() => {
      ownedSocket.disconnect();
      socket = null;
    });
    lifetime.own(() => {
      setProgramOutputReporter(null);
      setProgramTransportReporter(null);
      ports.programMediaSession.setReporter(null);
      ports.programMediaSession.uninstallActions();
    });
    socket.on('connect', lifetime.guard(() => {
      void syncSavedEntities();
      ports.revalidatePreparation();
      setState('online', true);
      socket!.emit('playback_register', state.device);
      void api.registerDevice(state.device).catch(lifetime.guard(() => {}));
      void ports.actions.loadDownloads(); // re-seed the queue after a (re)connect
      // The station is reachable again: if the music ran out while it was not,
      // this is the moment that ends the silence.
      ports.resumeFromStarved();
    }));
    socket.on('disconnect', lifetime.guard(() => setState('online', false)));
    // A sweep measured more of the library. Nothing re-levels mid-song; the new
    // numbers ride the refreshed library and apply from the next track on.
    socket.on('loudness_updated', lifetime.guard(() => {
      // New numbers landed, so what was asked for before is now answerable from
      // the library. Anything still missing after the resync is worth asking again.
      ports.loudnessAsked.clear();
      ports.actions.syncLibrarySoon();
    }));
    socket.on('library_updated', lifetime.guard((payload?: {
      cover_changed?: boolean;
    }) => {
      // Cover edits on another device only reach this tab through this event —
      // bust the local cache-buster so the new art is fetched instead of the
      // long-lived cached image. Gated on the flag so unrelated library changes
      // (scans, renames, deletes) don't force every visible cover to refetch.
      if (payload?.cover_changed) bustCovers();
      // Shares the coalescing window with download completions, which arrive for
      // the same writes moments earlier.
      ports.actions.syncLibrarySoon();
      // Note: Debounced discover cache warming — when the library changes (new
      // saves, favourites, deletes) the top seeds may shift, so re-warm the
      // persistent related-mix cache in the background. The server picks its own
      // top seeds; this is fire-and-forget.
      if (_warmTimer) lifetime.clearTimeout(_warmTimer);
      _warmTimer = lifetime.setTimeout(() => {
        void api.warmDiscoverSeeds([]).catch(lifetime.guard(() => {}));
      }, 4000);
    }));
    // The collection changes without the library changing — a song saved or
    // hearted on another device, or a catalog row that just finished resolving to
    // a playable video.
    socket.on('saved_entities_updated', lifetime.guard(() => void syncSavedEntities()));
    socket.on('favourites_updated', lifetime.guard(() => {
      void api.getSaved().then(lifetime.guard(saved => setState('saved', saved))).catch(lifetime.guard(() => {}));
    }));
    socket.on('downloader_update', lifetime.guard(data => applyDownloadEvent((data ?? {}) as DownloadEvent)));
    socket.on('discover_seed_ready', lifetime.guard(data => dispatchDiscoverSeed(data as {
      request_id: string;
      seed_track_id: string;
      recs: unknown[];
    })));

    // ── Remote control: this device acts on commands from another device. ──
    socket.on('playback_stop_requested', lifetime.guard(() => {
      if (state.playback.isPlaying) audioService.pause();
    }));
    socket.on('playback_start_requested', lifetime.guard(data => {
      const trk = data?.track;
      // A handoff from another device carries that device's whole session, so
      // this one continues it rather than starting the same song over on its own.
      const handedOver = trk && typeof trk.id === 'string' ? ports.sessionFor({
        ...(data?.state ?? {}),
        track_id: trk.id
      }) : null;
      const handoffPosition = Number(data?.state?.position_sec);
      if (handedOver && ports.playRestoredSession(handedOver, Number.isFinite(handoffPosition) ? Math.max(0, handoffPosition) : 0)) {
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
          media_kind: typeof trk.media_kind === 'string' ? trk.media_kind : undefined
        };
        ports.actions.playTrack(t);
        const pos = Number(data?.state?.position_sec);
        if (Number.isFinite(pos) && pos > 0) lifetime.setTimeout(() => ports.actions.seek(pos), 400);
      } else if (state.playback.currentTrack) {
        void audioService.resume().catch(lifetime.guard(() => {}));
      }
    }));
    socket.on('playback_next_requested', lifetime.guard(() => {
      if (state.autoMode.active) void ports.actions.autoSkip();else ports.actions.next();
    }));
    socket.on('playback_previous_requested', lifetime.guard(() => ports.actions.prev()));
    socket.on('playback_seek_requested', lifetime.guard(data => {
      const p = Number(data?.position_sec);
      if (Number.isFinite(p)) ports.actions.seek(p);
    }));

    // Keep the published position fresh so other devices resume near where we are
    // — and the session with it, including while paused: a route reordered or a
    // source added during a break is part of what a handoff hands over.
    lifetime.setInterval(() => {
      if (!state.playback.currentTrack) return;
      if (state.playback.isPlaying || ports.sessionOutOfDate()) ports.pushPlaybackState();
    }, 15000);
    const pushStateOnUnload = () => {
      ports.savePodcastProgress();
      if (!state.playback.currentTrack) return;
      ports.pushPlaybackState({
        keepalive: true,
        body: ports.playbackStateBody({
          position_sec: ports.livePosition(),
          is_playing: false
        })
      });
    };
    lifetime.listen(window, 'beforeunload', pushStateOnUnload);
    lifetime.listen(window, 'pagehide', pushStateOnUnload);
    void ports.actions.syncLibrary().then(lifetime.guard(() => ports.searchForResume(resumeAttempts)));
    void ports.actions.loadDownloads();
    // Warm the discovery feed so Search and Podcasts render cached rails instantly.
    void import('../lib/discover').then(lifetime.guard(m => {
      lifetime.own(m.resetDiscover);
      m.ensureDiscover();
    }));

    // Global keyboard shortcuts (desktop). The decision table lives in
    // lib/shortcuts so it can be tested without a DOM; the store only supplies
    // the context snapshot and the callbacks.
    if (typeof window !== 'undefined') {
      lifetime.listen(window, 'keydown', createShortcutHandler(() => ({
        autoModeActive: state.autoMode.active,
        nowPlayingOpen: nowPlayingOpen(),
        autoModeAvailable: !state.playback.currentTrack || !isPodcastTrack(state.playback.currentTrack)
      }), {
        togglePlay: () => ports.actions.togglePlay(),
        // Auto Mode owns the queue: skipping has to go through the generated
        // session coordinator
        // so it can pick a replacement, not walk a queue it is rewriting.
        next: () => {
          if (state.autoMode.active) void ports.actions.autoSkip();else ports.actions.next();
        },
        prev: () => ports.actions.prev(),
        seekBy: delta => ports.actions.seek(Math.max(0, state.playback.currentTime + delta)),
        // `setVolume` clamps, and already lifts mute when the level goes
        // above zero — turning it up is a request to hear something.
        nudgeVolume: delta => ports.actions.setVolume(nudgeVolumeGain(state.playback.volume, delta)),
        toggleMute: () => ports.actions.toggleMute(),
        toggleShuffle: () => ports.actions.toggleShuffle(),
        cycleRepeat: () => ports.actions.cycleRepeat(),
        toggleFavourite: () => {
          const track = state.playback.currentTrack;
          // Whatever is playing can be saved — owning the file is not a
          // precondition, only being a song is (podcasts have their own shelf).
          if (track && !isPodcastTrack(track)) ports.actions.toggleFavouriteTrack(track);
        },
        enterAutoMode: () => ports.actions.enterAutoMode(),
        exitAutoMode: () => ports.actions.exitAutoMode(),
        closeNowPlaying: () => setNowPlayingOpen(false)
      }));
    }
  }
  const domainActions = {};
  return {
    actions: domainActions,
    initStore
  };
}
