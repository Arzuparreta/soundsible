import { Show } from 'solid-js';
import { PauseFilledIcon, PlayFilledIcon } from '../../components/icons';
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

  const progress = () => {
    const duration = state.playback.duration || track()?.duration || 0;
    return duration > 0 ? Math.max(0, Math.min(1, state.playback.currentTime / duration)) : 0;
  };

  return (
    <Show when={track()}>
      {(current) => (
        <div
          class={styles.tvMiniBar}
          data-tv-group-container="tv-mini-bar"
          data-tv-group-kind="row"
          data-tv-group-order="900"
        >
          <span aria-hidden="true" class={styles.tvMiniProgress} style={{ transform: `scaleX(${progress()})` }} />
          <Control
            aria-label={`${t('tv.nav.nowPlaying')} · ${current().title} · ${current().artist}`}
            data-tv-id="tv-mini-open"
            data-tv-group="tv-mini-bar"
            data-tv-index="0"
            data-tv-focused={focus.activeId() === 'tv-mini-open' ? 'true' : undefined}
            class={styles.tvMiniIdentity}
            classList={{ [styles.tvFocusTarget]: true }}
            onClick={props.onOpenNowPlaying}
          >
            <TvArtwork
              class={styles.tvTrackArt}
              src={trackCoverUrl(current(), 'thumb')}
              alt=""
              fallbackLabel={current().title}
            />
            <span class={styles.tvTrackMain}>
              <strong class={styles.tvTrackTitle}>{current().title}</strong>
              <span class={styles.tvTrackSub}>{current().artist}</span>
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
                {state.playback.isPlaying ? <PauseFilledIcon /> : <PlayFilledIcon />}
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
