import { createStore } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { createSocket, type AppSocket, dispatchDiscoverSeed } from '../lib/socket';
import { api, type DeviceRegistration, type RemotePlaybackState } from '../lib/api';
import { audioEl, audioService } from '../lib/audio';
import { streamUrl, previewUrl, podcastStreamUrl, coverUrl, bustCovers, playbackYoutubeId } from '../lib/media';
import { prefetchPreviews, upcomingPreviewIds } from '../lib/prefetch';
import { toast } from '../lib/toast';
import { vibrate } from '../lib/haptics';
import { isMusicTrack, isPodcastTrack, podcastEpisodeToTrack } from '../lib/track';
import { libraryTrackFor, queueIdentity, queueIndexOf, resultToTrack } from '../lib/queueDiscovery';
import { resolveTrackYoutubeId, relatedTracksFor } from '../lib/relatedDiscovery';
import { AutopilotController, type AutoCandidate, type AutoModeState, type AutoPlanItem, type AutoProfile } from '../lib/autopilot';
import { t as tr } from '../lib/i18n';
import type { Track, PlaylistMap, LibrarySettings } from '../types/music';
import type { PodcastSubscription, PodcastEpisode } from '../types/podcast';
import type { DownloadQueueItem, DownloadEvent, CompletedDownload } from '../types/download';

export type Theme = 'dark' | 'light';
export type RepeatMode = 'off' | 'all' | 'one';

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
  currentTime: number;
  duration: number;
  queue: Track[];
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
}

/** Read persisted volume without forcing the lazy <audio> element into existence. */
function initialVolume(): number {
  const raw = localStorage.getItem('volume');
  const v = raw == null ? 1 : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}

export interface AppState {
  online: boolean;
  device: DeviceRegistration;
  theme: Theme;
  haptics: boolean;
  loading: boolean;
  library: Track[];
  favorites: string[];
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

const [state, setState] = createStore<AppState>({
  online: false,
  device: loadDevice(),
  theme: (localStorage.getItem('theme') as Theme) ?? 'dark',
  haptics: localStorage.getItem('haptics') !== 'off',
  loading: false,
  library: [],
  favorites: [],
  playlists: {},
  librarySettings: {},
  podcastSubscriptions: [],
  playback: {
    currentTrack: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    queue: [],
    index: -1,
    shuffle: false,
    repeat: 'off',
    volume: initialVolume(),
    muted: false,
    radioMode: false,
    radioLoading: false,
    radioSeedId: null,
  },
  autoMode: {
    active: false,
    profile: initialAutoProfile(),
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
let autopilot: AutopilotController | null = null;
let autoPlaybackPrefs: { shuffle: boolean; repeat: RepeatMode } | null = null;
/** Manual upcoming tracks preserved as runway when Auto Mode takes over. */
const AUTO_KEEP_MANUAL_ON_ENTER = 2;

function trackUrl(track: Track): string {
  const previewId = playbackYoutubeId(track);
  return track.source === 'preview' && previewId ? previewUrl(previewId) : streamUrl(track.id);
}

/** Set when the user starts a track; consumed by the audio 'playing' event to
 * report click→sound latency (local-only telemetry, see play-timing route). */
let pendingPlayTiming: { trackId: string; preview: boolean; startedAt: number } | null = null;

/** Warm the tracks `actions.next` would reach so track changes start instantly.
 * Skipped in shuffle mode — the next pick is random, prefetch would guess wrong. */
function prefetchUpcoming(): void {
  const pb = state.playback;
  if (pb.shuffle) return;
  const ids = upcomingPreviewIds(pb.queue, pb.index, pb.repeat === 'all');
  if (ids.length > 0) prefetchPreviews(ids, { download: true });
}

function updateMediaSession(track: Track | null): void {
  if (!('mediaSession' in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  const art = track.cover ?? coverUrl(track.id);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    artwork: art ? [{ src: art, sizes: '512x512' }] : [],
  });
}

/** Load + play the queue entry at index `i`. Computes the stream URL by source. */
function loadIndex(i: number): void {
  const track = state.playback.queue[i];
  if (!track) return;
  userPlaybackStartedThisSession = true;
  setState('playback', { currentTrack: track, index: i, isPlaying: true, currentTime: 0 });
  updateMediaSession(track);
  pendingPlayTiming = {
    trackId: track.id,
    preview: track.source === 'preview',
    startedAt: performance.now(),
  };
  void audioService.load(trackUrl(track)).catch(() => setState('playback', 'isPlaying', false));
  prefetchUpcoming();
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
  setState('favorites', (f) => f.filter((x) => x !== id));
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
    audioService.pause();
    setState('playback', {
      currentTrack: null,
      isPlaying: false,
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
    currentTime: pos,
    duration: track.duration ?? 0,
    queue: [track],
    index: 0,
  });
  updateMediaSession(track);
  audioService.prime(trackUrl(track), pos);
}

function onEnded(): void {
  const pb = state.playback;
  if (pb.repeat === 'one') {
    audioService.seek(0);
    void audioService.resume().catch(() => {});
    return;
  }
  if (pb.shuffle || pb.index < pb.queue.length - 1 || pb.repeat === 'all') actions.next();
  else setState('playback', 'isPlaying', false);
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

/** Library tracks that are music — podcast episodes excluded. Reactive: call
 * inside a tracking scope (e.g. createMemo). Music browse surfaces (Library,
 * Favourites, Artist) use this so downloaded podcasts don't pollute them. */
export function musicLibrary(): Track[] {
  return state.library.filter(isMusicTrack);
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
      const [lib, favorites] = await Promise.all([
        api.getLibrary(),
        api.getFavourites().catch(() => state.favorites),
      ]);
      if (syncVersion !== librarySyncVersion) return;
      setState({
        library: lib.tracks ?? [],
        playlists: lib.playlists ?? {},
        librarySettings: lib.settings ?? {},
        podcastSubscriptions: lib.podcast_subscriptions ?? [],
        favorites,
      });
    } catch {
      // Offline or engine down — keep whatever we have.
    } finally {
      if (syncVersion === librarySyncVersion) setState('loading', false);
      librarySyncInFlight = false;
      const runAgain = librarySyncPending;
      librarySyncPending = false;
      if (runAgain) queueMicrotask(() => void actions.syncLibrary());
    }
  },

  toggleFavourite(id: string): void {
    vibrate();
    const prev = state.favorites.slice();
    const has = prev.includes(id);
    setState('favorites', has ? prev.filter((f) => f !== id) : [id, ...prev]); // optimistic
    api.toggleFavourite(id).catch(() => setState('favorites', prev)); // revert on failure
  },

  /** Enter the autonomous listening environment without changing the current
   * track or discarding any manually prepared queue. */
  enterAutoMode(): void {
    const current = state.playback.currentTrack;
    if (!current || isPodcastTrack(current) || state.autoMode.active) return;
    autoPlaybackPrefs = {
      shuffle: state.playback.shuffle,
      repeat: state.playback.repeat,
    };
    // Take the wheel: keep the current track and the next couple of manual
    // entries as runway, then let the pilot plan the rest. Without this trim a
    // long album/playlist/radio queue kept Auto idling in `following_queue`
    // for the whole session — the queue looked untouched and switching profile
    // did nothing. Adopt a running radio queue without invoking stopRadio(),
    // whose contract intentionally truncates it to the seed.
    const keepUntil = state.playback.index + 1 + AUTO_KEEP_MANUAL_ON_ENTER;
    setState('playback', {
      shuffle: false,
      repeat: 'off',
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
      queue: state.playback.queue.slice(0, keepUntil),
    });
    ensureAutopilot().start();
  },

  /** Leave Auto while preserving playback and every track it prepared. */
  exitAutoMode(): void {
    autopilot?.stop();
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
    ensureAutopilot().setProfile(profile);
  },

  async autoSkip(): Promise<void> {
    const canAdvance = () => state.playback.index < state.playback.queue.length - 1;
    if (canAdvance()) {
      void autopilot?.skipCurrent();
      actions.next();
      return;
    }
    await autopilot?.skipCurrent();
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

  /** Play a list starting at index `i`; the list becomes the queue (next/prev work).
   * Pass `{ radio: true }` when the queue is the seed-only radio placeholder so
   * `radioMode`/`radioSeedId` are set; `radioLoading` is preserved (the caller
   * manages it through the async mix resolution). Without `radio`, all radio
   * flags are reset — `playTrack`/`playShuffled`/external callers therefore
   * cancel any active radio session. */
  playFrom(tracks: Track[], i: number, opts?: { radio?: boolean }): void {
    if (state.autoMode.active && tracks[i] && isPodcastTrack(tracks[i])) actions.exitAutoMode();
    const isRadio = opts?.radio === true;
    setState('playback', {
      queue: tracks.slice(),
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
  playShuffled(tracks: Track[]): void {
    if (tracks.length === 0) return;
    setState('playback', 'shuffle', true);
    actions.playFrom(tracks, Math.floor(Math.random() * tracks.length));
  },

  /** Play a podcast episode: queue = just this episode; stream via a minted token. */
  async playEpisode(ep: PodcastEpisode, showTitle?: string): Promise<void> {
    if (state.autoMode.active) actions.exitAutoMode();
    const track = podcastEpisodeToTrack(ep, showTitle);
    userPlaybackStartedThisSession = true;
    setState('playback', {
      currentTrack: track,
      queue: [track],
      index: 0,
      isPlaying: true,
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
      await audioService.load(podcastStreamUrl(stream_token));
    } catch {
      setState('playback', 'isPlaying', false);
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
    if (!state.playback.currentTrack) return;
    userPlaybackStartedThisSession = true;
    vibrate();
    if (state.playback.isPlaying) audioService.pause();
    else void audioService.resume().catch(() => {});
  },

  next(): void {
    const pb = state.playback;
    if (pb.queue.length === 0) return;
    if (pb.shuffle && pb.queue.length > 1) {
      let r = pb.index;
      while (r === pb.index) r = Math.floor(Math.random() * pb.queue.length);
      loadIndex(r);
      return;
    }
    if (pb.index < pb.queue.length - 1) loadIndex(pb.index + 1);
    else if (pb.repeat === 'all') loadIndex(0);
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
    setState('playback', 'queue', (q) => [...q, track]);
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
    // Explicitly requested a different track to play now: cancels any active radio.
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
    });
    const at = queueIndexOf(pb.queue, track);
    if (at !== -1) {
      loadIndex(at);
      return;
    }
    const insertAt = pb.index + 1;
    setState('playback', 'queue', (q) => [...q.slice(0, insertAt), track, ...q.slice(insertAt)]);
    loadIndex(insertAt);
  },

  /** Insert a track right after the current one (starts playback if idle). */
  playNext(track: Track): void {
    const pb = state.playback;
    if (pb.queue.length === 0) {
      actions.playTrack(track);
      return;
    }
    const at = pb.index + 1;
    setState('playback', 'queue', (q) => [...q.slice(0, at), track, ...q.slice(at)]);
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
        audioService.pause();
        setState('playback', { currentTrack: null, index: -1, isPlaying: false });
      } else {
        loadIndex(Math.min(i, next.length - 1));
      }
      return;
    }
    setState('playback', 'queue', next);
    if (i < pb.index) setState('playback', 'index', pb.index - 1);
  },

  /** Reorder a queue entry, tracking the current index across the move. */
  moveInQueue(from: number, to: number): void {
    const pb = state.playback;
    if (from === to || from < 0 || to < 0 || from >= pb.queue.length || to >= pb.queue.length) return;
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

  /** Clear upcoming tracks, keeping the one currently playing. */
  clearQueue(): void {
    const pb = state.playback;
    if (pb.currentTrack && pb.index >= 0) setState('playback', { queue: [pb.currentTrack], index: 0 });
    else setState('playback', { queue: [], index: -1 });
  },

  /** Start a radio station seeded from a track: plays it, then its YouTube mix.
   * The mix is generated asynchronously — to keep click→sound latency at zero,
   * we activate `radioMode` immediately and swap audio only when the seed
   * isn't already playing. See `stopRadio` for the manual exit path.
   *
   * Continuity semantics:
   * - If the seed is the currentTrack AND it's currently playing, we DON'T
   *   reload audio — A keeps playing and the mix appends behind it. When A
   *   finishes, the next mix track (different from A) plays.
   * - Otherwise (seed differs from currentTrack, or nothing playing), we
   *   swap to the seed immediately. The mix loads behind it.
   * - If the async mix generation fails, we show a toast and exit radio mode;
   *   the current track keeps playing and the queue is truncated to it.
   */
  async startRadio(seed: Track): Promise<void> {
    // Podcast episodes have no meaningful YouTube mix; the seed id is a guid.
    if (isPodcastTrack(seed)) {
      toast.error(tr('toast.radioUnavailable'));
      return;
    }
    const t = toast.loading(tr('toast.startingRadio'));

    // Resolve a youtube_id up front. This step CAN block (search round-trip
    // for library tracks without a stored id) — but it has to happen before we
    // can meaningfully claim "radio starting", so we keep it before the
    // radioMode activation.
    let ytId: string | null = null;
    try {
      ytId = await resolveTrackYoutubeId(seed);
      if (!ytId) {
        t.update('error', tr('toast.noYtForRadio'));
        return;
      }
    } catch (err) {
      console.error('[startRadio] ytId resolve error', err, 'seed:', seed.id, seed.youtube_id);
      t.update('error', tr('toast.radioFailed', { ytId: seed.youtube_id || tr('toast.radioFailedFallback') }));
      return;
    }

    // Activate radio mode immediately. The badge lights up before the mix lands.
    setState('playback', {
      radioMode: true,
      radioLoading: true,
      radioSeedId: seed.id,
    });

    // Decide the playback branch BEFORE doing the async work.
    const isCurrentPlaying =
      state.playback.currentTrack?.id === seed.id && state.playback.isPlaying;

    if (isCurrentPlaying) {
      // Bug 2 fix: A is already playing the seed. Keep audio running; queue
      // the seed as the only entry for now. The mix will be appended after.
      setState('playback', {
        queue: [seed],
        index: 0,
        // currentTrack/isPlaying/currentTime intentionally NOT patched.
      });
    } else {
      // General case (B playing, start radio of C; or nothing playing): swap
      // to the seed immediately so the user hears it now. The mix loads behind.
      actions.playFrom([seed], 0, { radio: true });
    }

    try {
      const related = await api.relatedYouTube(ytId, undefined, false);
      const mix = related
        .filter((r) => r.id !== ytId && (isCurrentPlaying || r.id !== seed.id))
        .map(
          (r): Track => ({
            id: r.id,
            title: r.title,
            artist: r.channel ?? '',
            duration: r.duration,
            cover: r.thumbnail,
            source: 'preview',
          }),
        );
      if (mix.length === 0) {
        throw new Error('noRelatedMix');
      }
      // Append the mix after the seed (which is now queue[0]). Don't touch
      // index/currentTrack/currentTime — playback continues seamlessly.
      setState('playback', 'queue', (q) => [...q, ...mix]);
      prefetchUpcoming();
      void api.emitDiscoveryEvent('music_started_radio', {
        track_id: seed.source === 'preview' ? undefined : seed.id,
        title: seed.title,
        artist: seed.artist,
        album: seed.album,
        youtube_id: ytId,
        source: seed.source ?? 'library',
      }).catch(() => {});
      t.update('success', tr('toast.radioStarted'));
    } catch (err) {
      console.error('[startRadio] mix generation error', err, 'seed:', seed.id, seed.youtube_id);
      t.update('error', tr('toast.radioFailed', { ytId: seed.youtube_id || tr('toast.radioFailedFallback') }));
      // Rollback: exit radio mode. Truncate queue to whatever is currently
      // playing (the seed in both branches; A in the Bug 2 branch).
      const cur = state.playback.currentTrack;
      setState('playback', {
        radioMode: false,
        radioLoading: false,
        radioSeedId: null,
        queue: cur ? [cur] : [],
        index: cur ? 0 : -1,
      });
    } finally {
      setState('playback', 'radioLoading', false);
    }
  },

  /** Stop the active radio session. The current track keeps playing, but the
   * rest of the pending mix is dropped from the queue. Invoked from the radio
   * badge popup in the player. */
  stopRadio(): void {
    const cur = state.playback.currentTrack;
    setState('playback', {
      radioMode: false,
      radioLoading: false,
      radioSeedId: null,
      queue: cur ? [cur] : [],
      index: cur ? 0 : -1,
    });
  },

  /** Delete a track from the library (optimistic; reverts on failure). */
  async deleteTrack(id: string): Promise<void> {
    const prevLib = state.library.slice();
    const prevFav = state.favorites.slice();
    const prevPlaylists = Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.slice()]));
    const prevPlayback = { ...state.playback, queue: state.playback.queue.slice() };
    invalidateLibrarySync();
    removeTrackReferences(id);
    try {
      await api.deleteTrack(id);
      await actions.syncLibrary();
      toast.success(tr('toast.trackDeleted'));
    } catch {
      setState({ library: prevLib, favorites: prevFav, playlists: prevPlaylists });
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
    setState('playback', 'shuffle', !state.playback.shuffle);
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
    setState('playback', 'repeat', next);
  },

  // ── Downloads ──
  /** Enqueue a preview track for download into the library. */
  async downloadTrack(track: Track): Promise<void> {
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
        source: 'now_playing',
        youtube_id: track.id,
      }).catch(() => {});
      t.update('success', tr('toast.addedToDownloads'));
    } catch {
      t.update('error', tr('toast.addToDownloadsFailed'));
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
    applyTheme(theme);
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

function ensureAutopilot(): AutopilotController {
  if (autopilot) return autopilot;
  autopilot = new AutopilotController(
    {
      snapshot: () => ({
        currentTrack: state.playback.currentTrack,
        queue: state.playback.queue.slice(),
        index: state.playback.index,
        library: state.library.filter(isMusicTrack),
        favorites: state.favorites.slice(),
      }),
      patchState: (patch) => setState('autoMode', patch),
      append: (candidates) => {
        const plan = { ...state.autoMode.plan };
        const accepted = candidates.filter((candidate) => queueIndexOf(state.playback.queue, candidate.track) === -1);
        for (const candidate of accepted) {
          const id = queueIdentity(candidate.track);
          plan[id] = {
            trackId: id,
            source: candidate.source,
            reasonKey: candidate.reasonKey,
            reasonValues: candidate.reasonValues,
          };
        }
        setState('playback', 'queue', (queue) => [...queue, ...accepted.map((candidate) => candidate.track)]);
        setState('autoMode', 'plan', plan);
        prefetchUpcoming();
        return accepted;
      },
      replaceUpcoming: (candidates) => {
        const prefix = state.playback.queue.slice(0, state.playback.index + 1);
        const prefixIds = new Set(prefix.map(queueIdentity));
        const accepted = candidates.filter((candidate) => !prefixIds.has(queueIdentity(candidate.track)));
        const plan: Record<string, AutoPlanItem> = {};
        for (const candidate of accepted) {
          const id = queueIdentity(candidate.track);
          plan[id] = {
            trackId: id,
            source: candidate.source,
            reasonKey: candidate.reasonKey,
            reasonValues: candidate.reasonValues,
          };
        }
        setState('playback', 'queue', [...prefix, ...accepted.map((candidate) => candidate.track)]);
        setState('autoMode', 'plan', plan);
        prefetchUpcoming();
        return accepted;
      },
      getRelated: async (track, signal) => (await relatedTracksFor(track, state.library.filter(isMusicTrack), signal)).tracks,
      getNodeCandidates: async () => {
        const nodes = await import('../lib/nodeDiscover');
        const feed = await nodes.ensureNodeFeedReady();
        const library = state.library.filter(isMusicTrack);
        return feed.map((rec): AutoCandidate => ({
          track: libraryTrackFor(library, rec) ?? resultToTrack(rec),
          source: 'node',
          reasonKey: rec.seedArtist ? 'autoMode.reason.nodeArtist' : 'autoMode.reason.node',
          reasonValues: rec.seedArtist ? { artist: rec.seedArtist } : undefined,
        }));
      },
      getChartCandidates: async (signal) => {
        const pools = await import('../lib/discoveryPools');
        return excludeOwned(await pools.chartCandidates(6, signal));
      },
      getArtistCandidates: async (track, signal) => {
        const pools = await import('../lib/discoveryPools');
        return excludeOwned(await pools.artistCandidates(track, 6, signal));
      },
    },
    state.autoMode.profile,
  );
  return autopilot;
}

/** Drop catalog-resolved candidates the listener already owns: Auto's discovery
 * pools should surface music that is *not* in the library. */
function excludeOwned(candidates: AutoCandidate[]): AutoCandidate[] {
  const owned = new Set<string>();
  for (const track of state.library) {
    owned.add(track.id);
    if (track.youtube_id) owned.add(track.youtube_id);
  }
  return candidates.filter((candidate) => !owned.has(candidate.track.id));
}

/** Apply the theme to the document (token overrides live in tokens.css) and
 * sync the mobile status-bar colour. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f6f7' : '#0c0c0e');
}

let socket: AppSocket | null = null;
let _warmTimer: ReturnType<typeof setTimeout> | null = null;

/** Single source of truth bootstrap: wires audio + engine events, Media Session,
 * and pulls the initial library. */
export function initStore(): void {
  if (socket) return;

  applyTheme(state.theme);

  const a = audioEl();
  a.addEventListener('play', () => {
    setState('playback', 'isPlaying', true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    pushPlaybackState();
  });
  a.addEventListener('pause', () => {
    setState('playback', 'isPlaying', false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    pushPlaybackState();
  });
  a.addEventListener('ended', onEnded);
  a.addEventListener('error', () => {
    if (state.autoMode.active) void actions.autoSkip();
  });
  // First 'playing' after a user-initiated load → click-to-sound latency.
  a.addEventListener('playing', () => {
    const timing = pendingPlayTiming;
    if (!timing || state.playback.currentTrack?.id !== timing.trackId) return;
    pendingPlayTiming = null;
    void api
      .sendPlayTiming({
        track_id: timing.trackId,
        device_id: state.device.device_id,
        phase: 'ui_click_to_playing',
        segments: {
          click_to_playing_ms: Math.round(performance.now() - timing.startedAt),
          preview: timing.preview,
        },
      })
      .catch(() => {});
  });
  a.addEventListener('timeupdate', () => setState('playback', 'currentTime', a.currentTime || 0));
  const setDur = () => setState('playback', 'duration', Number.isFinite(a.duration) ? a.duration : 0);
  a.addEventListener('durationchange', setDur);
  a.addEventListener('loadedmetadata', setDur);

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
  }

  socket = createSocket();
  socket.on('connect', () => {
    setState('online', true);
    socket!.emit('playback_register', state.device);
    void api.registerDevice(state.device).catch(() => {});
    void actions.loadDownloads(); // re-seed the queue after a (re)connect
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
    const position = Number.isFinite(a.currentTime) ? a.currentTime : state.playback.currentTime || 0;
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

  // Global keyboard shortcuts (desktop): space = play/pause, arrows = seek,
  // shift+arrows = prev/next, Escape closes the Now Playing sheet.
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        actions.togglePlay();
      } else if (e.key === 'Escape' && state.autoMode.active) {
        actions.exitAutoMode();
      } else if (e.code === 'ArrowRight' && e.shiftKey) {
        if (state.autoMode.active) void actions.autoSkip();
        else actions.next();
      } else if (e.code === 'ArrowLeft' && e.shiftKey) {
        actions.prev();
      } else if (e.code === 'ArrowRight') {
        actions.seek(state.playback.currentTime + 5);
      } else if (e.code === 'ArrowLeft') {
        actions.seek(Math.max(0, state.playback.currentTime - 5));
      } else if (e.key.toLowerCase() === 'a' && nowPlayingOpen() && state.playback.currentTrack && !isPodcastTrack(state.playback.currentTrack)) {
        if (state.autoMode.active) actions.exitAutoMode();
        else actions.enterAutoMode();
      } else if (e.key === 'Escape' && nowPlayingOpen()) {
        setNowPlayingOpen(false);
      }
    });
  }
}
