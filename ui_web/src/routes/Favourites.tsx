import { createMemo } from 'solid-js';
import { actions, favouriteRows, state } from '../stores';
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

const context = () => ({ id: 'favourites', kind: 'favourites' as const, label: t('favourites.title') });

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
  const favTracks = createMemo<Track[]>(() => rows().map((row) => row.track));

  /**
   * A song saved from a Deezer/MusicBrainz row before it was ever played has no
   * source attached yet — the engine resolves one in the background, but the
   * user may well press play first. Resolve it here rather than handing the
   * queue an id nothing can stream. The lookup is cached server-side, so the
   * common case is one fast round trip and the rare case is an honest error.
   */
  const play = async (tracks: Track[], index: number) => {
    const row = rows()[index];
    if (!row || savedIsPlayable(row.entry, row.track)) {
      actions.playFrom(tracks, index, { context: context() });
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
      actions.playFrom(queue, index, { context: context() });
    } catch {
      toast.error(t('search.noPreview'));
    }
  };

  return (
    <div class="view">
      <ViewHeader
        title={t('favourites.title')}
        meta={state.loading && favTracks().length === 0 ? t('common.loading') : trackCount(favTracks().length)}
      />
      <TrackList
        tracks={favTracks()}
        context={context()}
        onPlay={(tracks, index) => void play(tracks, index)}
        loading={state.loading}
        empty={<EmptyState>{t('favourites.empty')}</EmptyState>}
      />
    </div>
  );
}
