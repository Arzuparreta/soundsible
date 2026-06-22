import { createMemo } from 'solid-js';
import { state } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import { trackCount } from '../lib/format';
import type { Track } from '../types/music';

/** Favourites = library tracks whose id is in `favorites`, in favourites order. */
export default function Favourites() {
  const favTracks = createMemo<Track[]>(() => {
    const byId = new Map(state.library.map((t) => [t.id, t]));
    return state.favorites.map((id) => byId.get(id)).filter((t): t is Track => !!t);
  });

  return (
    <div class="view">
      <ViewHeader title="Favoritos" meta={trackCount(favTracks().length)} />
      <TrackList
        tracks={favTracks()}
        loading={state.loading}
        empty={
          <p style={{ padding: '48px 16px', 'text-align': 'center', color: 'var(--ink-secondary)' }}>
            Aún no tienes favoritos. Toca el corazón en cualquier canción.
          </p>
        }
      />
    </div>
  );
}
