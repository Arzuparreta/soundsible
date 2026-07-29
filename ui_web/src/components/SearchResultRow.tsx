import { createMemo, Show, type JSX } from 'solid-js';
import type { SearchResult } from '../types/music';
import { t } from '../lib/i18n';
import { isSavedResult } from '../stores';
import { createResponsiveTap } from '../lib/responsiveTap';
import { savedFromSearchResult } from '../lib/saved';
import { FavouriteButton } from './FavouriteButton';
import { CollectionButton } from './CollectionButton';
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
  /** When set, shows a "radio / more like this" button. */
  onRadio?: () => void;
  /** Tap the row to preview-stream the result. */
  onPreview: () => void;
}

/**
 * One online (YouTube / YouTube-Music) search result. Shared by Discover and
 * the unified Search: tap to preview, ＋ to put it in your library, ⬇ to give
 * it a file, optional radio seed.
 *
 * The heart appears the moment the song is yours and not a second earlier —
 * marking a song out among the ones you have presupposes having it.
 */
export default function SearchResultRow(props: SearchResultRowProps) {
  const tap = createResponsiveTap({ onTap: props.onPreview });
  const entry = createMemo(() => savedFromSearchResult(props.r));
  const bg = (): JSX.CSSProperties =>
    props.r.thumbnail
      ? { background: `url("${props.r.thumbnail}") center / cover no-repeat, var(--bg-raised)` }
      : { background: 'var(--bg-raised)' };

  return (
    <div
      class={styles.row}
      data-pressable
      data-now-playing={props.active ? '' : undefined}
      role="button"
      tabindex="0"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        props.onPreview();
      }}
      {...tap}
    >
      <div class={styles.cover} style={bg()} />
      <div class={styles.meta}>
        <span class={styles.title}>{props.r.title}</span>
        <span class={styles.sub}>{props.r.channel}</span>
      </div>
      <span class={styles.dur}>{fmtDur(props.r.duration)}</span>
      <Show when={isSavedResult(props.r)}>
        <FavouriteButton favourite={entry()} compact />
      </Show>
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
      <CollectionButton entry={entry()} compact />
    </div>
  );
}
