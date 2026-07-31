import { createStore } from 'solid-js/store';
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createSocket, type AppSocket, dispatchDiscoverSeed } from '../lib/socket';
import {
  api,
  type DjDirection,
  type DjItemRef,
  type DjPlanResponse,
  type DjProfile,
  type DjRequestTarget,
  type DeviceRegistration,
  type ListeningPlanItem,
  type RemotePlaybackState,
} from '../lib/api';
import {
  audioEl,
  audioService,
  isActiveDeck,
  onDeckEvent,
  setGraphReporter,
  storedVolume,
  type LiveTransitionPlan,
} from '../lib/audio';
import { streamUrl, previewUrl, podcastStreamUrl, coverUrl, bustCovers, playbackYoutubeId } from '../lib/media';
import { prefetchPreviews, upcomingPreviewIds } from '../lib/prefetch';
import { toast } from '../lib/toast';
import { vibrate } from '../lib/haptics';
import { isMusicTrack, isPodcastTrack, podcastEpisodeToTrack } from '../lib/track';
import { queueIdentity, queueIndexOf } from '../lib/queueDiscovery';
import {
  buildIdentityIndex,
  catalogItemKeys,
  collectIdentityKeys,
  keysMatch,
  podcastEpisodeKeys,
  resolvePlayingKeys,
  searchResultKeys,
  trackKeys,
  withLinkedKeys,
} from '../lib/playbackIdentity';
import { savedFromTrack, savedToTrack, savedVideoId } from '../lib/saved';
import {
  GeneratedQueueController,
  type AutoActivity,
  type AutoModeState,
  type AutoPlanItem,
  type AutoProfile,
  type AutoRequest,
} from '../lib/generatedQueue';
import { createShortcutHandler } from '../lib/shortcuts';
import { t as tr } from '../lib/i18n';
import { ListeningLearning } from '../lib/listeningLearning';
import {
  createQueueEntry,
  defaultContext,
  futureEntries,
  manualInsertIndex,
  sameQueueSection,
  contextSource,
  type PlaybackContextDescriptor,
  type PlaybackQueueEntry,
  type QueueSource,
} from '../lib/playbackQueue';
import { shuffled } from '../lib/shuffle';
import type { Track, CatalogItem, SavedEntry, SearchResult, PlaylistMap, LibrarySettings } from '../types/music';
import type { PodcastSubscription, PodcastEpisode } from '../types/podcast';
import type { DownloadQueueItem, DownloadEvent, CompletedDownload } from '../types/download';
import {
  applyVisualPreferences,
  loadVisualPreferences,
  persistHighContrast,
  persistInterfaceSize,
  type InterfaceSize,
} from '../lib/visualPreferences';

/** User preference: explicit dark/light, or follow the OS via prefers-color-scheme. */
export type Theme = 'dark' | 'light' | 'system';
/** Concrete appearance applied to the document (never `system`). */
export type ResolvedTheme = 'dark' | 'light';
export type RepeatMode = 'off' | 'all' | 'one';
/**
 * `starved` is the end of the queue with nothing to follow *yet* — the generated
 * lane ran dry and the plan that would extend it has not arrived. It is
 * deliberately not `paused`: paused is a decision the listener made, starved is
 * a promise the player still owes them, and something is always on its way to
 * resolve it.
 */
export type PlaybackPhase =
  | 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'recovering' | 'failed' | 'starved';

export interface DownloadsState {
  /** Live queue (pending/downloading/failed). Completed items leave the queue. */
  queue: DownloadQueueItem[];
  /** Whether the engine pump is actively working. */
  isProcessing: boolean;
  /** Ephemeral "just finished" entries, auto-expired ~5s after completion. */
  recent: CompletedDownload[];
}

export interface PlaybackState {
  currentTrack: Track | null;
  isPlaying: boolean;
  /** Audio for `currentTrack` is being resolved/buffered and no sound is out yet.
   * Previews pay a multi-second yt-dlp resolution on the engine, so this is the
   * difference between "the app ignored my tap" and "it is working on it". Also
   * set when a playing track re-buffers mid-stream. */
  isLoading: boolean;
  /** The current track could not be played at all. Keeps the transport showing a
   * retry instead of a dead play button. */
  loadError: boolean;
  /** Detailed transport state; isLoading/loadError remain compatibility views. */
  phase: PlaybackPhase;
  /** The platform refused to resume without a fresh gesture — after recovering
   * from a dead audio graph, or after a `play()` that arrived too late to ride
   * the previous one. The transport turns this into a visible invitation to tap
   * instead of a player that simply stopped. */
  needsGesture: boolean;
  currentTime: number;
  duration: number;
  queue: PlaybackQueueEntry[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** 0..1, persisted via the audio service. */
  volume: number;
  muted: boolean;
  /** Whether the queue came from a radio session. Reset to false on any
   * non-radio play (playTrack/playFrom without `{ radio: true }`, playNow,
   * playEpisode). The seed COULD already be playing when radio started;
   * see `startRadio` for the keep-currentTrack branch. */
  radioMode: boolean;
  /** True while the radio mix is still loading in the background. The UI
   * badge pulses during this window; falls back to plain radio badge after. */
  radioLoading: boolean;
  /** Track id of the seed used to start the current radio. Useful to
   * preserve the seed vs mix identity without inferring from the queue. */
  radioSeedId: string | null;
  /** Account preference. Generated similar music is always the final lane,
   * behind explicit requests and the finite playback context. */
  autoplayEnabled: boolean;
  autoplayLoading: boolean;
}

export interface AppState {
  online: boolean;
  device: DeviceRegistration;
  theme: Theme;
  interfaceSize: InterfaceSize;
  highContrast: boolean;
  haptics: boolean;
  loading: boolean;
  /** The last library sync did not complete. What is on screen is whatever we
   * had before — possibly nothing. Lets the empty state say "couldn't reach
   * your station" instead of the untrue "your library is empty". */
  libraryError: boolean;
  /** A library sync has settled at least once, so `library` is now an answer
   * rather than an absence. Anything that treats an empty library as a fact —
   * empty states, discovery seeds — must wait for this instead of reading the
   * boot-time empty array. */
  libraryReady: boolean;
  /** Tracks with a file behind them, as the engine scanned them. */
  library: Track[];
  /** Songs in the library that are not (or not only) a file, newest first.
   * Identity-keyed, so an entry follows its song across a download instead of
   * pointing at one id. `favourite` on an entry is the heart, not the save. */
  saved: SavedEntry[];
  playlists: PlaylistMap;
  librarySettings: LibrarySettings;
  podcastSubscriptions: PodcastSubscription[];
  playback: PlaybackState;
  autoMode: AutoModeState;
  downloads: DownloadsState;
}

function initialAutoProfile(): AutoProfile {
  const value = localStorage.getItem('auto:profile');
  return value === 'familiar' || value === 'explore' ? value : 'balanced';
}

function initialDjProfile(): DjProfile {
  const value = localStorage.getItem('auto:dj-profile');
  return value === 'long_blend' || value === 'cuts_drops' || value === 'open_format'
    ? value
    : 'adaptive';
}

const initialDjDirection = (): DjDirection => ({
  energy: 0,
  familiarity: 0,
  prompt: '',
  include: [],
  exclude: [],
});

/**
 * UUID v4 that also works in insecure contexts (LAN/Tailscale over plain HTTP),
 * where `crypto.randomUUID` is undefined — only secure contexts (HTTPS /
 * localhost) expose it. `crypto.getRandomValues` is available everywhere.
 */
function randomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function loadDevice(): DeviceRegistration {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = randomId();
    localStorage.setItem('device_id', id);
  }
  return {
    device_id: id,
    device_name: localStorage.getItem('device_name') ?? 'Soundsible Web',
    device_type: 'web',
  };
}

function loadTheme(): Theme {
  const raw = localStorage.getItem('theme');
  if (raw === 'dark' || raw === 'light' || raw === 'system') return raw;
  return 'system';
}

const initialVisualPreferences = loadVisualPreferences();

const [state, setState] = createStore<AppState>({
  online: false,
  device: loadDevice(),
  theme: loadTheme(),
  interfaceSize: initialVisualPreferences.interfaceSize,
  highContrast: initialVisualPreferences.highContrast,
  haptics: localStorage.getItem('haptics') !== 'off',
  loading: false,
  libraryError: false,
  libraryReady: false,
  library: [],
  saved: [],
  playlists: {},
  librarySettings: {},
  podcastSubscriptions: [],
  playback: {
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    loadError: false,
    phase: 'idle',
    needsGesture: false,
    currentTime: 0,
    duration: 0,
    queue: [],
    index: -1,
    shuffle: false,
    repeat: 'off',
    volume: storedVolume(),
    muted: false,
    radioMode: false,
    radioLoading: false,
    radioSeedId: null,
    autoplayEnabled: true,
    autoplayLoading: false,
  },
  autoMode: {
    active: false,
    profile: initialAutoProfile(),
    djProfile: initialDjProfile(),
    direction: initialDjDirection(),
    requests: [],
    transition: { status: 'idle' },
    pendingDirection: false,
    phase: 'idle',
    activity: null,
    plan: {},
  },
  downloads: {
    queue: [],
    isProcessing: false,
    recent: [],
  },
});

export { state };

/** Now-Playing sheet open state (UI-only). */
export const [nowPlayingOpen, setNowPlayingOpen] = createSignal(false);

/** Cross-device resume candidate: another device's playback state we can pick up.
 * Set once on boot, cleared when the user accepts or dismisses it. */
export const [resumeState, setResumeState] = createSignal<RemotePlaybackState | null>(null);

let librarySyncInFlight = false;
let librarySyncPending = false;
let librarySyncVersion = 0;
let userPlaybackStartedThisSession = false;
let generatedQueue: GeneratedQueueController | null = null;
let autoPlaybackPrefs: { shuffle: boolean; repeat: RepeatMode } | null = null;
const AUTOPLAY_TARGET = 8;
const AUTOPLAY_PREPARE_THRESHOLD = 2;
/** Matches REFILL_THRESHOLD.autoplay in generatedQueue: deep enough that a
 * refill has room to fail and retry before the lane actually runs out. */
const AUTOPLAY_REFILL_THRESHOLD = 5;
type PlaybackTrigger = 'selection' | 'next' | 'ended' | 'retry' | 'resume' | 'recovery' | 'podcast';
type PlaybackSourceKind = 'local' | 'preview' | 'podcast';

interface PlaybackAttempt {
  id: string;
  trackId: string;
  sourceKind: PlaybackSourceKind;
  trigger: PlaybackTrigger;
  queueLane: string;
  startedAt: number;
  audibleAt: number | null;
  stallStartedAt: number | null;
  stallCount: number;
  stallMs: number;
  recoveryCount: number;
  reportedRecoveryCount: number;
  generation: number;
}

const STALL_RECOVERY_MS = 3000;
const STARTUP_RECOVERY_MS = 12000;
let activeAttempt: PlaybackAttempt | null = null;
let stallRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

function playbackSourceKind(track: Track): PlaybackSourceKind {
  if (isPodcastTrack(track)) return 'podcast';
  return track.source === 'preview' ? 'preview' : 'local';
}

function trackUrl(track: Track, attemptId?: string): string {
  const previewId = playbackYoutubeId(track);
  return track.source === 'preview' && previewId
    ? previewUrl(previewId, attemptId)
    : streamUrl(track.id, attemptId);
}

function clearStallTimer(): void {
  if (stallRecoveryTimer) clearTimeout(stallRecoveryTimer);
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
  strings: { failure_reason?: string; context_state?: string; display_mode?: string } = {},
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
    audibleAt: null,
    stallStartedAt: null,
    stallCount: 0,
    stallMs: 0,
    recoveryCount: 0,
    reportedRecoveryCount: 0,
    generation,
  };
  activeAttempt = attempt;
  return attempt;
}

/** Warm the tracks `actions.next` would reach so track changes start instantly.
 * Skipped in shuffle mode — the next pick is random, prefetch would guess wrong. */
function prefetchUpcoming(): void {
  const pb = state.playback;
  // Same job, one level closer to the speakers: whenever what comes next
  // changes, the deck holding it has to change with it.
  stageNext();
  if (pb.shuffle) return;
  const ids = upcomingPreviewIds(pb.queue, pb.index, pb.repeat === 'all', 5);
  // Only one full download here: the track immediately after this one is held
  // open on the idle deck by `stageNext`, and fetching it twice is the engine
  // resolving and proxying the same stream for nobody.
  const downloads = ids.slice(0, 1);
  if (downloads.length > 0) prefetchPreviews(downloads, { download: true });
  const warmOnly = ids.slice(2);
  if (warmOnly.length > 0) prefetchPreviews(warmOnly);
}

/**
 * Keep the next track loaded on the idle deck.
 *
 * Warming the HTTP cache is not enough: what makes `ended` able to continue
 * without touching the network — and what a phone with its screen off will
 * actually allow — is an element that is already holding the stream. Skipped in
 * shuffle (the next pick is random) and while a DJ handoff is armed, because the
 * idle deck is the incoming one and already belongs to the mixer.
 */
let stagedEntry: { queueId: string; attemptId: string; url: string } | null = null;

function stageNext(): void {
  const pb = state.playback;
  // Auto Mode's DJ loads the incoming track onto that same deck itself, cued to
  // its own in-point. Staging there would fetch the same stream twice and lose
  // the race anyway.
  if (state.autoMode.active || audioService.mixPhase() !== 'idle') return;
  const next = !pb.shuffle && pb.repeat !== 'one' ? pb.queue[pb.index + 1] : undefined;
  if (!next || isPodcastTrack(next)) {
    stagedEntry = null;
    audioService.clearStaged();
    return;
  }
  if (stagedEntry?.queueId === next.queueId) return;
  // The attempt id is minted here rather than at playback: it travels in the
  // stream URL, and the URL is fixed the moment the deck starts loading it.
  const attemptId = randomId();
  stagedEntry = { queueId: next.queueId, attemptId, url: trackUrl(next, attemptId) };
  audioService.stage(stagedEntry.url);
}

function discardFutureAutoplay(): void {
  generatedQueue?.stop('autoplay');
  const pb = state.playback;
  const queue = pb.queue.filter(
    (entry, index) => index <= pb.index || !(entry.queueLane === 'generated' && entry.queueSource === 'autoplay'),
  );
  setState('playback', { queue, autoplayLoading: false });
}

function cancelPendingRadio(): void {
  generatedQueue?.stop('radio');
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
  if (!force && deterministic.length > AUTOPLAY_PREPARE_THRESHOLD) return false;
  if (!force && generated.length >= AUTOPLAY_REFILL_THRESHOLD) return false;

  const seed = generated.at(-1) ?? deterministic.at(-1) ?? current;
  if (generated.length >= AUTOPLAY_TARGET) return true;
  return ensureGeneratedQueue().ensureAutoplay(seed, force);
}

function updateMediaSession(track: Track | null): void {
  if (!('mediaSession' in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    updatePositionState();
    return;
  }
  const art = track.cover ?? coverUrl(track.id);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    // Car head units and the macOS Now Playing panel have a dedicated album
    // line; without this they show a blank one.
    album: track.album ?? '',
    artwork: art ? [{ src: art, sizes: '512x512' }] : [],
  });
  updatePositionState();
}

/**
 * Publish the scrub position to the OS media controls.
 *
 * This is what turns a static lock-screen card into a real transport: the
 * progress bar, the elapsed/remaining times, and the draggable scrubber on
 * Android, iOS, macOS and most car head units all come from `positionState`.
 * Without it those surfaces show the title and nothing else.
 *
 * Browsers extrapolate between updates using `playbackRate`, so this only has
 * to run on the discrete events (metadata, seek, play/pause) — calling it from
 * `timeupdate` would be four times a second of pure waste.
 */
function updatePositionState(): void {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (typeof ms.setPositionState !== 'function') return;
  const a = audioEl();
  const duration = a.duration;
  try {
    if (!Number.isFinite(duration) || duration <= 0) {
      // Nothing loaded, or a live/unknown-length stream: clear rather than
      // publish a bar that would sit at zero forever.
      ms.setPositionState();
      return;
    }
    ms.setPositionState({
      duration,
      position: Math.min(Math.max(a.currentTime || 0, 0), duration),
      // A rate of 0 is rejected by the spec; the element reports it while paused.
      playbackRate: a.playbackRate > 0 ? a.playbackRate : 1,
    });
  } catch {
    // Safari throws if the element is between loads. The next event re-publishes.
  }
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
function loadIndex(i: number, opts: { restart?: boolean; trigger?: PlaybackTrigger } = {}): void {
  const track = state.playback.queue[i];
  if (!track) return;
  const pb = state.playback;
  if (!opts.restart && !pb.loadError && i === pb.index && pb.currentTrack?.id === track.id) {
    if (pb.isLoading || pb.isPlaying) return; // already on its way / already sounding
    void audioService.resume().catch(() => {});
    return;
  }
  userPlaybackStartedThisSession = true;
  const generation = beginLoad();
  // A deck already holding this exact stream takes over without a request and
  // without an `src` assignment. From `ended` that keeps the handover inside the
  // media event, which is what lets it continue at all on a locked phone.
  const staged = stagedEntry?.queueId === track.queueId
    ? audioService.takeStaged(stagedEntry.url)
    : null;
  const attempt = createPlaybackAttempt(
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
    currentTime: 0,
    duration: staged ? audioEl().duration || 0 : 0,
  });
  updateMediaSession(track);
  void (staged ?? audioService.load(trackUrl(track, attempt.id)))
    .catch(() => onPlaybackFailed(generation, 'load'));
  prefetchUpcoming();
  queueMicrotask(() => {
    void ensureAutoplay();
    if (state.playback.radioMode || state.autoMode.active) {
      void generatedQueue?.ensureRunway();
    }
  });
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
  if (attempt.stallStartedAt !== null) {
    attempt.stallMs += Math.max(0, performance.now() - attempt.stallStartedAt);
    attempt.stallStartedAt = null;
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
          return audioService.recover(podcastStreamUrl(stream_token, attempt.id), position);
        })
    : audioService.recover(trackUrl(track, attempt.id), position);
  void recovery.catch(() => onPlaybackFailed(generation, reason));
  return true;
}

function scheduleStallRecovery(delayMs = STALL_RECOVERY_MS): void {
  clearStallTimer();
  const attempt = activeAttempt;
  if (!attempt) return;
  // A hidden page that has never made a sound has nobody waiting on it, so
  // recovering costs bandwidth for nothing. A hidden page whose music just
  // stalled is a phone in a pocket, and recovery is the only way the music comes
  // back on its own — refusing to try there is what ended drives in silence.
  if (document.visibilityState === 'hidden' && attempt.audibleAt == null) return;
  stallRecoveryTimer = setTimeout(() => {
    stallRecoveryTimer = null;
    if (activeAttempt !== attempt || state.playback.phase !== 'buffering') return;
    if (!recoverCurrent('stall')) onPlaybackFailed(attempt.generation, 'stall');
  }, delayMs);
}

/** The current track cannot be played: surface it, then move on if that is the
 * sane thing to do. Silence with a dead play button was the old behaviour. */
function onPlaybackFailed(generation: number, reason = 'media_error'): void {
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
        stall_count: attempt.stallCount,
        stall_ms: Math.round(attempt.stallMs),
        recovery_count: attempt.recoveryCount,
      },
      reason,
    );
    activeAttempt = null;
  }
  setState('playback', { isPlaying: false, isLoading: false, loadError: true, phase: 'failed' });
  if (state.autoMode.active) {
    void actions.autoSkip();
    return;
  }
  consecutiveLoadFailures += 1;
  const hasNext = pb.index < pb.queue.length - 1 || (pb.repeat === 'all' && pb.queue.length > 1);
  if (hasNext && consecutiveLoadFailures <= MAX_CONSECUTIVE_SKIPS) {
    toast.error(tr('toast.trackUnavailableSkipping'));
    actions.next();
    return;
  }
  toast.error(tr('toast.trackUnavailable'));
}

function playbackStateBody(
  override: Partial<{
    track: Track | null;
    position_sec: number;
    is_playing: boolean;
  }> = {},
) {
  const pb = state.playback;
  const track = override.track !== undefined ? override.track : pb.currentTrack;
  return {
    track_id: track?.id ?? null,
    track: track ?? null,
    position_sec: override.position_sec ?? pb.currentTime ?? 0,
    is_playing: override.is_playing ?? pb.isPlaying,
    device_id: state.device.device_id,
    device_name: state.device.device_name,
    device_type: state.device.device_type,
  };
}

/** Publish this device's current playback to the engine so other devices can
 * offer to resume it. Best-effort: fire-and-forget, errors swallowed. */
function pushPlaybackState(opts: { keepalive?: boolean; body?: ReturnType<typeof playbackStateBody> } = {}): void {
  void api.putPlaybackState(opts.body ?? playbackStateBody(), { keepalive: opts.keepalive }).catch(() => {});
}

function pushEmptyPlaybackState(opts: { keepalive?: boolean } = {}): void {
  pushPlaybackState({ keepalive: opts.keepalive, body: playbackStateBody({ track: null, position_sec: 0, is_playing: false }) });
}

function invalidateLibrarySync(): void {
  librarySyncVersion += 1;
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
    cancelActiveAttempt('track_removed');
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
    updateMediaSession(null);
    pushEmptyPlaybackState();
  }
}

function restorePlaybackSnapshot(snapshot: PlaybackState): void {
  setState('playback', {
    ...snapshot,
    queue: snapshot.queue.slice(),
  });
  updateMediaSession(snapshot.currentTrack);
}

function restoreSameDevicePlayback(remote: RemotePlaybackState): void {
  const track = state.library.find((t) => t.id === remote.track_id) ?? remote.track ?? null;
  if (!track) return;
  const pos = Math.max(0, Number(remote.position_sec) || 0);
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
  updateMediaSession(track);
  audioService.prime(trackUrl(track), pos);
}

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

interface CommittedTransition {
  queueId: string;
  fromKey: string;
  toKey: string;
}
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
  const deck = audioEl();
  if (Number.isFinite(deck.duration) && deck.duration > 0) return deck.duration;
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
  const fulfilledRequestId = state.autoMode.plan[toKey]?.requestId;
  const token = ++commitSeq;
  const owns = () => commitSeq === token;
  committedTransition = { queueId: next.queueId, fromKey, toKey };
  setState('autoMode', 'transition', {
    status: 'armed',
    technique: plan.technique,
    nextTrackId: toKey,
    at: manual ? state.playback.currentTime : plan.out_cue,
  });
  audioService.armTransition(trackUrl(next), plan, {
    onDominant: () => {
      if (!owns()) return;
      if (!manual) listeningLearning.complete(outgoing, outgoingDuration);
      const queue = state.playback.queue;
      const index = queue.findIndex((entry) => entry.queueId === next.queueId);
      // The incoming deck is already audible; there is no undo. Follow it.
      activeAttempt = null;
      const deck = audioEl();
      setState('playback', {
        currentTrack: next,
        index: index === -1 ? state.playback.index : index,
        currentTime: deck.currentTime,
        duration: Number.isFinite(deck.duration) && deck.duration > 0 ? deck.duration : next.duration ?? 0,
        isPlaying: !deck.paused,
        isLoading: false,
        loadError: false,
        phase: 'playing',
      });
      setState('autoMode', 'transition', {
        status: 'mixing',
        technique: plan.technique,
        nextTrackId: toKey,
      });
      setState('autoMode', 'requests', (requests) =>
        requests.filter((request) => request.id !== fulfilledRequestId),
      );
      updateMediaSession(next);
      pushPlaybackState();
    },
    onComplete: (position) => {
      if (!owns()) return;
      committedTransition = null;
      setState('playback', { currentTime: position, duration: playingDuration() });
      setState('autoMode', 'transition', IDLE_TRANSITION);
      if (state.autoMode.active) void generatedQueue?.ensureRunway();
    },
    onCancel: () => {
      if (!owns()) return;
      committedTransition = null;
      setState('autoMode', 'transition', IDLE_TRANSITION);
    },
    onError: () => {
      if (!owns()) return;
      const index = state.playback.queue.findIndex((entry) => entry.queueId === next.queueId);
      committedTransition = null;
      setState('autoMode', 'transition', IDLE_TRANSITION);
      // The route stays intact; plain playback is the safe fallback.
      if (index > 0) loadIndex(index, { trigger: 'next' });
    },
  }, { manual });
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
  const item = state.autoMode.plan[toKey];
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
      if (state.autoMode.plan[toKey]?.fromKey !== fromKey) return;
      setState('autoMode', 'plan', toKey, 'transition', result.transition);
    })
    .catch(() => {
      /* the conservative plan stands */
    });
}

/** Watch the runway from `timeupdate` and commit when the moment arrives. */
function evaluateDjRunway(): void {
  if (!state.autoMode.active || committedTransition || audioService.mixPhase() !== 'idle') return;
  const pb = state.playback;
  const current = pb.currentTrack;
  const next = pb.queue[pb.index + 1];
  if (!current || !next || pb.loadError) return;
  const fromKey = queueIdentity(current);
  const plan = resolveTransition(fromKey, playingDuration(), state.autoMode.plan[queueIdentity(next)]);
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
  if (replanTimer) clearTimeout(replanTimer);
  setState('autoMode', {
    pendingDirection: true,
    // Answer the gesture immediately. Waiting out the debounce before saying
    // anything reads as a surface that ignored you.
    activity: {
      id: ++generatedActivityId,
      status: 'working',
      key: 'autoMode.agent.heard',
      values: { note },
    },
  });
  replanTimer = setTimeout(() => {
    replanTimer = null;
    setState('autoMode', 'pendingDirection', false);
    if (state.autoMode.active) void ensureGeneratedQueue().replan(state.autoMode.profile);
  }, REPLAN_DEBOUNCE_MS);
}

function cancelRunwayReplan(): void {
  if (replanTimer) clearTimeout(replanTimer);
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
  emitPlaybackEvent('ui_queue_starved', {
    lane_remaining: futureEntries(state.playback.queue, state.playback.index).length,
    auto_mode: state.autoMode.active,
    radio: state.playback.radioMode,
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
    void ensureAutoplay(true);
    void generatedQueue?.refillNow();
    return;
  }
  starvedQueueId = null;
  loadIndex(pb.index + 1, { trigger: 'ended' });
}

/** Inside the last minute of a track, a thin lane is refilled without waiting
 * for the track change that would otherwise have triggered it. */
const RUNWAY_LEAD_SECONDS = 60;
let runwayCheckedFor = '';

/**
 * Notice a lane running out before the music does.
 *
 * Refills used to be requested only when a track *started*. If the request that
 * followed a track change failed, nothing asked again until the next track
 * change — which, at the end of the lane, never came. Riding `timeupdate` costs
 * one comparison per event and gives a thin lane a whole minute of runway to be
 * filled in, retries included.
 */
function watchRunway(deck: HTMLAudioElement): void {
  const pb = state.playback;
  const duration = deck.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (duration - (deck.currentTime || 0) > RUNWAY_LEAD_SECONDS) return;
  const key = pb.queue[pb.index]?.queueId ?? '';
  if (!key || runwayCheckedFor === key) return;
  runwayCheckedFor = key;
  // Also re-stages: an entry that landed after this track started would not
  // otherwise be cued up on the idle deck in time to matter.
  stageNext();
  void ensureAutoplay();
  if (pb.radioMode || state.autoMode.active) void generatedQueue?.ensureRunway();
}

function onEnded(): void {
  // A committed handoff owns the end of this track: the mixer starts the blend
  // off the same moment, and advancing the queue here would cancel it.
  if (audioService.mixPhase() !== 'idle') return;
  const deck = audioEl();
  const duration = playingDuration();
  const position = deck.currentTime || 0;
  // The store's clock only advances while the page is awake, so after a spell
  // with the screen off it is stale. The element is the authority at this point.
  setState('playback', { currentTime: position, duration });
  const premature = duration > 0 && position < duration - PREMATURE_END_SECONDS;
  // Seconds, not milliseconds: the endpoint drops any `_ms` value over five
  // minutes, which a podcast duration passes comfortably.
  emitPlaybackEvent('ui_track_ended', {
    position_sec: Math.round(position),
    duration_sec: Math.round(duration),
    premature,
  });
  if (premature && recoverCurrent('stall')) {
    // A cut stream, not a finished song: reload and carry on from here rather
    // than skipping the rest of it.
    emitPlaybackEvent('ui_premature_end', { position_sec: Math.round(position) });
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
  listeningLearning.complete(pb.currentTrack, duration);
  if (pb.index < pb.queue.length - 1 || pb.repeat === 'all') {
    actions.next('ended');
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
    ? generatedQueue?.refillNow() ?? Promise.resolve(false)
    : ensureAutoplay(true);
  enterStarved();
  void extend.then((ready) => {
    const current = state.playback.queue[state.playback.index];
    if (state.playback.phase !== 'starved' || current?.queueId !== endedQueueId) return;
    if (continuousIntent && generatedQueue?.activeIntent() !== continuousIntent) return;
    if (ready && state.playback.index < state.playback.queue.length - 1) resumeFromStarved();
  });
}

/** Push a "just finished" entry to the recent strip and auto-expire it. */
function addRecentCompleted(entry: CompletedDownload): void {
  if (state.downloads.recent.some((r) => r.id === entry.id)) return;
  setState('downloads', 'recent', (r) => [entry, ...r].slice(0, 5));
  setTimeout(() => {
    setState('downloads', 'recent', (r) => r.filter((x) => x.id !== entry.id));
  }, 5000);
}

/** Merge one `downloader_update` socket payload into the live queue. Mirrors the
 * legacy `mergeDownloaderEvent`: completed items leave the queue; unknown ids are
 * appended (covers events that arrive before the initial seed). */
function applyDownloadEvent(detail: DownloadEvent): void {
  const { id, status, track, ...rest } = detail;
  if (!id) return;
  if (status === 'completed') {
    const finished = state.downloads.queue.find((i) => i.id === id);
    setState('downloads', 'queue', (q) => q.filter((i) => i.id !== id));
    addRecentCompleted({
      id,
      title: track?.title ?? finished?.display_title ?? finished?.podcast_title ?? tr('toast.trackFallback'),
      artist: track?.artist ?? finished?.display_artist ?? finished?.podcast_show_title ?? '',
    });
    // A completed download is emitted by the server *after* it has written the
    // new track to library.json (see shared/api/__init__.py), so the library is
    // already authoritative here. Refresh it directly instead of waiting on the
    // `library_updated` file-watcher event, which has a 2s debounce and can miss
    // or coalesce filesystem events — that lag is why a freshly downloaded track
    // wouldn't show up until the user re-entered the Library view. syncLibrary()
    // coalesces concurrent calls, so bulk (album) completions collapse safely.
    void actions.syncLibrary();
    return;
  }
  setState('downloads', 'queue', (q) => {
    const idx = q.findIndex((i) => i.id === id);
    if (idx === -1) return [...q, { id, status: status ?? 'pending', ...rest } as DownloadQueueItem];
    const next = q.slice();
    next[idx] = { ...next[idx], ...rest, status: status ?? next[idx].status };
    return next;
  });
}

/** Apply a playlist mutation response (authoritative playlists + settings). */
function applyPlaylistMutation(res: { playlists?: PlaylistMap; settings?: LibrarySettings }): void {
  if (res.playlists) setState('playlists', res.playlists);
  if (res.settings) setState('librarySettings', res.settings);
}

/** A saved song and the track it currently resolves to. */
export interface SavedRow {
  entry: SavedEntry;
  track: Track;
}

/**
 * The music library: every song you have, downloaded or streaming, podcast
 * episodes excluded. Reactive: call inside a tracking scope (e.g. createMemo).
 *
 * Every music browse surface (Library, Artist, Album) reads this rather than
 * `state.library`, so a song you saved without downloading is browsable exactly
 * like one you own the file for — which is the whole point of saving it.
 * Surfaces that genuinely mean "files on disk" (the downloader's duplicate
 * check, the metadata editor) keep reading `state.library` directly.
 */
export function musicLibrary(): Track[] {
  return identity.libraryTracks();
}

/** Reactive download tallies — call inside a tracking scope (createMemo). */
export function downloadCounts(): { active: number; failed: number } {
  let active = 0;
  let failed = 0;
  for (const i of state.downloads.queue) {
    if (i.status === 'failed' || i.status === 'interrupted') failed++;
    else active++;
  }
  return { active, failed };
}

/* ── Playback identity ──
 *
 * One definition of "this is the thing that is playing", shared by every
 * surface. See `lib/playbackIdentity.ts` for why identity is a set of keys and
 * not an id.
 *
 * Two derived values, and nothing else moves:
 *
 * - `libraryIndex` maps every key the library answers to → its track. Rebuilt
 *   only when `state.library` actually changes.
 * - `playingKeys` is the current track's keys *plus* the keys of its library
 *   twin, looked up through that index.
 *
 * That second union is what closes the download case. Finishing a download
 * emits `downloader_update`, which already calls `syncLibrary()`; the new
 * library array invalidates `libraryIndex`, which invalidates `playingKeys`,
 * which now contains the freshly minted `lib:` id — and the row in the library
 * lights up on its own. Socket event → store write → memo → one class toggle.
 * No polling, no extra request, no timer.
 */

/** Catalog row id → YouTube video id, learned when a row is resolved or saved.
 * The engine's search response cannot know this (the resolution happens after
 * the search), so a Deezer row you just downloaded would otherwise keep
 * offering "＋ add" until the query was run again. */
const [catalogLinks, setCatalogLinks] = createSignal<ReadonlyMap<string, string>>(new Map());

const identity = createRoot(() => {
  const libraryIndex = createMemo(() => buildIdentityIndex(state.library));
  const playingKeys = createMemo(() =>
    resolvePlayingKeys(state.playback.currentTrack, libraryIndex(), catalogLinks()),
  );
  // Queue membership has the same identity problem as the playing highlight: a
  // Deezer row already lined up must say so, whatever id the row holds.
  const queuedKeys = createMemo(() =>
    collectIdentityKeys(futureEntries(state.playback.queue, state.playback.index, 'manual')),
  );
  // Saved songs have the same identity problem, one hop further out: the row
  // you saved in Search, the preview that played, and the file you downloaded
  // are three ids for one song. Matching on keys is what makes every surface
  // agree about what you own without any of them knowing where the song lives.
  const savedKeys = createMemo(() => new Set(state.saved.flatMap((f) => f.keys)));
  // The mark is a strict subset — a property of a saved song, never a way of
  // holding one.
  const favouriteKeys = createMemo(
    () => new Set(state.saved.filter((f) => f.favourite).flatMap((f) => f.keys)),
  );
  // Each saved song as something playable: the owned track when we have it,
  // a streaming preview when we don't. Resolved here rather than at save time,
  // so a download promotes the entry with no write and no reordering. The entry
  // is kept alongside its track, because only the entry knows whether a source
  // has been attached to it yet — and whether it is marked.
  const savedRows = createMemo(() =>
    state.saved
      .map((entry) => ({ entry, track: savedToTrack(entry, libraryIndex()) }))
      .filter((row): row is SavedRow => !!row.track),
  );
  const favouriteRows = createMemo(() => savedRows().filter((row) => row.entry.favourite));
  /**
   * The library as the user thinks of it: everything they have claimed.
   *
   * Files first in the engine's own order, then the songs that have no file —
   * a save is the most recent thing that happened to the collection, and
   * `sortTracks` reverses this list for "recent", which floats them to the top
   * where the user just put them. A saved song that has since been downloaded
   * resolves to its library track and is dropped here rather than listed twice.
   */
  const libraryTracks = createMemo(() => {
    const files = state.library.filter(isMusicTrack);
    const streaming = savedRows()
      .filter((row) => row.track.source === 'preview' && isMusicTrack(row.track))
      .map((row) => row.track)
      .reverse();
    return streaming.length === 0 ? files : [...files, ...streaming];
  });
  // The marked subset that lives on disk, by library id — what the surfaces
  // that only speak library ids (sort, radio seeds, Auto Mode) already expect.
  const favouriteLibraryIds = createMemo(() => {
    const owned = new Set<string>();
    const index = libraryIndex();
    for (const entry of state.saved) {
      if (!entry.favourite) continue;
      for (const key of entry.keys) {
        const track = index.get(key);
        if (track) {
          owned.add(track.id);
          break;
        }
      }
    }
    return owned as ReadonlySet<string>;
  });
  return {
    libraryIndex,
    playingKeys,
    queuedKeys,
    savedKeys,
    savedRows,
    favouriteKeys,
    favouriteRows,
    libraryTracks,
    favouriteLibraryIds,
  };
});

/** Keys the playing track answers to. Reactive: read in a tracking scope. */
export const playingKeys = identity.playingKeys;

/** Does anything with these identity keys own the transport right now? */
export const isPlayingKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.playingKeys(), catalogLinks());

/** The row currently playing — whatever id the surface happens to hold. */
export const isPlayingTrack = (track: Track): boolean => isPlayingKeys(trackKeys(track));
export const isPlayingItem = (item: CatalogItem): boolean => isPlayingKeys(catalogItemKeys(item));
export const isPlayingResult = (result: SearchResult): boolean =>
  isPlayingKeys(searchResultKeys(result));
export const isPlayingEpisode = (episodeKey: string): boolean =>
  isPlayingKeys(podcastEpisodeKeys(episodeKey));

/** Is anything with these identity keys sitting in the playback queue? */
export const isQueuedKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.queuedKeys(), catalogLinks());

export const isQueuedTrack = (track: Track): boolean => isQueuedKeys(trackKeys(track));
export const isQueuedItem = (item: CatalogItem): boolean => isQueuedKeys(catalogItemKeys(item));
export const isQueuedResult = (result: SearchResult): boolean =>
  isQueuedKeys(searchResultKeys(result));

/** The library track this identity is owned as, if it is owned at all. */
export function ownedTrackForKeys(keys: string[]): Track | null {
  const index = identity.libraryIndex();
  for (const key of withLinkedKeys(keys, catalogLinks())) {
    const owned = index.get(key);
    if (owned) return owned;
  }
  return null;
}

export const ownedTrackForItem = (item: CatalogItem): Track | null =>
  ownedTrackForKeys(catalogItemKeys(item));
export const ownedTrackForResult = (result: SearchResult): Track | null =>
  ownedTrackForKeys(searchResultKeys(result));

/**
 * Is anything with these identities in the library?
 *
 * True for a downloaded song *and* for one saved without a file: owning the
 * bytes is one way to have a song, not the definition of having it. This is
 * what every surface asks before offering the heart — a song you have not
 * claimed cannot be marked out among the ones you have.
 */
export const isSavedKeys = (keys: string[]): boolean =>
  !!ownedTrackForKeys(keys) || keysMatch(keys, identity.savedKeys(), catalogLinks());

export const isSavedTrack = (track: Track): boolean => isSavedKeys(trackKeys(track));
export const isSavedItem = (item: CatalogItem): boolean => isSavedKeys(catalogItemKeys(item));
export const isSavedResult = (result: SearchResult): boolean =>
  isSavedKeys(searchResultKeys(result));

/** Is anything with these identities marked out among the songs you have? */
export const isFavouriteKeys = (keys: string[]): boolean =>
  keysMatch(keys, identity.favouriteKeys(), catalogLinks());

export const isFavouriteTrack = (track: Track): boolean => isFavouriteKeys(trackKeys(track));
export const isFavouriteItem = (item: CatalogItem): boolean =>
  isFavouriteKeys(catalogItemKeys(item));
export const isFavouriteResult = (result: SearchResult): boolean =>
  isFavouriteKeys(searchResultKeys(result));

/** Every saved song paired with the playable track it resolves to, newest
 * first. Owned tracks play their file; the rest stream. */
export const savedRows = identity.savedRows;

/** The marked subset of the same, in the same order. */
export const favouriteRows = identity.favouriteRows;

/** Every marked song as a playable track, newest first. */
export const favouriteTracks = (): Track[] => identity.favouriteRows().map((row) => row.track);

/** The saved entry behind these identities, if the library holds one. Used by
 * the surfaces that need to know *how* a song is held, not just whether. */
export function savedEntryForKeys(keys: string[]): SavedEntry | null {
  const all = withLinkedKeys(keys, catalogLinks());
  for (const entry of state.saved) {
    if (entry.keys.some((key) => all.includes(key))) return entry;
  }
  return null;
}

/** Is a download for this song in flight? Keyed off the video id, which is what
 * the downloader queue speaks — a failed or interrupted item is not in flight,
 * so its row offers the arrow again rather than spinning forever. */
export function isDownloadingKeys(keys: string[]): boolean {
  const videoIds = new Set(
    withLinkedKeys(keys, catalogLinks())
      .filter((key) => key.startsWith('yt:'))
      .map((key) => key.slice(3)),
  );
  if (!videoIds.size) return false;
  return state.downloads.queue.some(
    (item) =>
      !!item.video_id &&
      videoIds.has(item.video_id) &&
      item.status !== 'failed' &&
      item.status !== 'interrupted',
  );
}

export const isDownloadingTrack = (track: Track): boolean => isDownloadingKeys(trackKeys(track));

/** Library ids of the marked songs we hold a file for. */
export const favouriteLibraryIds = identity.favouriteLibraryIds;

export const actions = {
  async syncLibrary(): Promise<void> {
    if (librarySyncInFlight) {
      librarySyncPending = true;
      return;
    }
    librarySyncInFlight = true;
    const syncVersion = ++librarySyncVersion;
    setState('loading', true);
    try {
      const [lib, saved] = await Promise.all([
        api.getLibrary(),
        api.getSaved().catch(() => state.saved.slice()),
      ]);
      if (syncVersion !== librarySyncVersion) return;
      setState({
        library: lib.tracks ?? [],
        playlists: lib.playlists ?? {},
        librarySettings: lib.settings ?? {},
        podcastSubscriptions: lib.podcast_subscriptions ?? [],
        saved,
        libraryError: false,
      });
    } catch {
      // Offline or engine down — keep whatever we have, but stop claiming it is
      // the whole story. An empty list after a failed fetch is not an empty
      // library, and the view says so.
      if (syncVersion === librarySyncVersion) setState('libraryError', true);
    } finally {
      if (syncVersion === librarySyncVersion) {
        setState('loading', false);
        // Settled either way: success means the list is the library, failure is
        // reported through `libraryError`. Both are answers, so stop making
        // callers wait on a sync that is over.
        setState('libraryReady', true);
      }
      librarySyncInFlight = false;
      const runAgain = librarySyncPending;
      librarySyncPending = false;
      if (runAgain) queueMicrotask(() => void actions.syncLibrary());
    }
  },

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

  /** Enter the autonomous listening environment without changing the current
   * track or discarding any manually prepared queue. */
  enterAutoMode(): void {
    const current = state.playback.currentTrack;
    if (state.autoMode.active || (current && isPodcastTrack(current))) return;
    if (!current) {
      const localSeed = state.library.find((track) => !isPodcastTrack(track));
      if (localSeed) {
        actions.playTrack(localSeed);
        queueMicrotask(() => actions.enterAutoMode());
        return;
      }
      void api.getDiscoveryMusicFeed()
        .then((feed) => {
          const item = (feed.items ?? []).find((row) =>
            Boolean(row.track_id || row.external_ids?.youtube_id),
          );
          if (!item) throw new Error('no music seed');
          const owned = item.track_id
            ? state.library.find((track) => track.id === item.track_id)
            : null;
          const videoId = String(item.external_ids?.youtube_id ?? '');
          const seed: Track = owned ?? {
            id: videoId,
            title: item.title,
            artist: item.artist,
            album: item.album,
            duration: item.duration,
            cover: item.cover,
            source: 'preview',
          };
          actions.playTrack(seed);
          queueMicrotask(() => actions.enterAutoMode());
        })
        .catch(() => toast.error(tr('autoMode.noSeed')));
      return;
    }
    autoPlaybackPrefs = {
      shuffle: state.playback.shuffle,
      repeat: state.playback.repeat,
    };
    discardFutureAutoplay();
    cancelPendingRadio();
    // Take the wheel: the finite context is replaceable, explicit requests are
    // not. Keep the current occurrence plus every future manual request; Auto
    // owns only the generated tail behind them.
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
      phase: 'planning',
      activity: null,
      plan: {},
      transition: { status: 'idle' },
      pendingDirection: false,
    });
    // Normally a no-op — the graph was built at the session's first touch — but
    // it also covers a listener who reached Auto Mode without one (a keyboard
    // shortcut, a restored session) and resumes a context that was interrupted
    // while the app sat in the background.
    audioService.unlockAudio();
    void ensureGeneratedQueue().start('auto_mode', current, state.autoMode.profile);
  },

  /** Leave Auto while preserving playback and every track it prepared. */
  exitAutoMode(): void {
    cancelRunwayReplan();
    // A blend that is already sounding finishes on its own; cancelling it would
    // revive the faded-out song while the UI names the new one. Anything merely
    // prepared is dropped.
    if (audioService.mixPhase() !== 'crossfading') audioService.cancelMix('exit');
    generatedQueue?.stop('auto_mode');
    if (autoPlaybackPrefs) {
      setState('playback', {
        shuffle: autoPlaybackPrefs.shuffle,
        repeat: autoPlaybackPrefs.repeat,
      });
      autoPlaybackPrefs = null;
    }
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

  /** `note` is what the listener asked for, for the booth to repeat back: their
   * own words when they typed them, otherwise the control they moved. */
  setAutoDirection(direction: Partial<DjDirection>, note?: string): void {
    setState('autoMode', 'direction', (current) => ({ ...current, ...direction }));
    scheduleRunwayReplan(note ?? tr('autoMode.note.direction'));
  },

  /** Say something in the booth's voice without touching the route — used while
   * a spoken request is being looked up, and when nothing answers to the name. */
  reportAutoActivity(key: string, status: AutoActivity['status'], values?: Record<string, string | number>): void {
    if (!state.autoMode.active) return;
    setState('autoMode', 'activity', { id: ++generatedActivityId, status, key, values });
  },

  requestAutoTrack(track: Track): void {
    if (!state.autoMode.active || isPodcastTrack(track)) return;
    const duplicate = state.autoMode.requests.some((request) =>
      request.track ? queueIdentity(request.track) === queueIdentity(track) : false,
    );
    if (duplicate) return;
    const request: AutoRequest = {
      id: randomId(),
      kind: 'track',
      label: track.title,
      track,
      status: 'queued',
      etaTracks: null,
    };
    setState('autoMode', 'requests', (requests) => [...requests, request]);
    void api.emitDiscoveryEvent('music_requested_from_dj', {
      media_type: 'music_track',
      track_id: track.source === 'preview' ? undefined : track.id,
      youtube_id: track.youtube_id || (track.source === 'preview' ? track.id : undefined),
      title: track.title,
      artist: track.artist,
      album: track.album,
      source: 'auto_mode',
    }).catch(() => {});
    scheduleRunwayReplan(tr('autoMode.note.added', { title: track.title }));
  },

  requestAutoArtist(name: string): void {
    const artist = name.trim();
    if (!state.autoMode.active || !artist) return;
    const duplicate = state.autoMode.requests.some((request) =>
      request.kind === 'artist' && request.artist?.name.toLocaleLowerCase() === artist.toLocaleLowerCase(),
    );
    if (duplicate) return;
    const request: AutoRequest = {
      id: randomId(),
      kind: 'artist',
      label: artist,
      artist: { name: artist },
      status: 'queued',
      etaTracks: null,
    };
    setState('autoMode', 'requests', (requests) => [...requests, request]);
    void api.emitDiscoveryEvent('music_requested_from_dj', {
      media_type: 'music_track',
      title: '',
      artist,
      source: 'auto_mode',
    }).catch(() => {});
    scheduleRunwayReplan(tr('autoMode.note.added', { title: artist }));
  },

  cancelAutoRequest(id: string): void {
    const dropped = state.autoMode.requests.find((request) => request.id === id);
    setState('autoMode', 'requests', (requests) => requests.filter((request) => request.id !== id));
    scheduleRunwayReplan(
      dropped ? tr('autoMode.note.dropped', { title: dropped.label }) : tr('autoMode.note.direction'),
    );
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
      listeningLearning.skip(current, playingDuration());
      if (audioService.mixPhase() !== 'idle') {
        // A blend was already prepared for this exact pair: bring it forward.
        audioService.startMixNow();
      } else if (next && current) {
        const fromKey = queueIdentity(current);
        const item = state.autoMode.plan[queueIdentity(next)];
        const chained = item?.fromKey === fromKey ? item.transition : undefined;
        const trusted = (chained?.confidence ?? 0) >= TRUSTED_CONFIDENCE;
        commitTransition(next, fromKey, {
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
    discardFutureAutoplay();
    const isRadio = opts?.radio === true;
    if (!isRadio) cancelPendingRadio();
    if (!isRadio && state.autoMode.active) actions.exitAutoMode();
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
    loadIndex(i);
  },

  /** Play a single track (queue = just this track). */
  playTrack(track: Track): void {
    actions.playFrom([track], 0);
  },

  /** Play a list with shuffle on, starting from a random entry. */
  playShuffled(tracks: Track[], context?: PlaybackContextDescriptor): void {
    if (tracks.length === 0) return;
    actions.playFrom(shuffled(tracks), 0, { context, shuffled: true });
  },

  /** Play a podcast episode: queue = just this episode; stream via a minted token. */
  async playEpisode(ep: PodcastEpisode, showTitle?: string, feedId?: string): Promise<void> {
    if (state.autoMode.active) actions.exitAutoMode();
    discardFutureAutoplay();
    cancelPendingRadio();
    const track = podcastEpisodeToTrack(ep, showTitle, feedId);
    // Tapping the same episode again while its token is still being minted must
    // not mint a second one.
    const pb = state.playback;
    if (pb.currentTrack?.id === track.id && (pb.isLoading || pb.isPlaying)) return;
    userPlaybackStartedThisSession = true;
    const generation = beginLoad();
    const attempt = createPlaybackAttempt(track, generation, 'podcast');
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
    updateMediaSession(track);
    try {
      const { stream_token } = await api.podcastPeek(ep.enclosure_url);
      if (!stream_token) throw new Error('no token');
      await audioService.load(podcastStreamUrl(stream_token, attempt.id));
    } catch {
      onPlaybackFailed(generation, 'load');
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
      resumeFromStarved();
      return;
    }
    if (pb.isPlaying) {
      if (pb.phase === 'loading' || pb.phase === 'recovering') {
        cancelActiveAttempt('user_pause');
        setState('playback', { isPlaying: false, isLoading: false, phase: 'paused' });
      }
      audioService.pause();
    }
    else {
      const generation = beginLoad();
      const attempt = createPlaybackAttempt(pb.currentTrack, generation, 'resume');
      setState('playback', { isLoading: true, phase: 'loading' });
      void audioService.resume().catch(() => onPlaybackFailed(attempt.generation, 'load'));
    }
  },

  /** Re-request the current entry after a failure (transport retry button). */
  retryCurrent(): void {
    const pb = state.playback;
    if (!pb.currentTrack || pb.index < 0) return;
    consecutiveLoadFailures = 0;
    loadIndex(pb.index, { restart: true, trigger: 'retry' });
  },

  next(trigger: PlaybackTrigger = 'next'): void {
    // Every path out of here either loads a deck or does nothing; loading
    // cancels the mixer, which reports back and clears the DJ state itself.
    if (audioService.mixPhase() !== 'idle') audioService.cancelMix('load');
    const pb = state.playback;
    if (pb.queue.length === 0) return;
    if (pb.index < pb.queue.length - 1) loadIndex(pb.index + 1, { trigger });
    else if (pb.repeat === 'all') {
      const cycle = pb.queue.filter(
        (entry) => entry.queueLane !== 'manual' && entry.queueSource !== 'autoplay',
      );
      if (cycle.length > 0) {
        setState('playback', { queue: cycle, index: 0 });
        loadIndex(0, { trigger });
      }
    }
  },

  prev(): void {
    if (state.playback.currentTime > 3) {
      actions.seek(0);
      return;
    }
    const pb = state.playback;
    if (pb.index > 0) loadIndex(pb.index - 1);
    else actions.seek(0);
  },

  seek(t: number): void {
    audioService.seek(t);
    setState('playback', 'currentTime', Math.max(0, t));
    pushPlaybackState();
  },

  /** Jump to a specific entry in the current queue. */
  jumpTo(i: number): void {
    loadIndex(i);
  },

  // ── Queue management (client-side; the playback queue lives in the store) ──
  /** Append a track to the end of the queue (starts playback if idle). */
  enqueue(track: Track): void {
    if (state.playback.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    discardFutureAutoplay();
    const at = manualInsertIndex(state.playback.queue, insertionFloor(), 'last');
    const entry = createQueueEntry(track, 'manual', 'add_to_queue');
    setState('playback', 'queue', (q) => [...q.slice(0, at), entry, ...q.slice(at)]);
    toast.success(tr('toast.addedToQueue'));
    prefetchUpcoming();
  },

  /** Play a track right now WITHOUT discarding the queue: jumps to it if it is
   * already queued (cross-source: a preview and its downloaded twin match),
   * otherwise inserts it right after the current entry and plays it. The rest
   * of the queue keeps playing afterwards. */
  playNow(track: Track): void {
    const pb = state.playback;
    if (pb.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    if (pb.currentTrack && queueIndexOf([pb.currentTrack], track) === 0) {
      if (pb.isLoading || pb.isPlaying) return;
      if (pb.loadError) actions.retryCurrent();
      else void audioService.resume();
      return;
    }
    // Explicitly requested a different track to play now: cancel generators but
    // preserve the manual/context runway behind the interruption.
    discardFutureAutoplay();
    cancelPendingRadio();
    if (state.autoMode.active) actions.exitAutoMode();
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    const insertAt = pb.index + 1;
    const entry = createQueueEntry(track, 'manual', 'play_next');
    setState('playback', 'queue', (q) => [...q.slice(0, insertAt), entry, ...q.slice(insertAt)]);
    loadIndex(insertAt);
  },

  /** Insert a track right after the current one (starts playback if idle). */
  playNext(track: Track): void {
    const pb = state.playback;
    if (pb.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    discardFutureAutoplay();
    // Never in front of a handoff that is already loaded and cued.
    const at = insertionFloor() + 1;
    const entry = createQueueEntry(track, 'manual', 'play_next');
    setState('playback', 'queue', (q) => [...q.slice(0, at), entry, ...q.slice(at)]);
    toast.success(tr('toast.playNextConfirmed'));
    prefetchUpcoming();
  },

  /** Remove the queue entry at `i`, keeping playback coherent. */
  removeFromQueue(i: number): void {
    const pb = state.playback;
    if (i < 0 || i >= pb.queue.length) return;
    const next = pb.queue.filter((_, idx) => idx !== i);
    if (i === pb.index) {
      setState('playback', 'queue', next);
      if (next.length === 0) {
        cancelActiveAttempt('queue_empty');
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
        loadIndex(Math.min(i, next.length - 1));
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
    prefetchUpcoming();
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
    const to = insertionFloor() + 1;
    if (from <= pb.index || from === to || to > from) return;
    const queue = pb.queue.slice();
    const [entry] = queue.splice(from, 1);
    queue.splice(to, 0, entry);
    setState('playback', 'queue', queue);
    prefetchUpcoming();
  },

  /** Clear explicit upcoming requests without touching context or generators. */
  clearManualQueue(): void {
    const pb = state.playback;
    const queue = pb.queue.filter((entry, index) => index <= pb.index || entry.queueLane !== 'manual');
    setState('playback', 'queue', queue);
    prefetchUpcoming();
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
    loadIndex(at);
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
    const t = toast.loading(tr('toast.startingRadio'));
    discardFutureAutoplay();
    cancelPendingRadio();
    if (state.autoMode.active) actions.exitAutoMode();
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
    cancelPendingRadio();
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
    removeTrackReferences(id);
    try {
      await api.deleteTrack(id);
      await actions.syncLibrary();
      toast.success(tr('toast.trackDeleted'));
    } catch {
      setState({ library: prevLib, playlists: prevPlaylists });
      restorePlaybackSnapshot(prevPlayback);
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
    const prev = state.library;
    setState('library', (l) => l.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    if (state.playback.currentTrack?.id === id)
      setState('playback', 'currentTrack', (c) => (c ? { ...c, ...patch } : c));
    try {
      await api.updateTrackMetadata(id, meta);
      toast.success(tr('toast.dataUpdated'));
      return true;
    } catch {
      setState('library', prev);
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
    prefetchUpcoming();
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
    if (next !== 'off') discardFutureAutoplay();
    setState('playback', 'repeat', next);
    if (next === 'off') queueMicrotask(() => void ensureAutoplay());
  },

  async setAutoplayEnabled(enabled: boolean): Promise<boolean> {
    const previous = state.playback.autoplayEnabled;
    if (enabled === previous) return true;
    setState('playback', 'autoplayEnabled', enabled);
    if (enabled) queueMicrotask(() => void ensureAutoplay(true));
    else discardFutureAutoplay();
    try {
      await api.setAutoplayEnabled(enabled);
      return true;
    } catch {
      setState('playback', 'autoplayEnabled', previous);
      if (previous) queueMicrotask(() => void ensureAutoplay(true));
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
    setState('downloads', 'queue', (q) =>
      q.map((i) =>
        i.id === id
          ? { ...i, status: 'pending', progress_percent: null, error: undefined, error_message: undefined }
          : i,
      ),
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

  async rescanLibrary(): Promise<void> {
    try {
      await api.rescanLibrary();
    } catch {
      // Rescan may be unauthorized off trusted networks; fall through to a plain reload.
    }
    await actions.syncLibrary();
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

  async addToPlaylist(name: string, trackId: string): Promise<void> {
    if ((state.playlists[name] ?? []).includes(trackId)) {
      toast.info(tr('toast.alreadyInPlaylist'));
      return;
    }
    try {
      applyPlaylistMutation(await api.addTrackToPlaylist(name, trackId));
      const track = state.library.find((item) => item.id === trackId);
      if (track) {
        void api.emitDiscoveryEvent('music_added_to_playlist', {
          media_type: 'music_track',
          track_id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          youtube_id: track.youtube_id,
          playlist_name: name,
          source: 'library',
        }).catch(() => {});
      }
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
  /** On boot: if another device has recent playback and we're idle, offer to resume it. */
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
  /** Accept the resume offer: play that track here, seeking to its position. */
  resumeHere(): void {
    const r = resumeState();
    setResumeState(null);
    if (!r?.track_id) return;
    const track = state.library.find((t) => t.id === r.track_id) ?? r.track ?? null;
    if (!track) return;
    userPlaybackStartedThisSession = true;
    actions.playTrack(track);
    const pos = Number(r.position_sec) || 0;
    if (pos > 0) setTimeout(() => actions.seek(pos), 400);
  },
  /** Decline the resume offer and suppress it for 30 minutes. */
  dismissResume(): void {
    setResumeState(null);
    const now = Date.now();
    localStorage.setItem('resume_suppress_until', String(now + 30 * 60 * 1000));
    localStorage.setItem('resume_cooldown_at', String(now));
  },
};

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
    isCommitted: (entry) => committedTransition?.queueId === entry.queueId,
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
          context: generatedSession?.context.map(djItemRef),
          seed: seedBody,
          requests: state.autoMode.requests.map((request): DjRequestTarget | null => (
            request.kind === 'artist' && request.artist
              ? { id: request.id, kind: 'artist', label: request.label, artist: request.artist }
              : request.track
                ? { id: request.id, kind: 'track', label: request.label, track: request.track }
                : null
          )).filter((request): request is DjRequestTarget => request !== null),
          exclude,
          limit,
        }, signal);
      }
      return api.planMusicQueue({ intent, profile, seed: seedBody, exclude, limit }, signal);
    },
    applyPlan: (intent, response, replace, anchor) => {
      // What a replacing plan keeps: everything already played, every explicit
      // request, and the one handoff that is already loaded and cued.
      const held = replace
        ? futureEntries(state.playback.queue, state.playback.index).filter(
            (entry) => entry.queueLane === 'manual' || committedTransition?.queueId === entry.queueId,
          )
        : [];
      const retained = replace
        ? [...state.playback.queue.slice(0, state.playback.index + 1), ...held]
        : state.playback.queue;
      const candidates = response.items
        .map((item) => ({ item, track: planItemTrack(item) }))
        .filter(({ track }) => queueIndexOf(retained, track) === -1);
      if (candidates.length === 0) return 0;
      const entries = candidates.map(({ track }) => createQueueEntry(track, 'generated', intent));
      if (replace) {
        setState('playback', 'queue', [
          ...state.playback.queue.slice(0, state.playback.index + 1),
          ...held,
          ...entries,
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
        const accepted = new Set(candidates.map(({ item }) => item));
        for (const item of response.items) {
          if (!accepted.has(item)) {
            chained = false;
            continue;
          }
          const track = planItemTrack(item);
          const id = queueIdentity(track);
          plan[id] = {
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
            requestId: item.request_id,
          };
          previousKey = id;
          chained = true;
        }
        // The anchor is a track the route continues from, not one it chose, so
        // it has no plan entry of its own. Recording its reading is what lets
        // the booth show a BPM for the song that is actually playing when a
        // session starts from whatever the listener already had on.
        const seed = (response as Partial<DjPlanResponse>).seed_analysis;
        const anchorKey = queueIdentity(anchor);
        if (seed?.analysed && !plan[anchorKey]) {
          plan[anchorKey] = {
            trackId: anchorKey,
            source: 'local',
            reasonKey: 'autoMode.reason.library',
            fromKey: '',
            bpm: seed.bpm,
            key: seed.key,
          };
        }
        setState('autoMode', 'plan', plan);
        const djRequests = (response as Partial<DjPlanResponse>).requests;
        if (Array.isArray(djRequests)) {
          const statuses = new Map(djRequests.map((request) => [request.id, request]));
          setState('autoMode', 'requests', (requests) => requests.map((request) => (
            statuses.has(request.id)
              ? {
                  ...request,
                  status: statuses.get(request.id)?.status === 'failed' ? 'failed' : 'planned',
                  etaTracks: statuses.get(request.id)?.eta_tracks ?? null,
                  scheduledPosition: statuses.get(request.id)?.scheduled_position ?? null,
                  failureCode: statuses.get(request.id)?.failure_code ?? null,
                }
              : request
          )));
        }
      }
      prefetchUpcoming();
      // New runway. If the music ran out waiting for exactly this, start it
      // again — the plan arriving is the event, and nothing else is watching.
      if (entries.length > 0) {
        stageNext();
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
        setState('autoMode', { active: false, phase: 'idle', pendingDirection: false });
        return;
      }
      if (status === 'planning') {
        setState('autoMode', {
          active: true,
          phase: 'planning',
          activity: {
            id: ++generatedActivityId,
            status: 'working',
            key: replacing ? 'autoMode.agent.redrawing' : 'autoMode.agent.searching',
            values: replacing
              ? { note: replanNote }
              : { title: state.playback.currentTrack?.title ?? '' },
          },
        });
        return;
      }
      const counts = response?.pool_counts ?? { local: 0, related: 0, discovery: 0 };
      const degraded = status === 'degraded';
      setState('autoMode', {
        active: true,
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
            note: replanNote,
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
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a stored preference to the concrete dark/light tokens to apply. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

let systemMediaQuery: MediaQueryList | null = null;
let systemMediaListener: ((event: MediaQueryListEvent) => void) | null = null;
let systemVisibilityListener: (() => void) | null = null;

/** Keep following OS changes while the preference is `system`; detach otherwise. */
function syncSystemThemeListener(theme: Theme): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

  if (systemMediaQuery && systemMediaListener) {
    if (typeof systemMediaQuery.removeEventListener === 'function') {
      systemMediaQuery.removeEventListener('change', systemMediaListener);
    } else {
      // Safari < 14
      systemMediaQuery.removeListener(systemMediaListener);
    }
  }
  if (systemVisibilityListener) {
    document.removeEventListener('visibilitychange', systemVisibilityListener);
  }
  systemMediaQuery = null;
  systemMediaListener = null;
  systemVisibilityListener = null;

  if (theme !== 'system') return;

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  systemMediaListener = () => {
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'), true);
  };
  systemMediaQuery = mq;
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', systemMediaListener);
  } else {
    mq.addListener(systemMediaListener);
  }

  // Installed PWAs get frozen in the background, where a change event may be
  // dropped instead of queued. Re-reading the query on the way back to visible
  // catches an OS flip that happened while we were suspended; when nothing
  // changed, applyResolvedTheme is a no-op.
  systemVisibilityListener = () => {
    if (document.visibilityState !== 'visible') return;
    if (state.theme === 'system') applyResolvedTheme(resolveTheme('system'), true);
  };
  document.addEventListener('visibilitychange', systemVisibilityListener);
}

/** Keep in sync with --dur-short in tokens.css (plus a little slack). */
const THEME_TRANSITION_MS = 260;
let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null;

/** Paint the resolved theme and the mobile status-bar colour. `animate` arms the
 * `[data-theme-transition]` cross-fade in tokens.css; the boot paint leaves it off
 * so the first frame is never animated. */
function applyResolvedTheme(resolved: ResolvedTheme, animate = false): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme === resolved) return;

  if (animate) {
    root.dataset.themeTransition = '';
    // Flush styles so the transition rule is in effect *before* the tokens flip;
    // without it some engines coalesce both changes and skip the animation.
    void root.offsetWidth;
    if (themeTransitionTimer) clearTimeout(themeTransitionTimer);
    themeTransitionTimer = setTimeout(() => {
      delete root.dataset.themeTransition;
      themeTransitionTimer = null;
    }, THEME_TRANSITION_MS);
  }

  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f6f7' : '#0c0c0e');
}

/** Apply the theme to the document (token overrides live in tokens.css) and
 * sync the mobile status-bar colour. When `system`, follows prefers-color-scheme
 * and re-applies if the OS preference changes. */
export function applyTheme(theme: Theme, animate = false): void {
  applyResolvedTheme(resolveTheme(theme), animate);
  syncSystemThemeListener(theme);
}

let socket: AppSocket | null = null;
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
    if (state.playback.needsGesture) {
      setState('playback', 'needsGesture', false);
      void audioService.resume().catch(() => {});
    }
  };
  // Capture, so it runs ahead of the click handler that starts the first track.
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('touchend', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

export function initStore(): void {
  if (socket) return;

  installAudioUnlock();
  setGraphReporter((failure) => {
    emitPlaybackEvent(
      'ui_graph_state',
      { resumed: failure.resumed, position_sec: Math.round(failure.positionSec) },
      { failure_reason: failure.reason, context_state: failure.contextState, display_mode: displayMode() },
    );
    if (failure.resumed) return;
    setState('playback', { isPlaying: false, needsGesture: true });
    toast.error(tr('toast.audioNeedsGesture'));
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
          if (settings.autoplay_enabled) queueMicrotask(() => void ensureAutoplay());
          else discardFutureAutoplay();
        }
      })
      .catch(() => {});
  } catch {
    // Test doubles and older engines may not expose this setting yet.
  }

  /**
   * Bind a media listener to both decks, delivering only the active one's
   * events.
   *
   * Playback lives on whichever deck currently owns it, and a DJ handoff moves
   * that ownership without loading anything. Binding both decks and filtering
   * here is what lets the rest of the store keep treating playback as one
   * element: the deck being prepared underneath is silent to it, so no
   * transport flicker, no duplicate `ended`, no progress from a track the
   * listener is already leaving.
   */
  const a = { addEventListener: (type: string, handler: (event: Event) => void) => {
    onDeckEvent(type, (event: Event) => {
      if (!isActiveDeck(event.currentTarget)) return;
      handler(event);
    });
  } };
  a.addEventListener('play', () => {
    setState('playback', 'isPlaying', true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updatePositionState();
    pushPlaybackState();
  });
  a.addEventListener('pause', () => {
    clearStallTimer();
    if (state.playback.phase !== 'loading' && state.playback.phase !== 'recovering') {
      setState('playback', { isPlaying: false, isLoading: false, phase: 'paused' });
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    updatePositionState();
    pushPlaybackState();
  });
  a.addEventListener('ended', onEnded);
  a.addEventListener('error', () => {
    // `stop()` clears src, which some engines report as an error. Nothing is
    // loaded and nothing is expected to be — not a playback failure.
    const deck = audioEl();
    if (!deck.getAttribute('src') && !deck.currentSrc) return;
    onPlaybackFailed(loadGeneration, 'media_error');
  });
  // Buffering, both cold (nothing has sounded yet) and mid-track. Either way the
  // transport shows progress instead of a stuck play button.
  a.addEventListener('waiting', () => {
    if (!state.playback.currentTrack) return;
    const attempt = activeAttempt;
    if (attempt) {
      if (attempt.stallStartedAt === null) {
        attempt.stallStartedAt = performance.now();
        attempt.stallCount += 1;
      }
    }
    setState('playback', { isLoading: true, phase: 'buffering' });
    scheduleStallRecovery(attempt?.audibleAt == null ? STARTUP_RECOVERY_MS : STALL_RECOVERY_MS);
  });
  a.addEventListener('canplay', () => {
    // `canplay` can precede actual audio by a noticeable amount; `playing` is
    // the only event that closes the user's click-to-sound attempt.
  });
  // First 'playing' after a user-initiated load → click-to-sound latency.
  a.addEventListener('playing', () => {
    clearStallTimer();
    setState('playback', { isLoading: false, loadError: false, phase: 'playing' });
    consecutiveLoadFailures = 0;
    const attempt = activeAttempt;
    if (!attempt || state.playback.currentTrack?.id !== attempt.trackId) return;
    const now = performance.now();
    if (attempt.stallStartedAt !== null) {
      attempt.stallMs += Math.max(0, now - attempt.stallStartedAt);
      attempt.stallStartedAt = null;
    }
    if (attempt.audibleAt === null) {
      attempt.audibleAt = now;
      emitAttempt(attempt, 'ui_click_to_playing', 'playing', {
        click_to_playing_ms: Math.round(now - attempt.startedAt),
        stall_count: attempt.stallCount,
        stall_ms: Math.round(attempt.stallMs),
        recovery_count: attempt.recoveryCount,
      });
    } else if (attempt.recoveryCount > attempt.reportedRecoveryCount) {
      emitAttempt(attempt, 'ui_recovery_succeeded', 'playing', {
        stall_count: attempt.stallCount,
        stall_ms: Math.round(attempt.stallMs),
        recovery_count: attempt.recoveryCount,
      });
      attempt.reportedRecoveryCount = attempt.recoveryCount;
    }
  });
  a.addEventListener('timeupdate', () => {
    const deck = audioEl();
    const position = deck.currentTime || 0;
    setState('playback', 'currentTime', position);
    listeningLearning.update(state.playback.currentTrack, position, !deck.paused && !deck.ended);
    evaluateDjRunway();
    watchRunway(deck);
  });
  const setDur = () => {
    const duration = audioEl().duration;
    setState('playback', 'duration', Number.isFinite(duration) ? duration : 0);
    updatePositionState();
  };
  a.addEventListener('durationchange', setDur);
  a.addEventListener('loadedmetadata', setDur);
  // A seek from anywhere — our transport, the lock screen, a car button — has
  // to re-anchor the OS scrubber or it keeps counting from the old position.
  a.addEventListener('seeked', updatePositionState);
  a.addEventListener('ratechange', updatePositionState);
  let hiddenSince: number | null = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      return;
    }
    // Coming back from a freeze. The store's clock stopped where the page did,
    // so anything derived from it — the scrubber, the OS position, the DJ
    // runway — has been reading a position the music left behind long ago.
    const deck = audioEl();
    const position = deck.currentTime || 0;
    const drift = Math.abs(position - (state.playback.currentTime || 0));
    if (state.playback.currentTrack) {
      const duration = deck.duration;
      setState('playback', {
        currentTime: position,
        duration: Number.isFinite(duration) && duration > 0 ? duration : state.playback.duration,
        isPlaying: !deck.paused && !deck.ended,
      });
      updatePositionState();
      if (hiddenSince !== null && drift > 1) {
        emitPlaybackEvent('ui_visibility_resume', {
          hidden_sec: Math.round((Date.now() - hiddenSince) / 1000),
          drift_sec: Math.round(drift),
        });
      }
    }
    hiddenSince = null;
    // Whatever stopped while we were away gets one more chance now.
    resumeFromStarved();
    if (state.playback.phase === 'buffering') {
      const attempt = activeAttempt;
      scheduleStallRecovery(attempt?.audibleAt == null ? STARTUP_RECOVERY_MS : STALL_RECOVERY_MS);
    }
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => actions.togglePlay());
    ms.setActionHandler('pause', () => actions.togglePlay());
    ms.setActionHandler('nexttrack', () => {
      if (state.autoMode.active) void actions.autoSkip();
      else actions.next();
    });
    ms.setActionHandler('previoustrack', () => actions.prev());
    ms.setActionHandler('seekto', (d) => {
      if (typeof d.seekTime === 'number') actions.seek(d.seekTime);
    });
    // Skip buttons on headphones, watches and car stereos. `seekOffset` is what
    // the platform asks for when it has an opinion; `osSeekStep` is our answer
    // when it does not. Not every browser exposes these actions — hence the
    // guarded registration.
    const setOptionalHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Unsupported action: the platform simply won't offer that button.
      }
    };
    setOptionalHandler('seekbackward', (d) =>
      actions.seek(Math.max(0, state.playback.currentTime - (d.seekOffset ?? osSeekStep('backward')))),
    );
    setOptionalHandler('seekforward', (d) =>
      actions.seek(state.playback.currentTime + (d.seekOffset ?? osSeekStep('forward'))),
    );
  }

  socket = createSocket();
  socket.on('connect', () => {
    setState('online', true);
    socket!.emit('playback_register', state.device);
    void api.registerDevice(state.device).catch(() => {});
    void actions.loadDownloads(); // re-seed the queue after a (re)connect
    // The station is reachable again: if the music ran out while it was not,
    // this is the moment that ends the silence.
    resumeFromStarved();
  });
  socket.on('disconnect', () => setState('online', false));
  socket.on('library_updated', () => {
    void actions.syncLibrary();
    // Note: Debounced discover cache warming — when the library changes (new
    // saves, favourites, deletes) the top seeds may shift, so re-warm the
    // persistent related-mix cache in the background. The server picks its own
    // top seeds; this is fire-and-forget.
    if (_warmTimer) clearTimeout(_warmTimer);
    _warmTimer = setTimeout(() => { void api.warmDiscoverSeeds([]).catch(() => {}); }, 4000);
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
      if (Number.isFinite(pos) && pos > 0) setTimeout(() => actions.seek(pos), 400);
    } else if (state.playback.currentTrack) {
      void audioService.resume().catch(() => {});
    }
  });
  socket.on('playback_next_requested', () => actions.next());
  socket.on('playback_previous_requested', () => actions.prev());
  socket.on('playback_seek_requested', (data) => {
    const p = Number(data?.position_sec);
    if (Number.isFinite(p)) actions.seek(p);
  });

  // Keep the published position fresh so other devices resume near where we are.
  setInterval(() => {
    if (state.playback.currentTrack && state.playback.isPlaying) pushPlaybackState();
  }, 15000);

  const pushStateOnUnload = () => {
    if (!state.playback.currentTrack) return;
    const live = audioEl().currentTime;
    const position = Number.isFinite(live) ? live : state.playback.currentTime || 0;
    pushPlaybackState({
      keepalive: true,
      body: playbackStateBody({ position_sec: position, is_playing: false }),
    });
  };
  window.addEventListener('beforeunload', pushStateOnUnload);
  window.addEventListener('pagehide', pushStateOnUnload);

  void actions.syncLibrary().then(() => actions.checkResume());
  void actions.loadDownloads();
  // Warm the discovery feed so Search and Podcasts render cached rails instantly.
  void import('../lib/discover').then((m) => m.ensureDiscover());

  // Global keyboard shortcuts (desktop). The decision table lives in
  // lib/shortcuts so it can be tested without a DOM; the store only supplies
  // the context snapshot and the callbacks.
  if (typeof window !== 'undefined') {
    window.addEventListener(
      'keydown',
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
          nudgeVolume: (delta) => actions.setVolume(state.playback.volume + delta),
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
