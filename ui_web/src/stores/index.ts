import { createStore } from 'solid-js/store';
import { createSignal } from 'solid-js';
import { createSocket, type AppSocket } from '../lib/socket';
import { api, type DeviceRegistration, type RemotePlaybackState } from '../lib/api';
import { audioEl, audioService } from '../lib/audio';
import { streamUrl, previewUrl, podcastStreamUrl, coverUrl, bustCovers } from '../lib/media';
import { toast } from '../lib/toast';
import { vibrate } from '../lib/haptics';
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
  downloads: DownloadsState;
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

/** Publish this device's current playback to the engine so other devices can
 * offer to resume it. Best-effort: fire-and-forget, errors swallowed. */
function pushPlaybackState(): void {
  const pb = state.playback;
  const track = pb.currentTrack;
  if (!track) return;
  void api
    .putPlaybackState({
      track_id: track.id,
      track,
      position_sec: pb.currentTime || 0,
      is_playing: pb.isPlaying,
      device_id: state.device.device_id,
      device_name: state.device.device_name,
      device_type: state.device.device_type,
    })
    .catch(() => {});
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
      title: track?.title ?? finished?.display_title ?? finished?.podcast_title ?? 'Pista',
      artist: track?.artist ?? finished?.display_artist ?? finished?.podcast_show_title ?? '',
    });
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
    vibrate();
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

  /** Play a list with shuffle on, starting from a random entry. */
  playShuffled(tracks: Track[]): void {
    if (tracks.length === 0) return;
    setState('playback', 'shuffle', true);
    actions.playFrom(tracks, Math.floor(Math.random() * tracks.length));
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

  /** Enqueue a podcast episode for download. */
  async downloadEpisode(ep: PodcastEpisode, sub: PodcastSubscription | null): Promise<void> {
    const t = toast.loading('Añadiendo a descargas…');
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
      t.update('success', 'Episodio en descargas');
    } catch {
      t.update('error', 'No se pudo descargar');
    }
  },

  togglePlay(): void {
    if (!state.playback.currentTrack) return;
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
    toast.success('Añadida a la cola');
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
    toast.success('Se reproducirá a continuación');
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
  },

  /** Clear upcoming tracks, keeping the one currently playing. */
  clearQueue(): void {
    const pb = state.playback;
    if (pb.currentTrack && pb.index >= 0) setState('playback', { queue: [pb.currentTrack], index: 0 });
    else setState('playback', { queue: [], index: -1 });
  },

  /** Start a radio station seeded from a track: plays it, then its YouTube mix. */
  async startRadio(seed: Track): Promise<void> {
    const t = toast.loading('Iniciando radio…');
    try {
      let ytId = seed.youtube_id ?? (seed.source === 'preview' ? seed.id : null);

      // For library tracks without a youtube_id, try to resolve one via search.
      if (!ytId && seed.source !== 'preview') {
        const query = `${seed.title} ${seed.artist}`.trim();
        if (query) {
          const found = await api.searchYouTube(query);
          if (found.length > 0 && found[0].id) {
            ytId = found[0].id;
          }
        }
      }

      if (!ytId) {
        t.update('error', 'No se encontró el video en YouTube para iniciar la radio');
        return;
      }

      const related = await api.relatedYouTube(ytId);
      const mix = related
        .filter((r) => r.id !== ytId)
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
      actions.playFrom([seed, ...mix], 0);
      void api.emitDiscoveryEvent('music_started_radio', {
        track_id: seed.source === 'preview' ? undefined : seed.id,
        title: seed.title,
        artist: seed.artist,
        album: seed.album,
        youtube_id: ytId,
        source: seed.source ?? 'library',
      }).catch(() => {});
      t.update('success', 'Radio iniciada');
    } catch {
      t.update('error', 'No se pudo iniciar la radio');
    }
  },

  /** Delete a track from the library (optimistic; reverts on failure). */
  async deleteTrack(id: string): Promise<void> {
    const prevLib = state.library;
    const prevFav = state.favorites;
    const prevPlaylists = state.playlists;
    setState('library', (l) => l.filter((t) => t.id !== id));
    setState('favorites', (f) => f.filter((x) => x !== id));
    setState(
      'playlists',
      Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.filter((x) => x !== id)])),
    );
    if (state.playback.currentTrack?.id === id) {
      audioService.pause();
      setState('playback', { currentTrack: null, index: -1, isPlaying: false, queue: [] });
    }
    try {
      await api.deleteTrack(id);
      toast.success('Pista eliminada');
    } catch {
      setState({ library: prevLib, favorites: prevFav, playlists: prevPlaylists });
      toast.error('No se pudo eliminar');
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
      toast.success('Datos actualizados');
      return true;
    } catch {
      setState('library', prev);
      toast.error('No se pudo actualizar');
      return false;
    }
  },

  async uploadTrackCover(id: string, file: File): Promise<void> {
    const t = toast.loading('Subiendo portada…');
    try {
      await api.uploadTrackCover(id, file);
      bustCovers();
      t.update('success', 'Portada actualizada');
    } catch {
      t.update('error', 'No se pudo subir la portada');
    }
  },

  async clearTrackCover(id: string): Promise<void> {
    try {
      await api.clearTrackCover(id);
      bustCovers();
      toast.success('Portada quitada');
    } catch {
      toast.error('No se pudo quitar la portada');
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
      toast.error('Ya existe una lista con ese nombre');
      return false;
    }
    try {
      applyPlaylistMutation(await api.createPlaylist(clean));
      toast.success('Lista creada');
      return true;
    } catch {
      toast.error('No se pudo crear la lista');
      return false;
    }
  },

  async deletePlaylist(name: string): Promise<void> {
    try {
      applyPlaylistMutation(await api.deletePlaylist(name));
      toast.success('Lista eliminada');
    } catch {
      toast.error('No se pudo eliminar la lista');
    }
  },

  async renamePlaylist(name: string, newName: string): Promise<boolean> {
    const clean = newName.trim();
    if (!clean || clean === name) return false;
    try {
      applyPlaylistMutation(await api.renamePlaylist(name, clean));
      toast.success('Lista renombrada');
      return true;
    } catch {
      toast.error('No se pudo renombrar (¿nombre repetido?)');
      return false;
    }
  },

  async duplicatePlaylist(name: string): Promise<void> {
    const ids = state.playlists[name] ?? [];
    let copy = `${name} (copia)`;
    let n = 2;
    while (state.playlists[copy]) copy = `${name} (copia ${n++})`;
    try {
      await api.createPlaylist(copy);
      applyPlaylistMutation(await api.setPlaylistTracks(copy, ids));
      toast.success('Lista duplicada');
    } catch {
      toast.error('No se pudo duplicar');
    }
  },

  async addToPlaylist(name: string, trackId: string): Promise<void> {
    if ((state.playlists[name] ?? []).includes(trackId)) {
      toast.info('Ya está en la lista');
      return;
    }
    try {
      applyPlaylistMutation(await api.addTrackToPlaylist(name, trackId));
      toast.success(`Añadida a «${name}»`);
    } catch {
      toast.error('No se pudo añadir a la lista');
    }
  },

  async removeFromPlaylist(name: string, trackId: string): Promise<void> {
    try {
      applyPlaylistMutation(await api.removeTrackFromPlaylist(name, trackId));
      toast.success('Quitada de la lista');
    } catch {
      toast.error('No se pudo quitar de la lista');
    }
  },

  async reorderPlaylists(order: string[]): Promise<void> {
    const prev = state.playlists;
    try {
      applyPlaylistMutation(await api.reorderPlaylists(order));
    } catch {
      setState('playlists', prev);
      toast.error('No se pudo reordenar');
    }
  },

  async setPlaylistCover(name: string, coverTrackId: string | null): Promise<void> {
    try {
      applyPlaylistMutation(await api.setPlaylistCover(name, coverTrackId));
      toast.success('Portada actualizada');
    } catch {
      toast.error('No se pudo cambiar la portada');
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
    if (state.playback.currentTrack) return;
    let remote: RemotePlaybackState | undefined;
    try {
      remote = await api.getPlaybackState(state.device.device_id);
    } catch {
      return;
    }
    if (!remote || !remote.track_id || state.playback.currentTrack) return;
    if (remote.device_id === state.device.device_id) return;
    const updatedAt = Number(remote.updated_at) || 0;
    if (updatedAt && Date.now() / 1000 - updatedAt > 24 * 3600) return; // stale (>24h)
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

/** Apply the theme to the document (token overrides live in tokens.css) and
 * sync the mobile status-bar colour. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f6f7' : '#0c0c0e');
}

let socket: AppSocket | null = null;

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
    void actions.loadDownloads(); // re-seed the queue after a (re)connect
  });
  socket.on('disconnect', () => setState('online', false));
  socket.on('library_updated', () => void actions.syncLibrary());
  socket.on('downloader_update', (data) => applyDownloadEvent((data ?? {}) as DownloadEvent));

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

  void actions.syncLibrary().then(() => actions.checkResume());
  void actions.loadDownloads();
  // Warm Discover so the first visit renders instantly (cache + background fetch).
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
      } else if (e.code === 'ArrowRight' && e.shiftKey) {
        actions.next();
      } else if (e.code === 'ArrowLeft' && e.shiftKey) {
        actions.prev();
      } else if (e.code === 'ArrowRight') {
        actions.seek(state.playback.currentTime + 5);
      } else if (e.code === 'ArrowLeft') {
        actions.seek(Math.max(0, state.playback.currentTime - 5));
      } else if (e.key === 'Escape' && nowPlayingOpen()) {
        setNowPlayingOpen(false);
      }
    });
  }
}
