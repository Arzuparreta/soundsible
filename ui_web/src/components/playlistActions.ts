import type { MenuEvent } from '../lib/menuEvent';
import { collectionIndex, resolveCollectionTracks } from '../lib/collectionIdentity';
import { type ActionMenuOptions } from './ActionMenu';
import { menuIcons } from './icons';
import { collectionActions, type MusicCollection } from './collectionCommands';
import { openContextMenu } from '../lib/contextMenu';
import { openPlaylistCoverPicker } from './CoverPicker';
import { actions, state, musicLibrary } from '../stores';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import { playlistContext } from '../lib/playbackContext';

export interface PlaylistMenuHooks {
  /** Called with the new name after a successful rename (e.g. to update the route). */
  onRenamed?: (newName: string) => void;
  /** Called after the playlist is deleted (e.g. to navigate away). */
  onDeleted?: () => void;
  /** Offered where the playlist's songs can be put in a new order. */
  onEdit?: () => void;
}

/** Resolve a playlist's track ids to library tracks (in order). */
export function playlistTracks(name: string): Track[] {
  const ids = state.playlists[name] ?? [];
  const byId = collectionIndex(state.collectionItems ?? musicLibrary());
  return resolveCollectionTracks(ids, byId);
}

/** A playlist as a collection the shared commands can play. */
export function playlistCollection(name: string): MusicCollection {
  return {
    title: name,
    get context() { return playlistContext(name, playlistTracks(name), state.librarySettings); },
    songs: () => ({ tracks: playlistTracks(name) }),
  };
}

/** Play / rename / duplicate / change-cover / delete menu definition for a playlist. */
export function playlistMenuOptions(name: string, hooks: PlaylistMenuHooks = {}): ActionMenuOptions {
  return {
    title: name,
    actions: [
      ...collectionActions(playlistCollection(name)),
      ...(hooks.onEdit ? [{ icon: menuIcons.edit(), label: t('musicExplorer.edit'), onSelect: hooks.onEdit }] : []),
      {
        icon: menuIcons.rename(),
        label: t('playlistActions.rename'),
        onSelect: async () => {
          const next = await promptDialog({ title: t('playlistActions.renameTitle'), initial: name, confirmLabel: t('playlistActions.renameConfirm') });
          if (next && (await actions.renamePlaylist(name, next))) hooks.onRenamed?.(next.trim());
        },
      },
      { icon: menuIcons.duplicate(), label: t('playlistActions.duplicate'), onSelect: () => void actions.duplicatePlaylist(name) },
      { icon: menuIcons.cover(), label: t('playlistActions.changeCover'), onSelect: () => openPlaylistCoverPicker(name) },
      {
        icon: menuIcons.trash(),
        label: t('playlistActions.deleteList'),
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: t('playlistActions.deleteTitle'),
            message: t('playlistActions.deleteMsg', { name }),
            confirmLabel: t('playlistActions.deleteConfirm'),
            danger: true,
          });
          if (ok && await actions.deletePlaylist(name)) {
            hooks.onDeleted?.();
          }
        },
      },
    ],
  };
}

/** Open the playlist menu. Pass the triggering event to anchor a cursor popover. */
export function openPlaylistMenu(name: string, hooks: PlaylistMenuHooks = {}, ev?: MenuEvent): void {
  openContextMenu(playlistMenuOptions(name, hooks), ev);
}

export async function createPlaylistDialog(): Promise<string | null> {
  const name = await promptDialog({ title: t('playlists.new'), placeholder: t('playlists.newPlaceholder'), confirmLabel: t('playlists.newConfirm') });
  return name && await actions.createPlaylist(name) ? name.trim() : null;
}
