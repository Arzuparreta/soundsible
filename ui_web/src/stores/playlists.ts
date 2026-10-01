import type { RuntimeLifetime } from '../lib/runtimeLifetime';
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { savedFromTrack } from "../lib/saved";
import { trackKeys } from "../lib/playbackIdentity";
import { t as tr } from "../lib/i18n";
import type { Track, PlaylistMap, LibrarySettings } from "../types/music";
import { endLibraryEdit } from "./library";
import { isSavedKeys } from "./identity";
import { state, setState } from "./core";
import type { PlayerActions } from "./contracts";
export interface PlaylistsPorts {
  actions: Pick<PlayerActions, 'toggleSaved'>;
}

/** Owns playlists behaviour; cross-domain work enters through explicit ports. */
export function createPlaylists(ports: PlaylistsPorts, lifetime: RuntimeLifetime) {
  function applyPlaylistMutation(res: {
    playlists?: PlaylistMap;
    settings?: LibrarySettings;
  }): void {
    endLibraryEdit();
    if (res.playlists) setState('playlists', res.playlists);
    if (res.settings) setState('librarySettings', res.settings);
  }
  const domainActions = {
    async createPlaylist(name: string): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const clean = name.trim();
      if (!clean) return false;
      if (state.playlists[clean]) {
        toast.error(tr('toast.playlistExists'));
        return false;
      }
      try {
        applyPlaylistMutation(await api.createPlaylist(clean));
        if (!isCurrent()) {
          return false;
        }
        toast.success(tr('toast.playlistCreated'));
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        toast.error(tr('toast.playlistCreateFailed'));
        return false;
      }
    },
    async deletePlaylist(name: string): Promise<boolean> {
      const isCurrent = lifetime.capture();
      try {
        applyPlaylistMutation(await api.deletePlaylist(name));
        if (!isCurrent()) {
          return false;
        }
        toast.success(tr('toast.playlistDeleted'));
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        toast.error(tr('toast.playlistDeleteFailed'));
        return false;
      }
    },
    async renamePlaylist(name: string, newName: string): Promise<boolean> {
      const isCurrent = lifetime.capture();
      const clean = newName.trim();
      if (!clean || clean === name) return false;
      try {
        applyPlaylistMutation(await api.renamePlaylist(name, clean));
        if (!isCurrent()) {
          return false;
        }
        toast.success(tr('toast.playlistRenamed'));
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        toast.error(tr('toast.playlistRenameFailed'));
        return false;
      }
    },
    async duplicatePlaylist(name: string): Promise<void> {
      const isCurrent = lifetime.capture();
      const ids = state.playlists[name] ?? [];
      let copy = `${name}${tr('toast.playlistDuplicateSuffix')}`;
      let n = 2;
      while (state.playlists[copy]) copy = `${name}${tr('toast.playlistDuplicateSuffixN', {
        n: n++
      })}`;
      try {
        await api.createPlaylist(copy);
        if (!isCurrent()) {
          return;
        }
        applyPlaylistMutation(await api.setPlaylistTracks(copy, ids));
        if (!isCurrent()) {
          return;
        }
        toast.success(tr('toast.playlistDuplicated'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.playlistDuplicateFailed'));
      }
    },
    async addToPlaylist(name: string, track: Track): Promise<void> {
      const isCurrent = lifetime.capture();
      if ((state.playlists[name] ?? []).includes(track.id)) {
        toast.info(tr('toast.alreadyInPlaylist'));
        return;
      }
      try {
        applyPlaylistMutation(await api.addTrackToPlaylist(name, track.id));
        if (!isCurrent()) {
          return;
        }

        // A playlist membership is a durable claim on the song, same as a
        // favourite — a track played from Auto Mode/DJ or a search result has
        // no other way to stay resolvable once the session that played it ends.
        if (!isSavedKeys(trackKeys(track))) ports.actions.toggleSaved(savedFromTrack(track));
        void api.emitDiscoveryEvent('music_added_to_playlist', {
          media_type: 'music_track',
          track_id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          youtube_id: track.youtube_id,
          playlist_name: name,
          source: track.source === 'preview' ? 'preview' : 'library'
        }).catch(lifetime.guard(() => {}));
        toast.success(tr('toast.addedToPlaylist', {
          name
        }));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.addToPlaylistFailed'));
      }
    },
    async removeFromPlaylist(name: string, trackId: string): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        applyPlaylistMutation(await api.removeTrackFromPlaylist(name, trackId));
        if (!isCurrent()) {
          return;
        }
        toast.success(tr('toast.removedFromPlaylist'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.removeFromPlaylistFailed'));
      }
    },
    async reorderPlaylistTracks(name: string, ids: string[]): Promise<boolean> {
      const isCurrent = lifetime.capture();
      try {
        applyPlaylistMutation(await api.setPlaylistTracks(name, ids));
        if (!isCurrent()) {
          return false;
        }
        return true;
      } catch {
        if (!isCurrent()) {
          return false;
        }
        toast.error(tr('toast.reorderFailed'));
        return false;
      }
    },
    async reorderPlaylists(order: string[]): Promise<void> {
      const isCurrent = lifetime.capture();
      const prev = state.playlists;
      try {
        applyPlaylistMutation(await api.reorderPlaylists(order));
        if (!isCurrent()) {
          return;
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        endLibraryEdit();
        setState('playlists', prev);
        toast.error(tr('toast.reorderFailed'));
      }
    },
    async setPlaylistCover(name: string, coverTrackId: string | null): Promise<void> {
      const isCurrent = lifetime.capture();
      try {
        applyPlaylistMutation(await api.setPlaylistCover(name, coverTrackId));
        if (!isCurrent()) {
          return;
        }
        toast.success(tr('toast.playlistCoverUpdated'));
      } catch {
        if (!isCurrent()) {
          return;
        }
        toast.error(tr('toast.playlistCoverFailed'));
      }
    }
  };
  return {
    actions: domainActions
  };
}
