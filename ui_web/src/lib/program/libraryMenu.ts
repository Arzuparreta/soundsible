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
  const disabled = !captured?.ready || pending() || captured.items.length >= 1000 || !candidate || captured.dj?.active === true && candidate.mediaKind === 'podcast_episode';
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
    ...(candidate && candidate.mediaKind !== 'podcast_episode' ? [{
      label: t(captured?.items[captured.index]?.id === candidate.id ? 'musicExplorer.startDjFromCurrent' : 'musicExplorer.startDjFromSong'),
      disabled: disabled || captured?.items[captured.index]?.mediaKind === 'podcast_episode',
      onSelect: () => {
        const observed = state();
        if (disabled || pending() || !observed?.ready || observed.generation !== captured?.generation ||
          observed.programToken !== captured.programToken || observed.queueToken !== captured.queueToken ||
          observed.items[observed.index]?.mediaKind === 'podcast_episode') return;
        void execute({ action: 'djContext', tracks, queueToken: captured.queueToken,
          programToken: captured.programToken, key: captured.items[captured.index]?.key }).catch(() => {});
      },
    }] : []),
    ...(captured?.dj?.active && candidate && candidate.mediaKind !== 'podcast_episode' ? [{
      label: t('musicExplorer.reference'),
      selected: captured.dj.sources?.some(source => source.tracks.length === 1 && source.tracks[0].id === candidate.id && (source.tracks[0].source ?? 'local') === candidate.source),
      disabled: disabled || (captured.dj.sources?.length ?? 0) >= 64 || captured.dj.sources?.some(source => source.tracks.length === 1 && source.tracks[0].id === candidate.id && (source.tracks[0].source ?? 'local') === candidate.source),
      onSelect: () => {
        const observed = state();
        if (disabled || pending() || !observed?.dj?.active || observed.generation !== captured.generation ||
          observed.programToken !== captured.programToken || !observed.programToken || observed.queueToken !== captured.queueToken) return;
        const sources = observed.dj.sources ?? [];
        if (sources.length >= 64 || sources.some(source => source.tracks.length === 1 && source.tracks[0].id === candidate.id && (source.tracks[0].source ?? 'local') === candidate.source)) return;
        void execute({ action: 'djSettings', programToken: observed.programToken, sources: [...sources, {
          id: crypto.randomUUID(), label: candidate.title, tracks: [{ ...candidate, source: candidate.source === 'preview' ? 'preview' as const : undefined }],
          activation: Math.max(0, ...sources.map(source => source.activation)) + 1,
        }] }).catch(() => {});
      },
    }] : []),
    ...(captured?.dj?.active && captured.programToken && candidate?.mediaKind !== 'podcast_episode' ? [{
      label: t('autoMode.dj.routeAction'), disabled,
      onSelect: () => {
        const observed = state();
        if (disabled || pending() || observed?.generation !== captured.generation || observed.programToken !== captured.programToken || !observed.dj?.active || observed.queueToken !== captured.queueToken) return;
        void execute({ action: 'djRequest', tracks, programToken: captured.programToken!, queueToken: captured.queueToken }).catch(() => {});
      },
    }] : []),
    ...(candidate && candidate.mediaKind !== 'podcast_episode' && captured?.items[captured.index]?.id === candidate.id ? [{
      label: t(captured.radio?.active ? 'nowPlaying.stopRadioConfirm' : 'trackActions.startRadio'), disabled: !captured.ready || pending(),
      onSelect: () => {
        if (!captured.ready || pending() || state()?.generation !== captured.generation) return;
        void execute({ action: 'radio', enabled: !captured.radio?.active, profile: captured.radio?.profile ?? 'balanced', queueToken: captured.queueToken, key: captured.items[captured.index]?.key }).catch(() => {});
      },
    }, ...(captured.radio?.active ? (['familiar', 'balanced', 'explore'] as const).map(profile => ({
      label: t(`autoMode.profile.${profile}`), selected: captured.radio?.profile === profile,
      disabled: !captured.ready || pending(),
      onSelect: () => {
        const observed = state();
        if (!captured.ready || pending() || observed?.generation !== captured.generation ||
          observed.items[observed.index]?.key !== captured.items[captured.index]?.key) return;
        void execute({ action: 'radio', enabled: true, profile, queueToken: captured.queueToken, key: captured.items[captured.index]?.key }).catch(() => {});
      },
    })) : [])] : []),
  ] };
}
