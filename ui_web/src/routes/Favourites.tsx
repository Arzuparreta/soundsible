import { createMemo } from 'solid-js';
import { state, musicLibrary } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import { trackCount } from '../lib/format';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';

/** Favourites = music library tracks whose id is in `favorites`, in favourites
 * order. Podcasts are excluded — they live under their own section. */
export default function Favourites() {
  const favTracks = createMemo<Track[]>(() => {
    const byId = new Map(musicLibrary().map((t) => [t.id, t]));
    return state.favorites.map((id) => byId.get(id)).filter((t): t is Track => !!t);
  });

  return (
    <div class="view">
      <ViewHeader title={t('favourites.title')} meta={trackCount(favTracks().length)} />
      <TrackList
        tracks={favTracks()}
        loading={state.loading}
        empty={
          <p style={{ padding: '48px 16px', 'text-align': 'center', color: 'var(--ink-secondary)' }}>
            {t('favourites.empty')}
          </p>
        }
      />
    </div>
  );
}
