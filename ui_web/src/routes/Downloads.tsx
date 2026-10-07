import Button from '../components/Button';
import { registerPrimaryScroll } from '../lib/scrollHistory';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
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

  useAppBar({
    title: () => t('downloads.title'),
    actions: () => counts().failed > 0
      ? [{ label: t('downloads.clearErrors'), icon: () => <TrashIcon />, onSelect: () => void actions.clearFailedDownloads() }]
      : [],
  });

  return (
    <div class="view">
      <Show when={desktopShell()}>
      <header class={styles.header}>
        <div class={styles.titleWrap}>
          <h1 class={styles.title}>{t('downloads.title')}</h1>
          <span class={styles.count}>
            <Show when={counts().active > 0} fallback={t('downloads.noActive')}>
              {t('downloads.countActive', { active: counts().active })}{counts().failed > 0 ? t('downloads.countFailed', { failed: counts().failed }) : ''}
            </Show>
          </span>
        </div>
        <Show when={counts().failed > 0}>
          <button class={styles.clear} type="button" onClick={() => actions.clearFailedDownloads()}>
            {t('downloads.clearErrors')}
          </button>
        </Show>
      </header>
      </Show>

      <div ref={(element) => registerPrimaryScroll(element)} class={styles.scroll} data-primary-scroll>
        <Show when={failed()}><p role="status">{t('common.loadFailed')} <Button variant="secondary" onClick={() => void load()}>{t('common.retry')}</Button></p></Show>
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

        <Show
          when={items().length > 0}
          fallback={
            <Show when={state.downloads.recent.length === 0 && !failed()}>
              <Show when={!loading()} fallback={<SkeletonRows />}>
              <div class={styles.empty}>
                <p class={styles.emptyTitle}>{t('downloads.emptyTitle')}</p>
                <p class={styles.emptyText}>
                  {t('downloads.emptyBody')}
                </p>
              </div>
              </Show>
            </Show>
          }
        >
          <For each={items()}>{(i) => <DownloadRow item={i} />}</For>
        </Show>

        <Show when={hasClearable()}>
          <button class={styles.clearAll} type="button" onClick={() => actions.clearDownloads()}>
            {t('downloads.clearQueue')}
          </button>
        </Show>
      </div>
    </div>
  );
}

function DownloadRow(props: { item: DownloadQueueItem }) {
  return <DownloadRowView item={props.item} retry={id => void actions.retryDownload(id)} remove={id => void actions.removeDownload(id)} />;
}
