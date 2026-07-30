import { For, Show } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { state, actions } from '../stores';
import { promptDialog } from '../lib/prompt';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import styles from './PlaylistPicker.module.css';
import { EmptyState } from './EmptyState';
import { createResponsiveTap } from '../lib/responsiveTap';

/** Sheet to add a track to an existing playlist, or create a new one inline. */
export function openPlaylistPicker(track: Track): void {
  openOverlay((close) => {
    const names = () => Object.keys(state.playlists);
    const createNew = async () => {
      const name = await promptDialog({
        title: t('playlistPicker.new'),
        placeholder: t('playlistPicker.newPlaceholder'),
        confirmLabel: t('playlistPicker.newConfirm'),
      });
      if (!name) return;
      const ok = await actions.createPlaylist(name);
      if (ok) {
        await actions.addToPlaylist(name, track.id);
        close();
      }
    };
    const addTo = (name: string) => {
      void actions.addToPlaylist(name, track.id);
      close();
    };
    const newTap = createResponsiveTap({ onTap: () => void createNew() });
    return (
      <div class={styles.picker}>
        <header class={styles.head}>
          <span class={styles.title}>{t('playlistPicker.title')}</span>
        </header>
        <button class={styles.new} type="button" data-pressable {...newTap}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {t('playlistPicker.new')}
        </button>
        <Show when={names().length > 0} fallback={<EmptyState compact>{t('playlistPicker.empty')}</EmptyState>}>
          <div class={styles.list}>
            <For each={names()}>
              {(name) => {
                const tap = createResponsiveTap({ onTap: () => addTo(name) });
                return (
                  <button class={styles.item} type="button" data-pressable {...tap}>
                    <span class={styles.itemName}>{name}</span>
                    <span class={styles.itemCount}>{(state.playlists[name] ?? []).length}</span>
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
