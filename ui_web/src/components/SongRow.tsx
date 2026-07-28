import { Show, type JSX } from 'solid-js';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import styles from './SongRow.module.css';
import { coverStyle } from '../lib/cover';
import { formatDuration } from '../lib/format';
import { createResponsiveTap } from '../lib/responsiveTap';

export interface SongRowProps {
  track: Track;
  /** 1-based list position; omit to hide the index column. */
  index?: number;
  /** Resolved cover URL; falls back to track.cover, then a gradient placeholder. */
  cover?: string;
  active?: boolean;
  onPlay?: (track: Track) => void;
  /** When set, the artist name becomes a tappable link (navigates to the artist). */
  onArtist?: (artist: string) => void;
  /** When set, exposes the context menu (⋯ button, long-press, right-click).
   * The event (when present) lets the menu anchor a popover at the cursor. */
  onMenu?: (track: Track, ev?: MouseEvent) => void;
}

/** Layered background: cover on top, deterministic gradient underneath, so a
 * missing/404 cover degrades gracefully instead of showing a broken image. */
function rowCoverStyle(props: SongRowProps): JSX.CSSProperties {
  return coverStyle(props.track.id, props.cover ?? props.track.cover);
}

/**
 * Dense, pro song row. Fine-grained reactivity: toggling `active`/`favorite`
 * updates only the affected node — no row or list re-render.
 *
 * Context menu: a ⋯ button (always), plus long-press (touch) and right-click
 * (pointer) — restoring the action menu the legacy UI had on every row.
 */
export default function SongRow(props: SongRowProps) {
  const openMenu = (ev?: MouseEvent) => props.onMenu?.(props.track, ev);

  const onRowClick = () => {
    props.onPlay?.(props.track);
  };
  const tap = createResponsiveTap({
    onTap: onRowClick,
    onLongPress: props.onMenu ? () => openMenu() : undefined,
  });

  const onContext = (e: MouseEvent) => {
    if (!props.onMenu) return;
    e.preventDefault();
    openMenu(e);
  };

  /** The row is the play button, so it has to answer the keys a button answers.
   * Without this the whole library was mouse-only: nothing in a list of
   * thousands of songs could be reached, let alone played, from the keyboard. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault(); // Space would scroll the list out from under the user
      props.onPlay?.(props.track);
      return;
    }
    // The context menu's keyboard equivalent, matching the ⋯ button and
    // long-press. No cursor to anchor to, so it opens as the sheet.
    if (props.onMenu && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      e.preventDefault();
      openMenu();
    }
  };

  /** What a screen reader announces for the row: what it is, then what
   * activating it does. The nested artist/menu buttons name themselves. */
  const label = () =>
    props.track.artist
      ? t('songRow.ariaPlay', { title: props.track.title, artist: props.track.artist })
      : props.track.title;

  return (
    <div
      class={styles.row}
      data-pressable
      data-now-playing={props.active ? '' : undefined}
      role="button"
      tabindex="0"
      aria-label={label()}
      // Announces which row is the one currently playing, so a screen-reader
      // user can find "where am I" without listening through the whole list.
      aria-current={props.active ? 'true' : undefined}
      {...tap}
      onKeyDown={onKeyDown}
      onContextMenu={onContext}
    >
      <Show when={props.index != null}>
        <span class={styles.index}>{props.index}</span>
      </Show>
      <div class={styles.cover} style={rowCoverStyle(props)} />
      <div class={styles.meta}>
        <span class={styles.title}>{props.track.title}</span>
        <Show
          when={props.onArtist && props.track.artist}
          fallback={<span class={styles.artist}>{props.track.artist}</span>}
        >
          <button
            class={styles.artistLink}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              props.onArtist!(props.track.artist);
            }}
          >
            {props.track.artist}
          </button>
        </Show>
      </div>
      <span class={styles.duration}>{formatDuration(props.track.duration)}</span>
      <Show when={props.onMenu}>
        <button
          class={styles.iconBtn}
          aria-label={t('songRow.ariaMore')}
          onClick={(e) => {
            e.stopPropagation();
            openMenu(e);
          }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
