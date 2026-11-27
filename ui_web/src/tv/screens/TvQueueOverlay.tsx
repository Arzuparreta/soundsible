import { createEffect, onCleanup, Show, untrack } from 'solid-js';
import { Control } from '../../design/Control';
import { t } from '../../lib/i18n';
import { trackCoverUrl } from '../../lib/media';
import { actions, state } from '../../stores';
import { TvTrackRow } from '../components/TvTrackRow';
import { TvVirtualList, tvListItemId } from '../components/TvVirtualList';
import { useTvFocus } from '../nav/spatial';
import { queueOpen, setQueueOpen } from '../state';
import styles from '../styles/tv.module.css';

export function TvQueueOverlay() {
  const focus = useTvFocus();

  createEffect(() => {
    if (!queueOpen()) return;
    const initialRow = untrack(() =>
      state.playback.queue.length > 0
        ? tvListItemId('tv-queue-rows', state.playback.queue[Math.max(0, state.playback.index)]?.queueId ?? '')
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
              itemKey={entry => entry.queueId}
              groupId="tv-queue-rows"
              order={20}

              initialIndex={Math.max(0, state.playback.index)}
              insideModal
              railEdge={false}
              renderRow={(entry, index, tvId) => {
                const isCurrent = () => index() === state.playback.index;
                return (
                  <TvTrackRow
                    id={tvId()}
                    group="tv-queue-rows"
                    index={index()}
                    title={entry().title}
                    artist={entry().artist}
                    artwork={trackCoverUrl(entry(), 'thumb')}
                    duration={entry().duration}
                    playing={isCurrent()}
                    onActivate={() => {
                      actions.playQueueEntry(entry().queueId);
                      setQueueOpen(false);
                    }}
                  />
                );
              }}
            />
          </Show>
        </section>
      </div>
    </Show>
  );
}
