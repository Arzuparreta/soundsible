import { CollectionEmpty, createCollectionSearch } from '../components/CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import { createMemo } from 'solid-js';
import { A } from '@solidjs/router';
import { favouriteRows, state } from '../stores';
import { player } from '../stores/player';
import { ViewHeader } from '../components/ViewHeader';
import TrackList from '../components/TrackList';
import { trackCount } from '../lib/format';
import { isPodcastTrack } from '../lib/track';
import { savedIsPlayable } from '../lib/saved';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import { EmptyState } from '../components/EmptyState';
import { CollectionActions } from '../components/CollectionActions';
import { favouritesContext } from '../lib/playbackContext';
import button from '../design/Button.module.css';
import styles from './Favourites.module.css';

const context = () => favouritesContext(t('favourites.title'));

/**
 * The songs you marked out, in the order you marked them.
 *
 * A slice of the library, not a second one: the heart says "this one, among the
 * ones I have", so everything here is already in Library. Whether a song has a
 * file makes no difference — an entry resolves to the owned track when the
 * library has it and to a streaming preview when it does not, so downloading
 * one later changes what it is here without moving it. Podcasts are excluded —
 * they live under their own section.
 */
export default function Favourites() {
  const rows = createMemo(() => favouriteRows().filter((row) => !isPodcastTrack(row.track)));
  const hasTracks = createMemo(() => rows().length > 0);
  const search = createCollectionSearch();
  const visibleRows = search.filter(rows, row => trackSearchFields(row.track));
  const visibleTracks = createMemo(() => visibleRows().map(row => row.track));
  const favTracks = createMemo<Track[]>(() => rows().map((row) => row.track));

  /**
   * A song saved from a Deezer/MusicBrainz row before it was ever played has no
   * source attached yet — the engine resolves one in the background, but the
   * user may well press play first. Resolve it here rather than handing the
   * queue an id nothing can stream. The lookup is cached server-side, so the
   * common case is one fast round trip and the rare case is an honest error.
   */
  const play = async (tracks: Track[], index: number) => {
    const row = visibleRows()[index];
    if (!row || savedIsPlayable(row.entry, row.track)) {
      player().actions.playFrom(tracks, index, { context: context() });
      return;
    }
    try {
      const resolved = await api.resolveCatalogItem({
        artist: row.entry.artist ?? '',
        title: row.entry.title ?? '',
        duration: row.entry.duration,
      });
      if (!resolved.video_id) throw new Error('not-found');
      // Only this row is swapped; its neighbours keep their own identities.
      const queue = tracks.slice();
      queue[index] = { ...row.track, id: resolved.video_id };
      player().actions.playFrom(queue, index, { context: context() });
    } catch {
      toast.error(t('search.noPreview'));
    }
  };

  return (
    <div class={`view ${styles.page}`}>
      <ViewHeader
        title={t('favourites.title')}
        search={hasTracks() ? search.reveal : undefined}
        meta={hasTracks() ? trackCount(rows().length) : undefined}
        actions={player().autoMode.active ? (
          <CollectionActions title={t('favourites.title')} tracks={favTracks()} />
        ) : undefined}
      />
      <TrackList
        tracks={visibleTracks()}
        context={context()}
        onPlay={(tracks, index) => void play(tracks, index)}
        loading={state.loading && !rows().length}
        empty={<CollectionEmpty source={rows().length}>
          <EmptyState>
            <p>{t('favourites.empty')}</p>
            {/* The hearts are given in the library, so that is the way on. */}
            <A href="/library" class={`${button.btn} ${button.secondary} ${button.sm} ${styles.link}`}>{t('nav.library')}</A>
          </EmptyState>
        </CollectionEmpty>}
      />
    </div>
  );
}
