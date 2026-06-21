import { For, Show } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { state, actions } from '../stores';
import { promptDialog } from '../lib/prompt';
import type { Track } from '../types/music';
import styles from './PlaylistPicker.module.css';

/** Sheet to add a track to an existing playlist, or create a new one inline. */
export function openPlaylistPicker(track: Track): void {
  openOverlay((close) => {
    const names = () => Object.keys(state.playlists);
    const createNew = async () => {
      const name = await promptDialog({
        title: 'Nueva lista',
        placeholder: 'Nombre de la lista',
        confirmLabel: 'Crear',
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
    return (
      <div class={styles.picker}>
        <header class={styles.head}>
          <span class={styles.title}>Añadir a playlist</span>
        </header>
        <button class={styles.new} type="button" onClick={createNew}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Nueva lista
        </button>
        <Show when={names().length > 0} fallback={<p class={styles.empty}>No tienes listas todavía.</p>}>
          <div class={styles.list}>
            <For each={names()}>
              {(name) => (
                <button class={styles.item} type="button" onClick={() => addTo(name)}>
                  <span class={styles.itemName}>{name}</span>
                  <span class={styles.itemCount}>{(state.playlists[name] ?? []).length}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    );
  });
}
