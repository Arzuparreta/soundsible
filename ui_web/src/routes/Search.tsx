import { createMemo, createSignal } from 'solid-js';
import { state } from '../stores';
import TrackList from '../components/TrackList';
import type { Track } from '../types/music';
import styles from './Search.module.css';

/** Library search: client-side filter over the loaded library (title/artist/album). */
export default function Search() {
  const [q, setQ] = createSignal('');

  const results = createMemo<Track[]>(() => {
    const query = q().trim().toLowerCase();
    if (!query) return [];
    return state.library.filter(
      (t) =>
        t.title?.toLowerCase().includes(query) ||
        t.artist?.toLowerCase().includes(query) ||
        (t.album ?? '').toLowerCase().includes(query),
    );
  });

  return (
    <div class="view">
      <div class={styles.bar}>
        <input
          class={styles.input}
          type="search"
          placeholder="Buscar en tu biblioteca"
          value={q()}
          onInput={(e) => setQ(e.currentTarget.value)}
          autofocus
        />
      </div>
      <TrackList
        tracks={results()}
        empty={
          <p class={styles.hint}>{q().trim() ? 'Sin resultados.' : 'Escribe para buscar en tu biblioteca.'}</p>
        }
      />
    </div>
  );
}
