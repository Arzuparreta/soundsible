import { EntityHero } from '../components/EntityHero';
import { CollectionSearch, CollectionEmpty, createCollectionSearch } from '../components/CollectionSearch';
import { trackSearchFields } from '../lib/librarySearch';
import { collectionId, collectionIndex } from '../lib/collectionIdentity';
import { createEffect, createMemo, createSignal, on, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { actions, state, musicLibrary } from '../stores';
import { player } from '../stores/player';
import TrackList from '../components/TrackList';
import { MoreIcon, PlayIcon } from '../components/icons';
import { CoverImage } from '../components/CoverImage';
import { openPlaylistMenu } from '../components/playlistActions';
import { trackCount } from '../lib/format';
import { trackCoverUrl } from '../lib/media';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { NEUTRAL_COVER } from '../lib/cover';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import hero from '../components/EntityHero.module.css';
import { EmptyState } from '../components/EmptyState';
import { MusicReorderList } from '../components/MusicReorderList';
import { Control } from '../design/Control';
import { navigateBackOr } from '../lib/scrollHistory';
import { playlistContext } from '../lib/playbackContext';

export default function PlaylistDetail() {
  const params = useParams();
  const navigate = useNavigate();
  // Solid Router exposes dynamic path segments in their URL-encoded form.
  // Playlist keys use the original display name, so decode the segment before
  // looking it up (e.g. "Road%20Trip" -> "Road Trip").
  const name = createMemo(() => decodeURIComponent(params.name ?? ''));
  const trackIds = createMemo<string[]>(() => state.playlists[name()] ?? []);
  const byId = createMemo(() => collectionIndex(musicLibrary()));
  const tracks = createMemo<Track[]>(() => trackIds()
    .map((id) => byId().get(id))
    .filter((t): t is Track => !!t));

  const search = createCollectionSearch();
  const filteredTracks = search.filter(tracks, trackSearchFields);
  createEffect(on(name, () => search.setValue(''), { defer: true }));

  const context = () => playlistContext(name(), tracks(), state.librarySettings);
  // The sleeve the playlists grid shows: the cover the user picked, else the
  // first song with artwork.
  const cover = createMemo(() => {
    const track = pickPlaylistCoverTrack(name(), trackIds(), byId(), state.librarySettings);
    return track ? trackCoverUrl(track) : undefined;
  });

  const playAll = () => {
    if (tracks().length > 0) {
      if (player().autoMode.active) {
        // A playlist is one source for the DJ, never a list of requests.
        void player().actions.startDjSelection(tracks(), name());
        return;
      }
      player().actions.playFrom(tracks(), 0, { context: context() });
    }
  };

  const [editing, setEditing] = createSignal(false);
  const openMenu = () =>
    openPlaylistMenu(name(), {
      onEdit: () => setEditing(true),
      onRenamed: (next) => navigate(`/playlists/${encodeURIComponent(next)}`, { replace: true }),
      onDeleted: () => navigate('/playlists', { replace: true }),
    });

  const back = () => navigateBackOr(navigate, '/playlists');
  return (
    <div class={`view ${hero.collection}`}>
      <EntityHero name={name()} back={back} backLabel={t('playlistDetail.ariaBack')} variant="compact"
        art={<div class={hero.art} style={{ background: NEUTRAL_COVER }} aria-hidden="true">
          <CoverImage src={cover()} eager />
        </div>}>
          <div class={hero.toolbar} data-entity-toolbar>
            <span class={hero.context}>{trackCount(trackIds().length)}</span>
            <button class={hero.play} type="button" onClick={playAll} disabled={tracks().length === 0}
              aria-label={player().autoMode.active ? t('autoMode.startDj') : t('playlistDetail.play')}>
              <PlayIcon size={16} />
              <span class={hero.primaryLabel}>{player().autoMode.active ? t('autoMode.startDj') : t('playlistDetail.play')}</span>
            </button>
              <Show when={editing()}>
                <Control class={hero.secondary} onClick={() => setEditing(false)}>{t('musicExplorer.done')}</Control>
              </Show>
              <button class={hero.options} type="button" aria-label={t('playlistDetail.ariaOptions')} aria-haspopup="dialog" onClick={openMenu}>
                <MoreIcon size={20} />
              </button>
          </div>
      </EntityHero>
      <Show when={!editing() && tracks().length}><CollectionSearch search={search} inset /></Show>
      <Show when={editing()} fallback={<TrackList
        tracks={filteredTracks()}
        context={context()}
        loading={state.loading && !tracks().length}
        menu={{
          playlistName: name(),
          onRemoveFromPlaylist: (t) => void actions.removeFromPlaylist(name(), collectionId(t)),
        }}
        empty={<CollectionEmpty source={tracks().length}><EmptyState>{t('playlistDetail.empty')}</EmptyState></CollectionEmpty>}
      />}>
        <MusicReorderList items={trackIds()} label={(id) => byId().get(id)?.title ?? id}
          render={(id) => <span>{byId().get(id)?.title ?? id}</span>}
          onChange={(ids) => actions.reorderPlaylistTracks(name(), ids)} />
      </Show>
    </div>
  );
}
