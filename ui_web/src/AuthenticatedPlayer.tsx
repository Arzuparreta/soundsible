import { createEffect, onMount, onCleanup } from 'solid-js';
import { HashRouter, Route, useNavigate, useSearchParams } from '@solidjs/router';
import Shell from './app';
import { asyncPage } from './components/AsyncPage';

const Home = asyncPage(() => import('./routes/Home'), () => t('nav.home'));

const collectionPage = (
  view: 'songs' | 'albums' | 'artists',
  titleKey: 'library.songs' | 'library.albums' | 'library.artists',
) => asyncPage(
  () => import('./routes/Library').then((m) => ({ default: () => <m.default view={view} /> })),
  () => t(titleKey),
);

const bookmarkPage = (kind?: 'album' | 'artist') => asyncPage(
  () => import('./routes/Bookmarks').then((m) => ({ default: () => <m.default kind={kind} /> })),
  () => t(kind === 'album' ? 'savedEntities.albums' : kind === 'artist' ? 'savedEntities.artists' : 'savedEntities.title'),
);

const Songs = collectionPage('songs', 'library.songs');
const Albums = collectionPage('albums', 'library.albums');
const Artists = collectionPage('artists', 'library.artists');
const Bookmarks = bookmarkPage();
const BookmarksAlbums = bookmarkPage('album');
const BookmarksArtists = bookmarkPage('artist');

const Favourites = asyncPage(() => import('./routes/Favourites'), () => t('favourites.title'));
const Settings = asyncPage(() => import('./routes/Settings'), () => t('settings.title'));
const Search = asyncPage(() => import('./routes/Search'), () => t('nav.search'));
const Playlists = asyncPage(() => import('./routes/Playlists'), () => t('playlists.title'));
const PlaylistDetail = asyncPage(() => import('./routes/PlaylistDetail'), () => t('playlists.title'));
const Podcasts = asyncPage(() => import('./routes/Podcasts'), () => t('nav.podcasts'));
const PodcastShow = asyncPage(() => import('./routes/PodcastShow'), () => t('nav.podcasts'));
const Downloads = asyncPage(() => import('./routes/Downloads'), () => t('downloads.title'));
const Migrate = asyncPage(() => import('./routes/Migrate'), () => t('migrate.title'));
const Artist = asyncPage(() => import('./routes/Artist'), () => t('library.artists'));
const Album = asyncPage(() => import('./routes/Album'), () => t('library.albums'));
const TvApprove = asyncPage(() => import('./routes/TvApprove'), () => t('tvApprove.title'));
const Live = asyncPage(() => import('./routes/Live'), () => t('live.title'));
const DesignPreview = asyncPage(() => import('./pages/DesignPreview'), () => t('common.loading'));
const Placeholder = asyncPage(() =>
  import('./routes/Placeholder').then((m) => ({ default: () => <m.Placeholder title={t('placeholder.notFoundTitle')} blurb={t('placeholder.notFoundBlurb')} /> })),
  () => t('placeholder.notFoundTitle'),
);
import { initStore, disposeStore } from './stores';
import { t } from './lib/i18n';

function DiscoverRedirect() {
  const navigate = useNavigate();
  onMount(() => navigate('/search', { replace: true }));
  return <Search />;
}

function LegacyLibraryRedirect() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const target = () => {
    const view = String(params.view ?? '');
    const rest = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === 'view' || value == null) continue;
      if (Array.isArray(value)) value.forEach((entry) => rest.append(key, entry));
      else rest.set(key, String(value));
    }
    const base = view === 'songs' || view === 'albums' || view === 'artists' ? `/${view}` : '/';
    const query = rest.toString();
    return query ? `${base}?${query}` : base;
  };
  createEffect(() => navigate(target(), { replace: true }));
  return null;
}

function Player() {
  return (
    <HashRouter root={Shell}>
      <Route path="/" component={Home} />
      <Route path="/songs" component={Songs} />
      <Route path="/albums" component={Albums} />
      <Route path="/artists" component={Artists} />
      <Route path="/bookmarks" component={Bookmarks} />
      <Route path="/bookmarks/albums" component={BookmarksAlbums} />
      <Route path="/bookmarks/artists" component={BookmarksArtists} />
      <Route path="/library" component={LegacyLibraryRedirect} />
      <Route path="/favourites" component={Favourites} />
      <Route path="/search" component={Search} />
      <Route path="/settings" component={Settings} />
      <Route path="/settings/:section" component={Settings} />
      <Route path="/discover" component={DiscoverRedirect} />
      <Route path="/playlists" component={Playlists} />
      <Route path="/playlists/:name" component={PlaylistDetail} />
      <Route path="/podcasts" component={Podcasts} />
      <Route path="/podcasts/feed" component={PodcastShow} />
      <Route path="/podcasts/:id" component={PodcastShow} />
      <Route path="/live" component={Live} />
      <Route path="/downloads" component={Downloads} />
      <Route path="/import" component={Migrate} />
      <Route path="/artist/:name" component={Artist} />
      <Route path="/album/:name" component={Album} />
      <Route path="/tv-approve" component={TvApprove} />
      <Route path="/preview" component={DesignPreview} />
      <Route path="*" component={Placeholder} />
    </HashRouter>
  );
}

export default function AuthenticatedPlayer() {
  initStore();
  onCleanup(disposeStore);
  onMount(() => window.__SOUNDSIBLE_BOOT__?.complete());
  return <Player />;
}
