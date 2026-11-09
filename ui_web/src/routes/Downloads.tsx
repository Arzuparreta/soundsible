import Button from '../components/Button';
import { A } from '@solidjs/router';
import button from '../components/Button.module.css';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { ViewHeader } from '../components/ViewHeader';
import { EmptyState } from '../components/EmptyState';
import { TrashIcon } from '../components/icons';
import { createMemo, createSignal, For, Show, onMount } from 'solid-js';
import { state, actions, downloadCounts } from '../stores';
import { t } from '../lib/i18n';
import type { DownloadQueueItem } from '../types/download';
import styles from './Downloads.module.css';
import { SkeletonRows } from '../components/Skeleton';
import { DownloadRowView } from '../components/DownloadRowView';

const RANK: Record<string, number> = {
  downloading: 0,
  pending: 1,
  failed: 2,
  interrupted: 2,
  completed: 3,
};

/**
 * Downloads: the live mirror of the engine queue. Binds to the single store —
 * `downloader_update` events drive every progress bar with fine-grained updates,
 * so only the changed row re-renders. Retry/remove/clear wait for durable server confirmation.
 */
export default function Downloads() {
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const load = async () => {
    setLoading(true);
    setFailed(false);
    try { setFailed(!(await actions.loadDownloads())); }
    finally { setLoading(false); }
  };
  onMount(() => void load());

  const items = createMemo(() =>
    [...state.downloads.queue].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)),
  );
  const counts = createMemo(() => downloadCounts());
  const hasClearable = createMemo(() => state.downloads.queue.some((i) => i.status !== 'downloading'));

  const summary = () => counts().active > 0
    ? `${t('downloads.countActive', { active: counts().active })}${counts().failed > 0 ? t('downloads.countFailed', { failed: counts().failed }) : ''}`
    : t('downloads.noActive');

  return (
    <div class="view">
      <ViewHeader
        title={t('downloads.title')}
        meta={summary()}
        barActions={counts().failed > 0
          ? [{ label: t('downloads.clearErrors'), icon: () => <TrashIcon />, onSelect: () => void actions.clearFailedDownloads() }]
          : []}
        actions={counts().failed > 0 ? (
          <button class={styles.clear} type="button" onClick={() => void actions.clearFailedDownloads()}>
            {t('downloads.clearErrors')}
          </button>
        ) : undefined}
      />

      <div ref={(element) => registerPrimaryScroll(element)} class={styles.scroll} data-primary-scroll>
        <Show when={failed()}>
          <EmptyState compact tone="danger">
            {t('common.loadFailed')} <Button variant="secondary" onClick={() => void load()}>{t('common.retry')}</Button>
          </EmptyState>
        </Show>

        <Show
          when={items().length > 0 || state.downloads.recent.length > 0}
          fallback={
            <Show when={!failed()}>
              <Show when={!loading()} fallback={<SkeletonRows />}>
                <EmptyState>
                  <strong class={styles.emptyTitle}>{t('downloads.emptyTitle')}</strong>
                  <p>{t('downloads.emptyBody')}</p>
                  <A href="/search" class={`${button.btn} ${button.secondary} ${button.sm}`}>{t('nav.search')}</A>
                </EmptyState>
              </Show>
            </Show>
          }
        >
          <div class={styles.column}>
            <For each={state.downloads.recent}>
              {(r) => (
                <div class={styles.recentRow}>
                  <span class={styles.recentCheck} aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </span>
                  <span class={styles.recentMeta}>
                    <span class={styles.recentTitle}>{r.title}</span>
                    <span class={styles.recentSub}>{t('downloads.recentSubtitle')}</span>
                  </span>
                </div>
              )}
            </For>

            <For each={items()}>{(i) => <DownloadRow item={i} />}</For>

            <Show when={hasClearable()}>
              <button class={styles.clearAll} type="button" onClick={() => actions.clearDownloads()}>
                {t('downloads.clearQueue')}
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

function DownloadRow(props: { item: DownloadQueueItem }) {
  return <DownloadRowView item={props.item} retry={id => void actions.retryDownload(id)} remove={id => void actions.removeDownload(id)} />;
}
