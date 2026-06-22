import { createMemo, Show } from 'solid-js';
import { A } from '@solidjs/router';
import { state, downloadCounts } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import ArtistGrid from '../components/ArtistGrid';
import { trackCount } from '../lib/format';
import { librarySort, setLibrarySort, libraryTab, setLibraryTab, sortTracks, buildArtists } from '../lib/libraryView';
import styles from './Home.module.css';

/** Library view: songs (sortable, virtualized) or artists browser. */
export default function Home() {
  const active = createMemo(() => downloadCounts().active);
  const favSet = createMemo(() => new Set(state.favorites));
  const sorted = createMemo(() => sortTracks(state.library, librarySort(), favSet()));
  const artists = createMemo(() => buildArtists(state.library));

  return (
    <div class="view">
      <ViewHeader title="Tu biblioteca" meta={trackCount(state.library.length)} />
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

      <div class={styles.toolbar}>
        <div class={styles.tabs}>
          <button
            class={styles.tab}
            classList={{ [styles.tabActive]: libraryTab() === 'songs' }}
            type="button"
            onClick={() => setLibraryTab('songs')}
          >
            Canciones
          </button>
          <button
            class={styles.tab}
            classList={{ [styles.tabActive]: libraryTab() === 'artists' }}
            type="button"
            onClick={() => setLibraryTab('artists')}
          >
            Artistas
          </button>
        </div>
        <Show when={libraryTab() === 'songs'}>
          <select class={styles.select} value={librarySort()} onChange={(e) => setLibrarySort(e.currentTarget.value)}>
            <option value="recent">Recientes</option>
            <option value="az">A–Z</option>
            <option value="fav">Favoritos primero</option>
          </select>
        </Show>
      </div>

      <Show
        when={libraryTab() === 'songs'}
        fallback={
          <Show
            when={artists().length > 0}
            fallback={<p class={styles.empty}>No hay artistas todavía.</p>}
          >
            <div class={styles.artistsScroll}>
              <ArtistGrid artists={artists()} />
            </div>
          </Show>
        }
      >
        <TrackList
          tracks={sorted()}
          loading={state.loading}
          empty={<p class={styles.empty}>Tu biblioteca está vacía. Descarga algo desde Discover.</p>}
        />
      </Show>
    </div>
  );
}
