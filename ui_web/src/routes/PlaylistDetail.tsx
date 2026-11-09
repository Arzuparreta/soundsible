import { collectionId, collectionIndex } from '../lib/collectionIdentity';
import { createMemo, createSignal, Show } from 'solid-js';
import { useParams, useNavigate } from '@solidjs/router';
import { state, actions, musicLibrary } from '../stores';
import TrackList from '../components/TrackList';
import { BackIcon, MoreIcon, PlayIcon } from '../components/icons';
import { CoverImage } from '../components/CoverImage';
import { useAppBar } from '../lib/appBar';
import { desktopShell } from '../lib/shellLayout';
import { openPlaylistMenu } from '../components/playlistActions';
import { trackCount } from '../lib/format';
import { trackCoverUrl } from '../lib/media';
import { pickPlaylistCoverTrack } from '../lib/playlists';
import { NEUTRAL_COVER } from '../lib/cover';
import { t } from '../lib/i18n';
import type { Track } from '../types/music';
import hero from '../components/EntityHero.module.css';
import { EmptyState } from '../components/EmptyState';
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

  const context = () => playlistContext(name(), tracks(), state.librarySettings);
  // The sleeve the playlists grid shows: the cover the user picked, else the
  // first song with artwork.
  const cover = createMemo(() => {
    const track = pickPlaylistCoverTrack(name(), trackIds(), byId(), state.librarySettings);
    return track ? trackCoverUrl(track) : undefined;
  });

  const playAll = () => {
    if (tracks().length > 0) {
      if (state.autoMode.active) {
        // A playlist is one source for the DJ, never a list of requests.
        void actions.startDjSelection(tracks(), name());
        return;
      }
      actions.playFrom(tracks(), 0, { context: context() });
    }
  };

  const openMenu = () =>
    openPlaylistMenu(name(), {
      onRenamed: (next) => navigate(`/playlists/${encodeURIComponent(next)}`, { replace: true }),
      onDeleted: () => navigate('/playlists', { replace: true }),
    });

  const back = () => navigateBackOr(navigate, '/playlists');
  const [heading, setHeading] = createSignal<HTMLElement>();
  useAppBar({
    title: name,
    back,
    backLabel: () => t('playlistDetail.ariaBack'),
    heading,
  });

  return (
    <div class={`view ${hero.collection}`}>
      <header class={hero.header}>
        <Show when={desktopShell()}>
          <button class={hero.back} type="button" aria-label={t('playlistDetail.ariaBack')} onClick={back}>
            <BackIcon size={20} />
          </button>
        </Show>
        <div class={`${hero.hero} ${hero.compact}`}>
          <div class={hero.art} style={{ background: NEUTRAL_COVER }} aria-hidden="true">
            <CoverImage src={cover()} eager />
          </div>
          <div class={hero.identity}>
            <h1 ref={setHeading} class={hero.title}>{name()}</h1>
          </div>
          <div class={hero.toolbar} data-entity-toolbar>
            <span class={hero.context}>{trackCount(trackIds().length)}</span>
            <button class={hero.play} type="button" onClick={playAll} disabled={tracks().length === 0}
              aria-label={state.autoMode.active ? t('autoMode.startDj') : t('playlistDetail.play')}>
              <PlayIcon size={16} />
              <span class={hero.primaryLabel}>{state.autoMode.active ? t('autoMode.startDj') : t('playlistDetail.play')}</span>
            </button>
              <button class={hero.options} type="button" aria-label={t('playlistDetail.ariaOptions')} aria-haspopup="dialog" onClick={openMenu}>
                <MoreIcon size={20} />
              </button>
          </div>
        </div>
      </header>
      <TrackList
        tracks={tracks()}
        context={context()}
        loading={state.loading}
        menu={{
          playlistName: name(),
          onRemoveFromPlaylist: (t) => void actions.removeFromPlaylist(name(), collectionId(t)),
        }}
        empty={<EmptyState>{t('playlistDetail.empty')}</EmptyState>}
      />
    </div>
  );
}
