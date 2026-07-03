import { Show, type JSX } from 'solid-js';
import type { Track } from '../types/music';
import { t } from '../lib/i18n';
import styles from './SongRow.module.css';

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

function formatDuration(seconds?: number): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function gradientFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 45% 28%), hsl(${(h + 40) % 360} 50% 18%))`;
}

/** Layered background: cover on top, deterministic gradient underneath, so a
 * missing/404 cover degrades gracefully instead of showing a broken image. */
function coverStyle(props: SongRowProps): JSX.CSSProperties {
  const grad = gradientFor(props.track.id);
  const url = props.cover ?? props.track.cover;
  return url
    ? { background: `url("${url}") center / cover no-repeat, ${grad}` }
    : { background: grad };
}

/**
 * Dense, pro song row. Fine-grained reactivity: toggling `active`/`favorite`
 * updates only the affected node — no row or list re-render.
 *
 * Context menu: a ⋯ button (always), plus long-press (touch) and right-click
 * (pointer) — restoring the action menu the legacy UI had on every row.
 */
export default function SongRow(props: SongRowProps) {
  let pressTimer: number | undefined;
  let suppressClick = false;

  const openMenu = (ev?: MouseEvent) => props.onMenu?.(props.track, ev);

  const startPress = () => {
    if (!props.onMenu) return;
    pressTimer = window.setTimeout(() => {
      suppressClick = true;
      openMenu(); // long-press → bottom sheet (no cursor anchor)
    }, 450);
  };
  const cancelPress = () => clearTimeout(pressTimer);

  const onRowClick = () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    props.onPlay?.(props.track);
  };

  const onContext = (e: MouseEvent) => {
    if (!props.onMenu) return;
    e.preventDefault();
    openMenu(e);
  };

  return (
    <div
      classList={{ [styles.row]: true, [styles.active]: props.active }}
      onClick={onRowClick}
      onContextMenu={onContext}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
    >
      <Show when={props.index != null}>
        <span class={styles.index}>{props.index}</span>
      </Show>
      <div class={styles.cover} style={coverStyle(props)} />
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
