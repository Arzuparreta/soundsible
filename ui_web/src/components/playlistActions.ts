import { type ActionMenuOptions } from './ActionMenu';
import { openContextMenu } from '../lib/contextMenu';
import { openPlaylistCoverPicker } from './CoverPicker';
import { actions, state, musicLibrary } from '../stores';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';

export interface PlaylistMenuHooks {
  /** Called with the new name after a successful rename (e.g. to update the route). */
  onRenamed?: (newName: string) => void;
  /** Called after the playlist is deleted (e.g. to navigate away). */
  onDeleted?: () => void;
  onEdit?: () => void;
  beforeQueueId?: string;
  onPlaced?: () => void;
}

/** Resolve a playlist's track ids to library tracks (in order). */
function playlistTracks(name: string): Track[] {
  const ids = state.playlists[name] ?? [];
  const byId = new Map(musicLibrary().map((t) => [t.id, t] as const));
  return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t);
}

/** Play / rename / duplicate / change-cover / delete menu definition for a playlist. */
export function playlistMenuOptions(name: string, hooks: PlaylistMenuHooks = {}): ActionMenuOptions {
  const inAuto = state.autoMode.active;
  return {
    title: name,
    actions: [
      {
        label: inAuto ? t('musicExplorer.requestAll') : t('playlistActions.play'),
        onSelect: async () => {
          const t = playlistTracks(name);
          if (t.length) {
            if (state.autoMode.active) {
              const epoch = actions.autoSessionToken();
              await actions.placeAutoTracks(t, hooks.beforeQueueId);
              if (actions.autoSessionToken() === epoch) hooks.onPlaced?.();
            } else {
              actions.playFrom(t, 0, {
                context: { id: `playlist:${name}`, kind: 'playlist', label: name },
              });
            }
          }
        },
      },
      ...(inAuto ? [{ label: t('musicExplorer.reference'), onSelect: () => { actions.addAutoSource(playlistTracks(name), name); hooks.onPlaced?.(); } }] : []),
      ...(inAuto ? [{ label: t('musicExplorer.change'), onSelect: () => void actions.changeAutoSession(playlistTracks(name), name) }] : []),
      ...(!inAuto ? [{
        label: t('playlistActions.shuffle'),
        onSelect: () => {
          const t = playlistTracks(name);
          if (t.length) {
            actions.playShuffled(t, {
              id: `playlist:${name}`,
              kind: 'playlist',
              label: name,
            });
          }
        },
      }] : []),
      ...(hooks.onEdit ? [{ label: t('musicExplorer.edit'), onSelect: hooks.onEdit }] : []),
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
          if (ok && await actions.deletePlaylist(name)) {
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

export async function createPlaylistDialog(): Promise<string | null> {
  const name = await promptDialog({ title: t('playlists.new'), placeholder: t('playlists.newPlaceholder'), confirmLabel: t('playlists.newConfirm') });
  return name && await actions.createPlaylist(name) ? name.trim() : null;
}
