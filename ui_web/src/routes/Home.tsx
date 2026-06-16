import { A } from '@solidjs/router';
import { state } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import styles from './Home.module.css';

/** Library view: real engine data, virtualized list, play + favourite wired. */
export default function Home() {
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
      </nav>
      <TrackList
        tracks={state.library}
        loading={state.loading}
        empty={<p class={styles.empty}>Tu biblioteca está vacía. Descarga algo desde Discover.</p>}
      />
    </div>
  );
}
