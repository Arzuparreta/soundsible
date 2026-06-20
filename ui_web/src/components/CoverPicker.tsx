import { For, Show, createMemo, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { state, actions } from '../stores';
import { coverUrl } from '../lib/media';
import type { Track } from '../types/music';
import styles from './CoverPicker.module.css';

/**
 * Choose a playlist's cover from one of its own tracks, or clear it (auto).
 * Playlist covers are set server-side via `cover_track_id`, so the choices are
 * the tracks already in the playlist — no file upload here.
 */
export function openPlaylistCoverPicker(name: string): void {
  openOverlay((close) => {
    const tracks = createMemo<Track[]>(() => {
      const byId = new Map(state.library.map((t) => [t.id, t] as const));
      return (state.playlists[name] ?? []).map((id) => byId.get(id)).filter((t): t is Track => !!t);
    });
    const current = () => state.librarySettings.playlist_covers?.[name];

    const bg = (id: string): JSX.CSSProperties => ({
      background: `url("${coverUrl(id)}") center / cover no-repeat, var(--bg-inset)`,
    });

    const pick = (id: string | null) => {
      void actions.setPlaylistCover(name, id);
      close();
    };

    return (
      <div class={styles.picker}>
        <header class={styles.head}>
          <span class={styles.title}>Portada de «{name}»</span>
        </header>
        <button class={styles.none} type="button" onClick={() => pick(null)}>
          Sin portada (automática)
        </button>
        <Show when={tracks().length > 0} fallback={<p class={styles.empty}>La lista no tiene pistas.</p>}>
          <div class={styles.grid}>
            <For each={tracks()}>
              {(t) => (
                <button
                  class={styles.cell}
                  classList={{ [styles.selected]: current() === t.id }}
                  type="button"
                  aria-label={t.title}
                  onClick={() => pick(t.id)}
                >
                  <span class={styles.cover} style={bg(t.id)} />
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  });
}
