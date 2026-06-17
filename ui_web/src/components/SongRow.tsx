import { Show, type JSX } from 'solid-js';
import type { Track } from '../types/music';
import styles from './SongRow.module.css';

export interface SongRowProps {
  track: Track;
  /** 1-based list position; omit to hide the index column. */
  index?: number;
  /** Resolved cover URL; falls back to track.cover, then a gradient placeholder. */
  cover?: string;
  active?: boolean;
  favorite?: boolean;
  onPlay?: (track: Track) => void;
  onToggleFavorite?: (id: string) => void;
  /** When set, the artist name becomes a tappable link (navigates to the artist). */
  onArtist?: (artist: string) => void;
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
 */
export default function SongRow(props: SongRowProps) {
  return (
    <div
      classList={{ [styles.row]: true, [styles.active]: props.active }}
      onClick={() => props.onPlay?.(props.track)}
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
      <button
        class={styles.iconBtn}
        classList={{ [styles.faved]: props.favorite }}
        aria-label={props.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos'}
        aria-pressed={props.favorite}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleFavorite?.(props.track.id);
        }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 21s-7.5-4.6-10-9.3C.6 8.9 2 5.6 5.1 5.1c1.9-.3 3.6.6 4.9 2 1.3-1.4 3-2.3 4.9-2 3.1.5 4.5 3.8 3.1 6.6C19.5 16.4 12 21 12 21z"
          />
        </svg>
      </button>
      <span class={styles.duration}>{formatDuration(props.track.duration)}</span>
    </div>
  );
}
