import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api, type LibraryScanStatus } from "../lib/api";
import { bustCovers } from "../lib/media";
import { toast } from "../lib/toast";
import { vibrate } from "../lib/haptics";
import { savedFromTrack, savedVideoId } from "../lib/saved";
import { t as tr } from "../lib/i18n";
import type { Track, SavedEntry } from "../types/music";
import { beginLibraryEdit, endLibraryEdit, syncLibrary, syncLibrarySoon } from "./library";
import { claimedAddedAt, isFavouriteKeys, isSavedKeys, ownedTrackForKeys, savedEntryForKeys, setCatalogLinks } from "./identity";
import { state, setState, type PlaybackState } from "./core";
import type { PlayerActions } from "./contracts";
export interface CollectionPorts {
  actions: Pick<PlayerActions, 'syncLibrary' | 'toggleFavourite' | 'toggleSaved'>;
  removeTrackReferences: (id: string) => void;
  restorePlaybackSnapshot: (snapshot: PlaybackState) => void;
}

/** Owns collection behaviour; cross-domain work enters through explicit ports. */
export function createCollection(ports: CollectionPorts, lifetime: RuntimeLifetime) {
  const domainActions = {
    syncLibrary,
    syncLibrarySoon,
    linkCatalogItem(itemId: string, videoId: string): void {
      if (!itemId || !videoId) return;
      setCatalogLinks(prev => {
        if (prev.get(itemId) === videoId) return prev; // no write, no invalidation
        const next = new Map(prev);
        next.set(itemId, videoId);
        return next;
      });
    },
    toggleSaved(entry: SavedEntry): void {
      if (!entry.keys.length) return;
      vibrate();
      const prev = state.saved.slice();
      const has = isSavedKeys(entry.keys);
      const next = has ? prev.filter(f => !f.keys.some(k => entry.keys.includes(k))) : [{
        ...entry,
        added_at: claimedAddedAt(entry.keys)
      }, ...prev];
      setState('saved', next); // optimistic
      api.toggleSaved(entry).catch(lifetime.guard(() => setState('saved', prev))); // revert on failure
    },
    async setSongsSaved(entries: SavedEntry[], saved: boolean): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const usable = entries.filter(entry => entry.keys.length);
      if (!usable.length) return true;
      const prev = state.saved.slice();
      if (saved) {
        const fresh = usable.filter(entry => !savedEntryForKeys(entry.keys)).map(entry => ({
          ...entry,
          added_at: claimedAddedAt(entry.keys)
        }));
        setState('saved', [...fresh, ...prev]);
      } else {
        const leaving = new Set(prev.filter(held => !held.favourite && !held.keys.some(key => key.startsWith('lib:')) && usable.some(entry => entry.keys.some(key => held.keys.includes(key)))));
        setState('saved', prev.filter(held => !leaving.has(held)));
      }
      try {
        await api.setSavedEntries(usable, saved);
        if (!isCurrent()) {
          return false;
        }
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        setState('saved', prev);
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    },
    toggleSavedTrack(track: Track): void {
      ports.actions.toggleSaved(savedFromTrack(track));
    },
    toggleFavourite(entry: SavedEntry): void {
      if (!entry.keys.length) return;
      vibrate();
      const prev = state.saved.slice();
      const has = isFavouriteKeys(entry.keys);
      const existing = savedEntryForKeys(entry.keys);
      const next = existing ? prev.map(f => f === existing ? {
        ...f,
        favourite: !has
      } : f) : [{
        ...entry,
        favourite: true,
        added_at: claimedAddedAt(entry.keys)
      }, ...prev];
      setState('saved', next); // optimistic
      api.toggleFavourite(entry).then(lifetime.guard(() => {
        if (has) return;
        const owned = ownedTrackForKeys(entry.keys);
        void api.emitDiscoveryEvent('music_favourited', {
          media_type: 'music_track',
          track_id: owned?.id,
          title: entry.title ?? owned?.title,
          artist: entry.artist ?? owned?.artist,
          album: entry.album ?? owned?.album,
          youtube_id: owned?.youtube_id ?? savedVideoId(entry) ?? undefined,
          source: owned ? 'library' : 'preview'
        }).catch(lifetime.guard(() => {}));
      })).catch(lifetime.guard(() => setState('saved', prev))); // revert on failure
    },
    toggleFavouriteTrack(track: Track): void {
      ports.actions.toggleFavourite(savedFromTrack(track));
    },
    async deleteTrack(id: string): Promise<void> {
      const isCurrent = lifetime.capture();
      const prevLib = state.library.slice();
      const prevPlaylists = Object.fromEntries(Object.entries(state.playlists).map(([n, ids]) => [n, ids.slice()]));
      const prevPlayback = {
        ...state.playback,
        queue: state.playback.queue.slice()
      };
      beginLibraryEdit();
      ports.removeTrackReferences(id);
      try {
        await api.deleteTrack(id);
        if (!isCurrent()) {
          return;
        }
        await ports.actions.syncLibrary();
        if (!isCurrent()) {
          return;
        }
        toast.success(tr('toast.trackDeleted'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        endLibraryEdit();
        setState({
          library: prevLib,
          playlists: prevPlaylists
        });
        ports.restorePlaybackSnapshot(prevPlayback);
        toast.error(tr('toast.deleteFailed'));
        void ports.actions.syncLibrary();
      }
    },
    async updateTrackMetadata(id: string, meta: {
      title?: string;
      artist?: string;
      album?: string;
      album_artist?: string | null;
    }): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const patch: Partial<Track> = {};
      if (meta.title !== undefined) patch.title = meta.title;
      if (meta.artist !== undefined) patch.artist = meta.artist;
      if (meta.album !== undefined) patch.album = meta.album;
      if (meta.album_artist !== undefined) patch.album_artist = meta.album_artist;
      // Write through the row's path rather than rebuilding the array: `.map`
      // hands the store a new array of new objects, so every subscriber to
      // `state.library` re-runs — including the identity index — instead of the
      // one row that changed.
      const index = state.library.findIndex(t => t.id === id);
      if (index === -1) return false;
      const restore: Partial<Track> = {};
      for (const key of Object.keys(patch) as (keyof Track)[]) {
        restore[key] = state.library[index][key] as never;
      }
      const mark = beginLibraryEdit();
      setState('library', index, patch);
      if (state.playback.currentTrack?.id === id) setState('playback', 'currentTrack', c => c ? {
        ...c,
        ...patch
      } : c);
      try {
        await api.updateTrackMetadata(id, meta);
        if (!isCurrent()) {
          return false;
        }
        endLibraryEdit(mark);
        toast.success(tr('toast.dataUpdated'));
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        endLibraryEdit(mark);
        setState('library', index, restore);
        toast.error(tr('toast.updateFailed'));
        return false;
      }
    },
    async uploadTrackCover(id: string, file: File): Promise<void> {
      const isCurrent = lifetime.capture();
      const t = toast.loading(tr('toast.uploadingCover'));
      try {
        await api.uploadTrackCover(id, file);
        if (!isCurrent()) {
          return;
        }
        bustCovers();
        t.update('success', tr('toast.coverUpdated'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        t.update('error', tr('toast.coverUploadFailed'));
      }
    },
    async clearTrackCover(id: string): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        await api.clearTrackCover(id);
        if (!isCurrent()) {
          return;
        }
        bustCovers();
        toast.success(tr('toast.coverRemoved'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.coverRemoveFailed'));
      }
    },
    async rescanLibrary(): Promise<LibraryScanStatus> {
      const isCurrent = lifetime.capture();
      let status = await api.startLibraryScan();
      if (!isCurrent()) {
        throw new DOMException('Client closed', 'AbortError');
      }
      while (status.state === 'queued' || status.state === 'scanning') {
        await new Promise(resolve => window.setTimeout(resolve, 750));
        if (!isCurrent()) {
          throw new DOMException('Client closed', 'AbortError');
        }
        status = await api.getLibraryScan();
        if (!isCurrent()) {
          throw new DOMException('Client closed', 'AbortError');
        }
      }
      if (status.state === 'failed') {
        throw new Error(status.error || 'Library scan failed');
      }
      await ports.actions.syncLibrary();
      if (!isCurrent()) {
        throw new DOMException('Client closed', 'AbortError');
      }
      return status;
    }
  };
  return {
    actions: domainActions
  };
}
