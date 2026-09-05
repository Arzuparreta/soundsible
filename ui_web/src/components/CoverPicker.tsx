import { For, Show, createMemo, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { state, actions, musicLibrary } from '../stores';
import { trackCoverUrl } from '../lib/media';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import { coverStyle } from '../lib/cover';
import styles from './CoverPicker.module.css';
import { EmptyState } from './EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';

/**
 * Choose a playlist's cover from one of its own tracks, or clear it (auto).
 * Playlist covers are set server-side via `cover_track_id`, so the choices are
 * the tracks already in the playlist — no file upload here.
 */
export function openPlaylistCoverPicker(name: string): void {
  openOverlay((close) => {
    const tracks = createMemo<Track[]>(() => {
      const byId = new Map(musicLibrary().map((t) => [t.id, t] as const));
      return (state.playlists[name] ?? []).map((id) => byId.get(id)).filter((t): t is Track => !!t);
    });
    const current = () => state.librarySettings.playlist_covers?.[name];

    // A saved-but-not-downloaded song carries its own thumbnail and has nothing
    // at the engine's cover endpoint, so asking by id drew an empty cell for it.
    const bg = (track: Track): JSX.CSSProperties => coverStyle(track.id, trackCoverUrl(track));

    const pick = (id: string | null) => {
      void actions.setPlaylistCover(name, id);
      close();
    };
    const noneTap = createResponsiveTap({ onTap: () => pick(null) });

    return (
      <div class={styles.picker}>
        <header class={styles.head}>
          <span class={styles.title}>{t('coverPicker.header', { name })}</span>
        </header>
        <button class={styles.none} type="button" data-pressable {...noneTap}>
          {t('coverPicker.none')}
        </button>
        <Show when={tracks().length > 0} fallback={<EmptyState compact>{t('coverPicker.empty')}</EmptyState>}>
          <div class={styles.grid}>
            <For each={tracks()}>
              {(t) => {
                const tap = createResponsiveTap({ onTap: () => pick(t.id) });
                return (
                  <button
                    class={styles.cell}
                    classList={{ [styles.selected]: current() === t.id }}
                    type="button"
                    aria-label={t.title}
                    data-pressable
                    {...tap}
                  >
                    <span class={styles.cover} style={bg(t)} />
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    );
  });
}
