import { createMemo, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { state, downloadCounts } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import styles from './Home.module.css';

/** Library view: real engine data, virtualized list, play + favourite wired. */
export default function Home() {
  const active = createMemo(() => downloadCounts().active);
  return (
    <div class="view">
      <ViewHeader title="Tu biblioteca" meta={`${state.library.length} pistas`} />
      <nav class={styles.chips}>
        <A href="/favourites" class={styles.chip}>
          Favoritos
        </A>
        <A href="/playlists" class={styles.chip}>
          Listas
        </A>
        <A href="/podcasts" class={styles.chip}>
          Podcasts
        </A>
        <A href="/downloads" class={styles.chip}>
          Descargas
          <Show when={active() > 0}>
            <span class={styles.badge}>{active()}</span>
          </Show>
        </A>
      </nav>
      <TrackList
        tracks={state.library}
        loading={state.loading}
        empty={<p class={styles.empty}>Tu biblioteca está vacía. Descarga algo desde Discover.</p>}
      />
    </div>
  );
}
