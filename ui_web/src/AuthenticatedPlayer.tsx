import { Show, onMount, onCleanup } from 'solid-js';
import { HashRouter, Route, useNavigate, useSearchParams } from '@solidjs/router';
import Shell from './app';
import { asyncPage } from './components/AsyncPage';
import LibraryHome from './routes/LibraryHome';
const Library = asyncPage(() => import('./routes/Library'), () => t('nav.library'));

const Favourites = asyncPage(() => import('./routes/Favourites'), () => t('favourites.title'));
const Settings = asyncPage(() => import('./routes/Settings'), () => t('settings.title'));
const Search = asyncPage(() => import('./routes/Search'), () => t('nav.search'));
const Playlists = asyncPage(() => import('./routes/Playlists'), () => t('playlists.title'), 'cards');
const PlaylistDetail = asyncPage(() => import('./routes/PlaylistDetail'), () => t('playlists.title'));
const Podcasts = asyncPage(() => import('./routes/Podcasts'), () => t('nav.podcasts'), 'cards');
const PodcastShow = asyncPage(() => import('./routes/PodcastShow'), () => t('nav.podcasts'));
const Downloads = asyncPage(() => import('./routes/Downloads'), () => t('downloads.title'));
const Migrate = asyncPage(() => import('./routes/Migrate'), () => t('migrate.title'));
const Artist = asyncPage(() => import('./routes/Artist'), () => t('library.artists'));
const Album = asyncPage(() => import('./routes/Album'), () => t('library.albums'));
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

function LibraryRoute() {
  const [params] = useSearchParams();
  return <Show when={['songs', 'albums', 'artists'].includes(String(params.view))} fallback={<LibraryHome />}><Library /></Show>;
}

function Player() {
  return (
    <HashRouter root={Shell}>
      <Route path="/" component={LibraryHome} />
      <Route path="/library" component={LibraryRoute} />
      <Route path="/favourites" component={Favourites} />
      <Route path="/search" component={Search} />
      {/* One route identity keeps Settings mounted between its index/details. */}
      <Route path={['/settings', '/settings/:section']} component={Settings} />
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
