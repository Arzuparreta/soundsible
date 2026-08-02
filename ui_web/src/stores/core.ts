/**
 * The store itself: shape, initial value, and the primitives every domain
 * module writes through.
 *
 * `index.ts` had grown to ~3,600 lines covering nine domains. Splitting it
 * starts here, because everything else needs `state`/`setState` and importing
 * them from the barrel would make every domain module circular.
 *
 * `setState` is exported to sibling store modules only — never to components,
 * which go through `actions`.
 */

import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';

import type {
  DeviceRegistration,
  DjDirection,
  DjProfile,
  RemotePlaybackState,
} from '../lib/api';
import { storedVolume } from '../lib/audio';
import type { AutoModeState, AutoProfile } from '../lib/generatedQueue';
import type { PlaybackQueueEntry } from '../lib/playbackQueue';
import { loadVisualPreferences, type InterfaceSize } from '../lib/visualPreferences';
import type {
  LibrarySettings,
  PlaylistMap,
  SavedEntry,
  Track,
} from '../types/music';
import type { PodcastSubscription } from '../types/podcast';
import type { CompletedDownload, DownloadQueueItem } from '../types/download';


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
  /** Play every song at a similar loudness. Account preference, but read from
   * localStorage at startup so the first track of a session is already levelled
   * rather than waiting on a round trip. */
  volumeLeveling: boolean;
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
export function randomId(): string {
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

/** Volume levelling, read synchronously so the first track of a session is
 * already levelled. The account is the source of truth and reconciles a moment
 * later in `initStore`; this mirror is what removes the startup race. */
export const VOLUME_LEVELING_KEY = 'volumeLeveling';

function loadVolumeLeveling(): boolean {
  return localStorage.getItem(VOLUME_LEVELING_KEY) !== 'off';
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
    volumeLeveling: loadVolumeLeveling(),
  },
  autoMode: {
    active: false,
    profile: initialAutoProfile(),
    djProfile: initialDjProfile(),
    direction: initialDjDirection(),
    sources: [],
    heard: [],
    avoidedIdentities: [],
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


/** Now-Playing sheet open state (UI-only). */
export { state, setState };

/** Now-Playing sheet open state (UI-only). */
export const [nowPlayingOpen, setNowPlayingOpen] = createSignal(false);

/** Cross-device resume candidate: another device's playback state we can pick up.
 * Set once on boot, cleared when the user accepts or dismisses it. */
export const [resumeState, setResumeState] = createSignal<RemotePlaybackState | null>(null);
