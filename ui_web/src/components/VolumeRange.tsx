import { player } from '../stores/player';
import { t } from '../lib/i18n';
import { gainToVolumePosition, volumePositionToGain } from '../lib/volumeScale';
import { RangeControl } from '../design/Control';

/**
 * Shared volume slider binding `player().playback.volume` / `muted` to a linear
 * perceptually-scaled range control across PlayerStage and PlayerCompactDock.
 */
export function VolumeRange(props: { class?: string }) {
  const volPct = () => {
    const muted = Boolean(player().playback.muted);
    const volume = player().playback.volume ?? 1;
    return Math.round(gainToVolumePosition(muted ? 0 : volume) * 100);
  };

  return (
    <RangeControl
      class={props.class}
      min={0}
      max={100}
      value={volPct()}
      style={{ '--fill': `${volPct()}%` }}
      aria-label={t('omnibar.volume')}
      aria-valuetext={`${volPct()}%`}
      onInput={(event) => player().actions.setVolume(volumePositionToGain(Number(event.currentTarget.value) / 100))}
    />
  );
}
