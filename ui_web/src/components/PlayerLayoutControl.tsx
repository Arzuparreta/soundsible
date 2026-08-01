import { openContextMenu } from '../lib/contextMenu';
import styles from './PlayerSurface.module.css';

export interface PlayerLayoutPresetOption<PresetId extends string> {
  id: PresetId;
  label: string;
}

export function PlayerLayoutControl<PresetId extends string>(props: {
  title: string;
  ariaLabel: string;
  resetLabel: string;
  presets: readonly PlayerLayoutPresetOption<PresetId>[];
  onSelect: (preset: PresetId) => void;
  onReset: () => void;
}) {
  const openMenu = (event: MouseEvent) => {
    openContextMenu({
      title: props.title,
      actions: [
        ...props.presets.map((preset) => ({
          label: preset.label,
          onSelect: () => props.onSelect(preset.id),
        })),
        {
          label: props.resetLabel,
          onSelect: props.onReset,
        },
      ],
    }, event);
  };

  return (
    <button
      classList={{ [styles.chromeButton]: true, [styles.layoutButton]: true }}
      type="button"
      aria-label={props.ariaLabel}
      title={props.ariaLabel}
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
