import { createMemo, For, Show, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { state } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { coverUrl } from '../lib/media';
import { pickPlaylistCoverId } from '../lib/playlists';
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

  return (
    <div class="view">
      <ViewHeader title="Listas" meta={`${names().length}`} />
      <div class={styles.scroll}>
        <Show when={names().length > 0} fallback={<p class={styles.empty}>Aún no tienes listas.</p>}>
          <div class={styles.grid}>
            <For each={names()}>
              {(name) => {
                const ids = () => state.playlists[name] ?? [];
                return (
                  <A href={`/playlists/${encodeURIComponent(name)}`} class={styles.card}>
                    <div class={styles.cover} style={coverBg(name, ids())} />
                    <span class={styles.name}>{name}</span>
                    <span class={styles.count}>{ids().length} pistas</span>
                  </A>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
