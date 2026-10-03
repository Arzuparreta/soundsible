import { programTrack } from './tracks';
import type { ActionMenuOptions } from '../../components/ActionMenu';
import { t } from '../i18n';
import type { Track } from '../../types/music';
import type { ProgramCommand, ProgramState } from './runtime';

/** Capture the occurrence when opening the menu. Native guards reject a stale order/anchor. */
export function programLibraryMenu(track: Track, state: () => ProgramState | null, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>): ActionMenuOptions {
  const captured = state();
  const candidate = programTrack(track);
  const disabled = !captured?.ready || pending() || captured.items.length >= 1000 || !candidate;
  const tracks = candidate ? [candidate] : [];
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
    ...(candidate && candidate.mediaKind !== 'podcast_episode' && captured?.items[captured.index]?.id === candidate.id ? [{
      label: t(captured.radio?.active ? 'nowPlaying.stopRadioConfirm' : 'trackActions.startRadio'), disabled: !captured.ready || pending(),
      onSelect: () => {
        if (!captured.ready || pending() || state()?.generation !== captured.generation) return;
        void execute({ action: 'radio', enabled: !captured.radio?.active, profile: captured.radio?.profile ?? 'balanced', queueToken: captured.queueToken }).catch(() => {});
      },
    }] : []),
  ] };
}
