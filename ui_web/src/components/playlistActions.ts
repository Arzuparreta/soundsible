import { type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import { openPlaylistCoverPicker } from './CoverPicker';
import { actions, state } from '../stores';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';

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
        label: t('playlistActions.play'),
        onSelect: () => {
          const t = playlistTracks(name);
          if (t.length) actions.playFrom(t, 0);
        },
      },
      {
        label: t('playlistActions.shuffle'),
        onSelect: () => {
          const t = playlistTracks(name);
          if (t.length) actions.playShuffled(t);
        },
      },
      {
        label: t('playlistActions.rename'),
        onSelect: async () => {
          const next = await promptDialog({ title: t('playlistActions.renameTitle'), initial: name, confirmLabel: t('playlistActions.renameConfirm') });
          if (next && (await actions.renamePlaylist(name, next))) hooks.onRenamed?.(next.trim());
        },
      },
      { label: t('playlistActions.duplicate'), onSelect: () => void actions.duplicatePlaylist(name) },
      { label: t('playlistActions.changeCover'), onSelect: () => openPlaylistCoverPicker(name) },
      {
        label: t('playlistActions.deleteList'),
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog({
            title: t('playlistActions.deleteTitle'),
            message: t('playlistActions.deleteMsg', { name }),
            confirmLabel: t('playlistActions.deleteConfirm'),
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
