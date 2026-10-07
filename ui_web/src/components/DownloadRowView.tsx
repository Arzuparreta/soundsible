import { createMemo, Show, type JSX } from 'solid-js';
import { t } from '../lib/i18n';
import { coverStyle } from '../lib/cover';
import type { DownloadQueueItem } from '../types/download';
import styles from '../routes/Downloads.module.css';

function titleOf(i: DownloadQueueItem): string {
  return i.display_title || i.podcast_title || i.song_str || t('downloads.fallbackTitle');
}
function artistOf(i: DownloadQueueItem): string {
  return i.display_artist || i.podcast_show_title || '';
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

export function DownloadRowView(props: { item: DownloadQueueItem; disabled?: boolean; retry(id: string): void; remove(id: string): void }) {
  const v = createMemo(() => progressView(props.item));
  const coverBg = (): JSX.CSSProperties => coverStyle(props.item.id, props.item.thumbnail_url);

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
            disabled={props.disabled}
            onClick={() => props.retry(props.item.id)}
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
          disabled={props.disabled}
          onClick={() => props.remove(props.item.id)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
