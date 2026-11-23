import { createMemo, Match, Show, Switch } from 'solid-js';
import { player } from '../stores/player';
import { trackCoverUrl } from '../lib/media';
import { isPodcastTrack } from '../lib/track';
import { t } from '../lib/i18n';
import { Control } from '../design/Control';
import { ArtworkSurface } from '../design/Artwork';
import { BackIcon } from './icons';
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
  const podcast = createMemo(() => Boolean(track() && isPodcastTrack(track()!)));
  const loading = createMemo(() => player().playback.isLoading);
  const loadFailed = createMemo(() => player().playback.loadError);
  const backLabel = createMemo(() =>
    props.mode === 'auto' ? t('autoMode.panel.stage') : t('nowPlaying.panel.stage'),
  );

  const next = () => {
    if (podcast()) player().actions.seekBy(15);
    else if (props.mode === 'auto') void player().actions.autoSkip();
    else player().actions.next();
  };

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
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" />
                  </svg>
                </Match>
                <Match when={loading()}>
                  <Spinner size={18} />
                </Match>
                <Match when={player().playback.isPlaying}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" />
                  </svg>
                </Match>
                <Match when={true}>
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path fill="currentColor" d="M8 5v14l11-7z" />
                  </svg>
                </Match>
              </Switch>
            </Control>
            <Control
              class={styles.ctrl}
              aria-label={podcast() ? t('podcasts.skipForward') : t('common.next')}
              aria-busy={player().pending('next') || undefined}
              data-pending={player().pending('next') || undefined}
              disabled={player().unreachable}
              onClick={next}
            >
              <Show
                when={podcast()}
                fallback={
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                    <path fill="currentColor" d="M16 6h2v12h-2zm-1.5 6L6 6v12z" />
                  </svg>
                }
              >
                <PodcastSkipIcon size={20} />
              </Show>
            </Control>
          </div>
        </div>
      )}
    </Show>
  );
}
