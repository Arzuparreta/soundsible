import { type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import { openPlaylistCoverPicker } from './CoverPicker';
import { actions, state } from '../stores';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';
import type { Track } from '../types/music';

export interface PlaylistMenuHooks {
  /** Called with the new name after a successful rename (e.g. to update the route). */
  onRenamed?: (newName: string) => void;
  /** Called after the playlist is deleted (e.g. to navigate away). */
  onDeleted?: () => void;
}

/** Resolve a playlist's track ids to library tracks (in order). */
function playlistTracks(name: string): Track[] {
  const ids = state.playlists[name] ?? [];
  const byId = new Map(state.library.map((t) => [t.id, t] as const));
  return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t);
}

/** Play / rename / duplicate / change-cover / delete menu definition for a playlist. */
export function playlistMenuOptions(name: string, hooks: PlaylistMenuHooks = {}): ActionMenuOptions {
  return {
    title: name,
    actions: [
      {
        label: 'Reproducir',
        onSelect: () => {
          const t = playlistTracks(name);
          if (t.length) actions.playFrom(t, 0);
        },
      },
      {
        label: 'Reproducir aleatorio',
        onSelect: () => {
          const t = playlistTracks(name);
          if (t.length) actions.playShuffled(t);
        },
      },
      {
        label: 'Renombrar',
        onSelect: async () => {
          const next = await promptDialog({ title: 'Renombrar lista', initial: name, confirmLabel: 'Renombrar' });
          if (next && (await actions.renamePlaylist(name, next))) hooks.onRenamed?.(next.trim());
        },
      },
      { label: 'Duplicar', onSelect: () => void actions.duplicatePlaylist(name) },
      { label: 'Cambiar portada', onSelect: () => openPlaylistCoverPicker(name) },
      {
        label: 'Eliminar lista',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: 'Eliminar lista',
            message: `Se eliminará «${name}». Las pistas seguirán en tu biblioteca.`,
            confirmLabel: 'Eliminar',
            danger: true,
          });
          if (ok) {
            await actions.deletePlaylist(name);
            hooks.onDeleted?.();
          }
        },
      },
    ],
  };
}

/** Open the playlist menu. Pass the triggering event to anchor a cursor popover. */
export function openPlaylistMenu(name: string, hooks: PlaylistMenuHooks = {}, ev?: MouseEvent): void {
  openContextMenu(playlistMenuOptions(name, hooks), ev);
}
