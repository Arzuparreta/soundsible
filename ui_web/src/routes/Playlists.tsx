import { createMemo, For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { coverUrl } from '../lib/media';
import { pickPlaylistCoverId } from '../lib/playlists';
import { openPlaylistMenu } from '../components/playlistActions';
import { promptDialog } from '../lib/prompt';
import type { Track } from '../types/music';
import styles from './Playlists.module.css';

export default function Playlists() {
  const byId = createMemo(() => new Map(state.library.map((t) => [t.id, t] as const)));
  const names = createMemo(() => Object.keys(state.playlists));

  const coverBg = (name: string, ids: string[]): JSX.CSSProperties => {
    const grad = 'linear-gradient(135deg, var(--bg-elevated), var(--bg-inset))';
    const id = pickPlaylistCoverId(name, ids, byId() as Map<string, Track>, state.librarySettings);
    return id ? { background: `url("${coverUrl(id)}") center / cover no-repeat, ${grad}` } : { background: grad };
  };

  const createNew = async () => {
    const name = await promptDialog({ title: 'Nueva lista', placeholder: 'Nombre de la lista', confirmLabel: 'Crear' });
    if (name) void actions.createPlaylist(name);
  };

  const menu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    e.stopPropagation();
    openPlaylistMenu(name);
  };

  return (
    <div class="view">
      <ViewHeader title="Listas" meta={`${names().length}`} />
      <div class={styles.scroll}>
        <button class={styles.newBtn} type="button" onClick={createNew}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Nueva lista
        </button>
        <Show when={names().length > 0} fallback={<p class={styles.empty}>Aún no tienes listas.</p>}>
          <div class={styles.grid}>
            <For each={names()}>
              {(name) => {
                const ids = () => state.playlists[name] ?? [];
                return (
                  <div class={styles.cardWrap}>
                    <A href={`/playlists/${encodeURIComponent(name)}`} class={styles.card}>
                      <div class={styles.cover} style={coverBg(name, ids())} />
                      <span class={styles.name}>{name}</span>
                      <span class={styles.count}>{ids().length} pistas</span>
                    </A>
                    <button
                      class={styles.cardMenu}
                      type="button"
                      aria-label="Opciones de la lista"
                      onClick={(e) => menu(e, name)}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="19" cy="12" r="2" />
                      </svg>
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
