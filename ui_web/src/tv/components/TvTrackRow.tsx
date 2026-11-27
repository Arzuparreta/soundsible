import { Show } from 'solid-js';
import { Control } from '../../design/Control';
import { formatDuration } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useTvFocus } from '../nav/spatial';
import styles from '../styles/tv.module.css';
import { TvArtwork } from './TvArtwork';

export function TvTrackRow(props: {
  id: string;
  group: string;
  index: number;
  title: string;
  artist: string;
  artwork?: string;
  duration?: number | null;
  playing: boolean;
  onActivate: () => void;
}) {
  const focus = useTvFocus();
  return (
    <div role="listitem">
      <Control
        data-tv-id={props.id}
        data-tv-group={props.group}
        data-tv-index={String(props.index)}
        data-tv-focused={focus.activeId() === props.id ? 'true' : undefined}
        class={styles.tvTrackRow}
        classList={{ [styles.tvFocusTarget]: true, [styles.tvTrackRowPlaying]: props.playing }}
        onClick={props.onActivate}
      >
        <TvArtwork class={styles.tvTrackArt} src={props.artwork} alt="" fallbackLabel={props.title} />
        <span class={styles.tvTrackMain}>
          <span class={styles.tvTrackTitle}>{props.title}</span>
          <span class={styles.tvTrackSub}>{props.artist}</span>
        </span>
        <Show when={props.playing}>
          <span class={styles.tvPlayingBadge}>{t('tv.player.playingNow')}</span>
        </Show>
        <span class={styles.tvTrackDuration}>{formatDuration(props.duration ?? 0)}</span>
      </Control>
    </div>
  );
}
