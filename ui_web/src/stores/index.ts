import { createStore } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { createSocket, type AppSocket } from '../lib/socket';
import { api, type DeviceRegistration } from '../lib/api';
import { audioEl, audioService } from '../lib/audio';
import { streamUrl, previewUrl, podcastStreamUrl, coverUrl } from '../lib/media';
import type { Track, PlaylistMap, LibrarySettings } from '../types/music';
import type { PodcastSubscription, PodcastEpisode } from '../types/podcast';

export type Theme = 'dark' | 'light';
export type RepeatMode = 'off' | 'all' | 'one';

export interface PlaybackState {
  currentTrack: Track | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  queue: Track[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export interface AppState {
  online: boolean;
  device: DeviceRegistration;
  theme: Theme;
  loading: boolean;
  library: Track[];
  favorites: string[];
  playlists: PlaylistMap;
  librarySettings: LibrarySettings;
  podcastSubscriptions: PodcastSubscription[];
  playback: PlaybackState;
}

function loadDevice(): DeviceRegistration {
  let id = localStorage.getItem('device_id');
  if (!id) {
    id = crypto.randomUUID();
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
  },
});

export { state };

/** Now-Playing sheet open state (UI-only). */
export const [nowPlayingOpen, setNowPlayingOpen] = createSignal(false);

function trackUrl(track: Track): string {
  return track.source === 'preview' ? previewUrl(track.id) : streamUrl(track.id);
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
  setState('playback', { currentTrack: track, index: i, isPlaying: true, currentTime: 0 });
  updateMediaSession(track);
  void audioService.load(trackUrl(track)).catch(() => setState('playback', 'isPlaying', false));
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

export const actions = {
  async syncLibrary(): Promise<void> {
    setState('loading', true);
    try {
      const [lib, favorites] = await Promise.all([
        api.getLibrary(),
        api.getFavourites().catch(() => state.favorites),
      ]);
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
      setState('loading', false);
    }
  },

  toggleFavourite(id: string): void {
    const prev = state.favorites.slice();
    const has = prev.includes(id);
    setState('favorites', has ? prev.filter((f) => f !== id) : [id, ...prev]); // optimistic
    api.toggleFavourite(id).catch(() => setState('favorites', prev)); // revert on failure
  },

  /** Play a list starting at index `i`; the list becomes the queue (next/prev work). */
  playFrom(tracks: Track[], i: number): void {
    setState('playback', 'queue', tracks.slice());
    loadIndex(i);
  },

  /** Play a single track (queue = just this track). */
  playTrack(track: Track): void {
    actions.playFrom([track], 0);
  },

  /** Play a podcast episode: queue = just this episode; stream via a minted token. */
  async playEpisode(ep: PodcastEpisode, showTitle?: string): Promise<void> {
    const track: Track = {
      id: ep.guid || ep.enclosure_url,
      title: ep.title,
      artist: showTitle ?? '',
      duration: ep.duration_sec,
      cover: ep.image,
      source: 'preview',
    };
    setState('playback', {
      currentTrack: track,
      queue: [track],
      index: 0,
      isPlaying: true,
      currentTime: 0,
      duration: 0,
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

  togglePlay(): void {
    if (!state.playback.currentTrack) return;
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
  },

  /** Jump to a specific entry in the current queue. */
  jumpTo(i: number): void {
    loadIndex(i);
  },

  toggleShuffle(): void {
    setState('playback', 'shuffle', !state.playback.shuffle);
  },

  cycleRepeat(): void {
    const next: RepeatMode = state.playback.repeat === 'off' ? 'all' : state.playback.repeat === 'all' ? 'one' : 'off';
    setState('playback', 'repeat', next);
  },

  async rescanLibrary(): Promise<void> {
    try {
      await api.rescanLibrary();
    } catch {
      // Rescan may be unauthorized off trusted networks; fall through to a plain reload.
    }
    await actions.syncLibrary();
  },

  setDeviceName(name: string): void {
    setState('device', 'device_name', name);
    localStorage.setItem('device_name', name);
  },

  setTheme(theme: Theme): void {
    setState('theme', theme);
    localStorage.setItem('theme', theme);
  },
};

let socket: AppSocket | null = null;

/** Single source of truth bootstrap: wires audio + engine events, Media Session,
 * and pulls the initial library. */
export function initStore(): void {
  if (socket) return;

  const a = audioEl();
  a.addEventListener('play', () => {
    setState('playback', 'isPlaying', true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  a.addEventListener('pause', () => {
    setState('playback', 'isPlaying', false);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  a.addEventListener('ended', onEnded);
  a.addEventListener('timeupdate', () => setState('playback', 'currentTime', a.currentTime || 0));
  const setDur = () => setState('playback', 'duration', Number.isFinite(a.duration) ? a.duration : 0);
  a.addEventListener('durationchange', setDur);
  a.addEventListener('loadedmetadata', setDur);

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => actions.togglePlay());
    ms.setActionHandler('pause', () => actions.togglePlay());
    ms.setActionHandler('nexttrack', () => actions.next());
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
  });
  socket.on('disconnect', () => setState('online', false));
  socket.on('library_updated', () => void actions.syncLibrary());

  void actions.syncLibrary();
}
