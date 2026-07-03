import { Show, type JSX } from 'solid-js';
import type { SearchResult } from '../types/music';
import { t } from '../lib/i18n';
import styles from './SearchResultRow.module.css';

function fmtDur(s?: number): string {
  if (s == null || !Number.isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x.toString().padStart(2, '0')}`;
}

export interface SearchResultRowProps {
  r: SearchResult;
  active: boolean;
  inLibrary: boolean;
  enqueued: boolean;
  /** Tap the row to preview-stream the result. */
  onPreview: () => void;
  /** Add (enqueue download into the library). */
  onAdd: () => void;
  /** When set, shows a "radio / more like this" button. */
  onRadio?: () => void;
}

/**
 * One online (YouTube / YouTube-Music) search result. Shared by Discover and
 * the unified Search: tap to preview, ＋ to add to the library (spinner while
 * queued, ✓ once it's in the library), optional radio seed.
 */
export default function SearchResultRow(props: SearchResultRowProps) {
  const bg = (): JSX.CSSProperties =>
    props.r.thumbnail
      ? { background: `url("${props.r.thumbnail}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };

  return (
    <div classList={{ [styles.row]: true, [styles.active]: props.active }} onClick={props.onPreview}>
      <div class={styles.cover} style={bg()} />
      <div class={styles.meta}>
        <span class={styles.title}>{props.r.title}</span>
        <span class={styles.sub}>{props.r.channel}</span>
      </div>
      <span class={styles.dur}>{fmtDur(props.r.duration)}</span>
      <Show when={props.onRadio}>
        <button
          class={styles.iconBtn}
          type="button"
          aria-label={t('searchResultRow.ariaRadio')}
          onClick={(e) => {
            e.stopPropagation();
            props.onRadio!();
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </Show>
      <Show
        when={props.inLibrary}
        fallback={
          <Show
            when={props.enqueued}
            fallback={
              <button
                class={styles.addBtn}
                type="button"
                aria-label={t('searchResultRow.ariaAdd')}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onAdd();
                }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            }
          >
            <span class={styles.spinner} aria-label={t('searchResultRow.ariaDownloading')} />
          </Show>
        }
      >
        <span class={styles.done} aria-label={t('searchResultRow.ariaInLibrary')}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M5 12l5 5L20 7" />
          </svg>
        </span>
      </Show>
    </div>
  );
}
