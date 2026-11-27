import { createEffect, onCleanup, Show, untrack } from 'solid-js';
import { Control } from '../../design/Control';
import { formatDuration } from '../../lib/format';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { actions, state } from '../../stores';
import { TvArtwork } from '../components/TvArtwork';
import { TvVirtualList } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { queueOpen, setQueueOpen } from '../state';
import styles from '../styles/tv.module.css';

export function TvQueueOverlay() {
  const focus = useTvFocus();

  createEffect(() => {
    if (!queueOpen()) return;
    const initialRow = untrack(() =>
      state.playback.queue.length > 0
        ? `tv-queue-rows-item-${Math.max(0, state.playback.index)}`
        : 'tv-queue-close',
    );
    focus.pushModal('tv-queue', initialRow);

    const unregisterBack = focus.registerBackHandler(() => {
      if (!queueOpen()) return false;
      setQueueOpen(false);
      return true;
    });

    onCleanup(() => {
      unregisterBack();
      focus.popModal('tv-queue');
    });
  });

  return (
    <Show when={queueOpen()}>
      <div class={styles.tvModalBackdrop} role="presentation">
        <section
          class={styles.tvModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tv-queue-heading"
          data-tv-modal="tv-queue"
          data-tv-scroll-y="tv-queue"
        >
          <header
            class={styles.tvHeaderBar}
            data-tv-group-container="tv-queue-header"
            data-tv-group-kind="row"
            data-tv-group-order="5"
            data-tv-rail-edge="none"
          >
            <h2 id="tv-queue-heading" class={styles.tvPageTitle}>
              {t('tv.player.queueTitle')}
            </h2>
            <Control
              data-tv-id="tv-queue-close"
              data-tv-group="tv-queue-header"
              data-tv-index="0"
              data-tv-focused={focus.activeId() === 'tv-queue-close' ? 'true' : undefined}
              class={styles.tvSecondaryBtn}
              classList={{ [styles.tvFocusTarget]: true }}
              onClick={() => setQueueOpen(false)}
            >
              {t('tv.close')}
            </Control>
          </header>

          <Show
            when={state.playback.queue.length > 0}
            fallback={<p class={styles.tvSubtitle}>{t('tv.player.queueEmpty')}</p>}
          >
            <TvVirtualList
              items={state.playback.queue}
              groupId="tv-queue-rows"
              order={20}
              maxVisible={12}
              initialIndex={Math.max(0, state.playback.index)}
              insideModal
              railEdge={false}
              renderRow={(entry, index, tvId) => {
                const isCurrent = () => index === state.playback.index;
                return (
                  <Control
                    role="listitem"
                    data-tv-id={tvId}
                    data-tv-group="tv-queue-rows"
                    data-tv-index={String(index)}
                    data-tv-focused={focus.activeId() === tvId ? 'true' : undefined}
                    class={styles.tvTrackRow}
                    classList={{
                      [styles.tvFocusTarget]: true,
                      [styles.tvTrackRowPlaying]: isCurrent(),
                    }}
                    onClick={() => {
                      actions.playQueueEntry(entry.queueId);
                      setQueueOpen(false);
                    }}
                  >
                    <TvArtwork
                      class={styles.tvTrackArt}
                      src={trackCoverUrl(entry, 'thumb')}
                      alt={entry.title}
                      fallbackLabel={entry.title}
                    />
                    <div class={styles.tvTrackMain}>
                      <span class={styles.tvTrackTitle}>{entry.title}</span>
                      <span class={styles.tvTrackSub}>{entry.artist}</span>
                    </div>
                    <Show when={isCurrent()}>
                      <span class={styles.tvPlayingBadge}>{t('tv.player.playingNow')}</span>
                    </Show>
                    <span class={styles.tvTrackDuration}>{formatDuration(entry.duration)}</span>
                  </Control>
                );
              }}
            />
          </Show>
        </section>
      </div>
    </Show>
  );
}
