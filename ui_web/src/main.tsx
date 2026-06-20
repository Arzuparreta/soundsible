/* SolidJS player entry point for mobile, desktop, PWA, and the desktop shell. */
import { render } from 'solid-js/web';
import { HashRouter, Route } from '@solidjs/router';
import Shell from './app';
import Home from './routes/Home';
import Favourites from './routes/Favourites';
import Search from './routes/Search';
import Settings from './routes/Settings';
import Playlists from './routes/Playlists';
import PlaylistDetail from './routes/PlaylistDetail';
import Discover from './routes/Discover';
import Podcasts from './routes/Podcasts';
import PodcastShow from './routes/PodcastShow';
import Downloads from './routes/Downloads';
import Artist from './routes/Artist';
import { Placeholder } from './routes/Placeholder';
import DesignPreview from './pages/DesignPreview';
import { initStore } from './stores';
import './styles/tokens.css';
import './styles/app.css';

initStore();

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point missing');

render(
  () => (
    <HashRouter root={Shell}>
      <Route path="/" component={Home} />
      <Route path="/favourites" component={Favourites} />
      <Route path="/search" component={Search} />
      <Route path="/settings" component={Settings} />
      <Route path="/discover" component={Discover} />
      <Route path="/playlists" component={Playlists} />
      <Route path="/playlists/:name" component={PlaylistDetail} />
      <Route path="/podcasts" component={Podcasts} />
      <Route path="/podcasts/:id" component={PodcastShow} />
      <Route path="/downloads" component={Downloads} />
      <Route path="/artist/:name" component={Artist} />
      <Route path="/preview" component={DesignPreview} />
      <Route path="*" component={() => <Placeholder title="No encontrado" blurb="Esta ruta no existe." />} />
    </HashRouter>
  ),
  root,
);
