import { Show } from 'solid-js';
import { Control } from '../../design/Control';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { actions, state } from '../../stores';
import { useTvFocus } from '../nav/spatial';
import { TvArtwork } from './TvArtwork';
import styles from '../styles/tv.module.css';

interface TvMiniBarProps {
  onOpenNowPlaying: () => void;
}

export function TvMiniBar(props: TvMiniBarProps) {
  const focus = useTvFocus();
  const track = () => state.playback.currentTrack;

  return (
    <Show when={track()}>
      {(current) => (
        <div
          class={styles.tvMiniBar}
          data-tv-group-container="tv-mini-bar"
          data-tv-group-kind="row"
          data-tv-group-order="900"
        >
          <Control
            data-tv-id="tv-mini-open"
            data-tv-group="tv-mini-bar"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'tv-mini-open' ? 'true' : undefined}
            class={styles.tvSecondaryBtn}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={props.onOpenNowPlaying}
          >
            <TvArtwork
              class={styles.tvTrackArt}
              src={trackCoverUrl(current(), 'thumb')}
              alt={current().title}
              fallbackLabel={current().title}
            />
            <span>
              {current().title} — {current().artist}
            </span>
          </Control>
          <Show
            when={state.playback.needsGesture}
            fallback={
              <Control
                data-tv-id="tv-mini-toggle"
                data-tv-group="tv-mini-bar"
                data-tv-index="1"
                data-tv-focused={focus.activeId() === 'tv-mini-toggle' ? 'true' : undefined}
                class={styles.tvPrimaryBtn}
                classList={{ [styles.tvFocusTarget]: true }}
                onClick={() => actions.togglePlay()}
              >
                {state.playback.isPlaying ? t('tv.pause') : t('tv.play')}
              </Control>
            }
          >
            <Control
              data-tv-id="tv-mini-gesture"
              data-tv-group="tv-mini-bar"
              data-tv-index="1"
              data-tv-focused={focus.activeId() === 'tv-mini-gesture' ? 'true' : undefined}
              class={styles.tvPrimaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => actions.resumePlayback()}
            >
              {t('tv.player.pressOkToPlay')}
            </Control>
          </Show>
        </div>
      )}
    </Show>
  );
}
