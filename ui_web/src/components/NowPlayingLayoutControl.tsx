import { t } from '../lib/i18n';
import { openContextMenu } from '../lib/contextMenu';
import type { NowPlayingLayoutPresetId } from '../lib/nowPlayingLayout';
import styles from './PlayerSurface.module.css';

const PRESETS: Array<{ id: NowPlayingLayoutPresetId; label: string }> = [
  { id: 'balanced', label: 'nowPlaying.layoutBalanced' },
  { id: 'player', label: 'nowPlaying.layoutPlayer' },
  { id: 'explore', label: 'nowPlaying.layoutExplore' },
  { id: 'queue', label: 'nowPlaying.layoutQueue' },
];

export function NowPlayingLayoutControl(props: {
  onSelect: (preset: NowPlayingLayoutPresetId) => void;
  onReset: () => void;
}) {
  const openMenu = (event: MouseEvent) => {
    openContextMenu({
      title: t('nowPlaying.layoutWorkspace'),
      actions: [
        ...PRESETS.map((preset) => ({
          label: t(preset.label),
          onSelect: () => props.onSelect(preset.id),
        })),
        {
          label: t('nowPlaying.resetLayout'),
          onSelect: props.onReset,
        },
      ],
    }, event);
  };

  return (
    <button
      classList={{ [styles.chromeButton]: true, [styles.layoutButton]: true }}
      type="button"
      aria-label={t('nowPlaying.changeLayout')}
      title={t('nowPlaying.changeLayout')}
      aria-haspopup="menu"
      onClick={openMenu}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="5" height="16" rx="1" />
        <rect x="10" y="4" width="11" height="7" rx="1" />
        <rect x="10" y="13" width="11" height="7" rx="1" />
      </svg>
    </button>
  );
}
