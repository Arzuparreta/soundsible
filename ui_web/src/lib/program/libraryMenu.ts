import type { ActionMenuOptions } from '../../components/ActionMenu';
import { t } from '../i18n';
import type { Track } from '../../types/music';
import type { ProgramCommand, ProgramState } from './runtime';

/** Capture the occurrence when opening the menu. Native guards reject a stale order/anchor. */
export function programLibraryMenu(track: Track, state: () => ProgramState | null, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>): ActionMenuOptions {
  const captured = state();
  const disabled = !captured?.ready || pending() || captured.items.length >= 1000 || track.source === 'preview';
  const tracks = [{ id: track.id, title: track.title, artist: track.artist, album: track.album }];
  const select = (action: 'append' | 'insertAfter') => {
    // A deferred sheet selection must never migrate to a different logged-in account.
    if (disabled || pending() || state()?.generation !== captured?.generation) return;
    const guard = { tracks, queueToken: captured!.queueToken };
    const command: ProgramCommand = action === 'append' ? { action, ...guard } : {
      action, ...guard, index: captured!.items.length ? captured!.index : -1,
      key: captured!.items[captured!.index]?.key ?? '',
    };
    void execute(command).catch(() => {});
  };
  return { title: track.title, subtitle: track.artist, actions: [
    { label: t('android.insertAfter'), disabled, onSelect: () => select('insertAfter') },
    { label: t('trackActions.addToQueue'), disabled, onSelect: () => select('append') },
  ] };
}
