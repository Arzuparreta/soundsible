import { programTrack } from './tracks';
import type { ActionMenuOptions, MenuAction } from '../../components/ActionMenu';
import { t } from '../i18n';
import type { Track } from '../../types/music';
import { offers, type ProgramCommand, type ProgramState, type ProgramTrack } from './runtime';

/** The program and the song as they stood when a menu opened. */
interface MenuCapture {
  captured: ProgramState | null;
  candidate: ProgramTrack | null;
  tracks: ProgramTrack[];
  disabled: boolean;
}

/** Capture the occurrence when opening the menu. Native guards reject a stale order/anchor. */
function captureMenu(track: Track, state: () => ProgramState | null, pending: () => boolean, shell: boolean): MenuCapture {
  const captured = state();
  const candidate = programTrack(track);
  const disabled = !captured?.ready || pending() || captured.items.length >= 1000 && (!captured.dj?.active || shell) || !candidate || captured.dj?.active === true && (candidate.mediaKind === 'podcast_episode' || candidate.source === 'pending');
  return { captured, candidate, tracks: candidate ? [candidate] : [], disabled };
}

function queuePair({ captured, tracks, disabled }: MenuCapture, state: () => ProgramState | null, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>, shell: boolean): MenuAction[] {
  if (captured?.dj?.active && !shell || !offers(captured, 'queueAdd')) return [];
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
  return [
    { label: t('android.insertAfter'), disabled, onSelect: () => select('insertAfter') },
    { label: t('trackActions.addToQueue'), disabled, onSelect: () => select('append') },
  ];
}

/** "Play next" and "Add to queue" on the native queue: the one pair every
 * native song menu offers.
 *
 * It takes a song whether or not it has been matched to a video yet. A
 * catalogue row that has not (`pendingResolve`) enters the native queue as a
 * `pending` item, which the queue matches before it plays, so a song found in
 * Discover queues exactly like one in the library. */
export function programQueueActions(track: Track, state: () => ProgramState | null, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>, shell = false): MenuAction[] {
  return queuePair(captureMenu(track, state, pending, shell), state, pending, execute, shell);
}

export function programLibraryMenu(track: Track, state: () => ProgramState | null, pending: () => boolean,
  execute: (command: ProgramCommand) => Promise<void>, place?: (track: ProgramTrack) => void, shell = false): ActionMenuOptions {
  const capture = captureMenu(track, state, pending, shell);
  const { captured, candidate, tracks, disabled } = capture;
  return { title: track.title, subtitle: track.artist, actions: [
    ...queuePair(capture, state, pending, execute, shell),
    ...(candidate && candidate.source !== 'pending' && candidate.mediaKind !== 'podcast_episode' && offers(captured, 'dj') ? [{
      label: t(captured?.items[captured.index]?.id === candidate.id ? 'musicExplorer.startDjFromCurrent' : 'musicExplorer.startDjFromSong'),
      disabled: disabled || captured?.items[captured.index]?.mediaKind === 'podcast_episode',
      onSelect: () => {
        const observed = state();
        if (disabled || pending() || !observed?.ready || observed.generation !== captured?.generation ||
          observed.programToken !== captured.programToken ||
          (shell || !captured.dj?.active) && observed.queueToken !== captured.queueToken ||
          observed.items[observed.index]?.mediaKind === 'podcast_episode') return;
        void execute(!shell && captured.dj?.active
          ? { action: 'djSelection', tracks, label: track.title, queueToken: captured.queueToken, programToken: captured.programToken }
          : { action: 'djContext', tracks, queueToken: captured.queueToken, programToken: captured.programToken, key: captured.items[captured.index]?.key }).catch(() => {});
      },
    }] : []),
    ...(shell && captured?.dj?.active && candidate && candidate.source !== 'pending' && candidate.mediaKind !== 'podcast_episode' && offers(captured, 'djSources') ? [{
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
    ...(shell && captured?.dj?.active && captured.programToken && candidate?.source !== 'pending' && candidate?.mediaKind !== 'podcast_episode' && offers(captured, 'djPlace') ? [{
      label: t('autoMode.dj.routeAction'), disabled,
      onSelect: () => {
        const observed = state();
        if (disabled || pending() || observed?.generation !== captured.generation || observed.programToken !== captured.programToken || !observed.dj?.active || observed.queueToken !== captured.queueToken) return;
        if (place && candidate) place(candidate);
        else void execute({ action: 'djRequest', tracks, programToken: captured.programToken!, queueToken: captured.queueToken }).catch(() => {});
      },
    }] : []),
    ...(candidate && candidate.source !== 'pending' && candidate.mediaKind !== 'podcast_episode' && captured?.items[captured.index]?.id === candidate.id && offers(captured, 'radio') ? [{
      label: t(captured.radio?.active ? 'nowPlaying.stopRadioConfirm' : 'trackActions.startRadio'), disabled: !captured.ready || pending(),
      onSelect: () => {
        if (!captured.ready || pending() || state()?.generation !== captured.generation) return;
        void execute({ action: 'radio', enabled: !captured.radio?.active, profile: captured.radio?.profile ?? 'balanced', queueToken: captured.queueToken, key: captured.items[captured.index]?.key }).catch(() => {});
      },
    }, ...(captured.radio?.active && offers(captured, 'radioProfile') ? (['familiar', 'balanced', 'explore'] as const).map(profile => ({
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
