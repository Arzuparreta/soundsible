import { createMemo, Match, Show, Switch } from 'solid-js';
import { advancePlayback, isCurrentTrackPodcast, player } from '../stores/player';
import { trackCoverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import { Control } from '../design/Control';
import { ArtworkSurface } from '../design/Artwork';
import { BackIcon, NextFilledIcon, PauseFilledIcon, PlayFilledIcon, RefreshIcon } from './icons';
import { PodcastSkipIcon } from './PodcastSkipIcon';
import { Spinner } from './Spinner';
import styles from './PlayerMiniHeader.module.css';

/**
 * Compact now-playing strip pinned above secondary player views (Queue, DJ
 * Route, Lyrics) when the player is narrow. Returns to the stage on click and
 * keeps Play/Pause and Next reachable when desktop docking hides OmniBar.
 */
export function PlayerMiniHeader(props: {
  mode: 'now-playing' | 'auto';
  onBack: () => void;
}) {
  const track = createMemo(() => player().playback.currentTrack);
  const podcast = createMemo(isCurrentTrackPodcast);
  const loading = createMemo(() => player().playback.isLoading);
  const loadFailed = createMemo(() => player().playback.loadError);
  const backLabel = createMemo(() =>
    props.mode === 'auto' ? t('autoMode.panel.stage') : t('nowPlaying.panel.stage'),
  );

  return (
    <Show when={track()}>
      {(current) => (
        <div class={styles.bar} data-player-mini-header="" data-no-surface-swipe="">
          <Control
            class={styles.back}
            aria-label={backLabel()}
            title={backLabel()}
            onClick={() => props.onBack()}
          >
            <BackIcon size={16} class={styles.chevron} />
            <ArtworkSurface
              class={styles.cover}
              seed={current().id}
              src={trackCoverUrl(current(), 'thumb')}
              aria-hidden="true"
            />
            <span class={styles.meta}>
              <span class={styles.title}>{current().title}</span>
              <span class={styles.artist}>{current().artist}</span>
            </span>
          </Control>
          <div class={styles.controls}>
            {/* app.css dims [data-pending] after a 250ms in-flight delay across transport controls. */}
            <Control
              class={styles.ctrl}
              aria-label={loadFailed() ? t('common.retry') : player().playback.isPlaying ? t('common.pause') : t('common.play')}
              aria-busy={loading() || player().pending('play') || undefined}
              data-pending={player().pending('play') || undefined}
              disabled={player().unreachable}
              onClick={() => player().actions.togglePlay()}
            >
              <Switch>
                <Match when={loadFailed()}>
                  <RefreshIcon size={20} />
                </Match>
                <Match when={loading()}>
                  <Spinner size={18} />
                </Match>
                <Match when={player().playback.isPlaying}>
                  <PauseFilledIcon size={20} />
                </Match>
                <Match when={true}>
                  <PlayFilledIcon size={20} />
                </Match>
              </Switch>
            </Control>
            <Control
              class={styles.ctrl}
              aria-label={podcast() ? t('podcasts.skipForward') : t('common.next')}
              aria-busy={player().pending('next') || undefined}
              data-pending={player().pending('next') || undefined}
              disabled={player().unreachable}
              onClick={() => advancePlayback()}
            >
              <Show when={podcast()} fallback={<NextFilledIcon size={20} />}>
                <PodcastSkipIcon size={20} />
              </Show>
            </Control>
          </div>
        </div>
      )}
    </Show>
  );
}
