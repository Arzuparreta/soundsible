import { createMemo, For, Show, onMount, type JSX } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { state, actions, downloadCounts } from '../stores';
import { t } from '../lib/i18n';
import type { DownloadQueueItem } from '../types/download';
import styles from './Downloads.module.css';

function titleOf(i: DownloadQueueItem): string {
  return i.display_title || i.podcast_title || i.song_str || t('downloads.fallbackTitle');
}
function artistOf(i: DownloadQueueItem): string {
  return i.display_artist || i.podcast_show_title || '';
}

function gradientFor(id: string): string {
  let h = 0;
  for (let k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 28%), hsl(${(h + 40) % 360} 50% 18%))`;
}

interface ProgressView {
  failed: boolean;
  percent: number | null;
  indeterminate: boolean;
  phaseLabel: string;
  detailLabel: string;
}

/** Mirrors the legacy `getDownloadProgressView`, in Spanish. */
function progressView(i: DownloadQueueItem): ProgressView {
  const failed = i.status === 'failed' || i.status === 'interrupted';
  const raw = Number(i.progress_percent);
  const hasPct = i.progress_percent != null && Number.isFinite(raw);
  const percent = hasPct ? Math.min(100, Math.max(0, raw)) : null;
  const indeterminate = i.status === 'downloading' && percent == null;

  let phaseLabel: string;
  if (failed) {
    phaseLabel =
      i.status === 'interrupted'
        ? t('downloads.phaseInterrupted')
        : percent == null
          ? t('downloads.phaseFailed')
          : t('downloads.phaseFailedPercent', { percent: Math.round(percent) });
  } else if (i.phase === 'preparing') phaseLabel = t('downloads.phasePreparing');
  else if (i.phase === 'processing') phaseLabel = t('downloads.phaseProcessing');
  else if (i.status === 'downloading') phaseLabel = t('downloads.phaseDownloading');
  else phaseLabel = t('downloads.phasePending');

  const detailLabel = failed
    ? i.error_message || t('downloads.failedDetail')
    : [i.speed, i.eta].filter(Boolean).join(' · ');

  return { failed, percent, indeterminate, phaseLabel, detailLabel };
}

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
 * so only the changed row re-renders. Retry/remove/clear are optimistic.
 */
export default function Downloads() {
  const navigate = useNavigate();
  onMount(() => void actions.loadDownloads());

  const items = createMemo(() =>
    [...state.downloads.queue].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9)),
  );
  const counts = createMemo(() => downloadCounts());
  const hasClearable = createMemo(() => state.downloads.queue.some((i) => i.status !== 'downloading'));

  return (
    <div class="view">
      <header class={styles.header}>
        <button class={styles.back} type="button" aria-label={t('downloads.ariaBack')} onClick={() => navigate('/')}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
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

      <div class={styles.scroll}>
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
            <Show when={state.downloads.recent.length === 0}>
              <div class={styles.empty}>
                <p class={styles.emptyTitle}>{t('downloads.emptyTitle')}</p>
                <p class={styles.emptyText}>
                  {t('downloads.emptyBody')}
                </p>
              </div>
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
  const v = createMemo(() => progressView(props.item));
  const coverBg = (): JSX.CSSProperties => {
    const grad = gradientFor(props.item.id);
    const url = props.item.thumbnail_url;
    return url
      ? { background: `url("${url}") center / cover no-repeat, ${grad}` }
      : { background: grad };
  };

  return (
    <div classList={{ [styles.row]: true, [styles.rowFailed]: v().failed }}>
      <div class={styles.cover} style={coverBg()} />
      <div class={styles.body}>
        <div class={styles.meta}>
          <span class={styles.rowTitle}>{titleOf(props.item)}</span>
          <Show when={artistOf(props.item)}>
            <span class={styles.rowArtist}>{artistOf(props.item)}</span>
          </Show>
        </div>

        <div class={styles.track}>
          <div
            classList={{ [styles.fill]: true, [styles.indeterminate]: v().indeterminate, [styles.fillFailed]: v().failed }}
            style={{ width: v().indeterminate ? '100%' : `${v().percent ?? (v().failed ? 100 : 0)}%` }}
          />
        </div>

        <div class={styles.status}>
          <span classList={{ [styles.phase]: true, [styles.phaseFailed]: v().failed }}>{v().phaseLabel}</span>
          <Show when={v().detailLabel}>
            <span class={styles.detail}>{v().detailLabel}</span>
          </Show>
        </div>
      </div>

      <div class={styles.actions}>
        <Show when={v().failed}>
          <button
            class={styles.iconBtn}
            type="button"
            aria-label={t('downloads.ariaRetry')}
            onClick={() => actions.retryDownload(props.item.id)}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5" />
            </svg>
          </button>
        </Show>
        <button
          class={styles.iconBtn}
          type="button"
          aria-label={v().failed ? t('downloads.ariaRemove') : t('downloads.ariaCancel')}
          onClick={() => actions.removeDownload(props.item.id)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
