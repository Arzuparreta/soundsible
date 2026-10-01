

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
  actions: PlayerActions;
}

/** Owns playlists behaviour; cross-domain work enters through explicit ports. */
export function createPlaylists(ports: PlaylistsPorts) {
function applyPlaylistMutation(res: { playlists?: PlaylistMap; settings?: LibrarySettings }): void {
  endLibraryEdit();
  if (res.playlists) setState('playlists', res.playlists);
  if (res.settings) setState('librarySettings', res.settings);
}

const domainActions = {
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
async deletePlaylist(name: string): Promise<boolean> {
    try {
      applyPlaylistMutation(await api.deletePlaylist(name));
      toast.success(tr('toast.playlistDeleted'));
      return true;
    } catch {
      toast.error(tr('toast.playlistDeleteFailed'));
      return false;
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
async addToPlaylist(name: string, track: Track): Promise<void> {
    if ((state.playlists[name] ?? []).includes(track.id)) {
      toast.info(tr('toast.alreadyInPlaylist'));
      return;
    }
    try {
      applyPlaylistMutation(await api.addTrackToPlaylist(name, track.id));
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
        source: track.source === 'preview' ? 'preview' : 'library',
      }).catch(() => {});
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
async reorderPlaylistTracks(name: string, ids: string[]): Promise<boolean> {
    try {
      applyPlaylistMutation(await api.setPlaylistTracks(name, ids));
      return true;
    } catch { toast.error(tr('toast.reorderFailed')); return false; }
  },
async reorderPlaylists(order: string[]): Promise<void> {
    const prev = state.playlists;
    try {
      applyPlaylistMutation(await api.reorderPlaylists(order));
    } catch {
      endLibraryEdit();
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
  }
};
return { actions: domainActions,  };
}
