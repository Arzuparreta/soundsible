import { openActionMenu } from './ActionMenu';
import { openPlaylistCoverPicker } from './CoverPicker';
import { actions } from '../stores';
import { promptDialog } from '../lib/prompt';
import { confirmDialog } from '../lib/confirm';

export interface PlaylistMenuHooks {
  /** Called with the new name after a successful rename (e.g. to update the route). */
  onRenamed?: (newName: string) => void;
  /** Called after the playlist is deleted (e.g. to navigate away). */
  onDeleted?: () => void;
}

/** Rename / duplicate / change-cover / delete menu, shared by the grid and detail views. */
export function openPlaylistMenu(name: string, hooks: PlaylistMenuHooks = {}): void {
  openActionMenu({
    title: name,
    actions: [
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
  });
}
