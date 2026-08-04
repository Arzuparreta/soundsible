/* SolidJS player entry point for mobile, desktop, PWA, and the desktop shell. */
import { render } from 'solid-js/web';
import { Show, createEffect, lazy, onMount } from 'solid-js';
import { HashRouter, Route, useNavigate, useParams } from '@solidjs/router';
import Shell from './app';
// Library is the landing route; Login and Invite are the pre-auth screens. All
// three stay in the entry chunk — and Login/Invite must, because they render
// outside the router, which is what supplies the Suspense boundary a lazy
// component needs to appear at all. Every other route is split out: the import
// wizard alone is ~40 KB that most sessions never open, and it was downloaded
// and parsed before the first track list could paint.
import Library from './routes/Library';
import Login from './routes/Login';
import Invite from './routes/Invite';

const Favourites = lazy(() => import('./routes/Favourites'));
const Search = lazy(() => import('./routes/Search'));
const Playlists = lazy(() => import('./routes/Playlists'));
const PlaylistDetail = lazy(() => import('./routes/PlaylistDetail'));
const Podcasts = lazy(() => import('./routes/Podcasts'));
const PodcastShow = lazy(() => import('./routes/PodcastShow'));
const Downloads = lazy(() => import('./routes/Downloads'));
const Migrate = lazy(() => import('./routes/Migrate'));
const Artist = lazy(() => import('./routes/Artist'));
const Album = lazy(() => import('./routes/Album'));
const Live = lazy(() => import('./routes/Live'));
const DesignPreview = lazy(() => import('./pages/DesignPreview'));
const Placeholder = lazy(() =>
  import('./routes/Placeholder').then((m) => ({ default: m.Placeholder })),
);
import { initStore, state } from './stores';
import { applyVisualPreferences } from './lib/visualPreferences';
import { initLocale, t } from './lib/i18n';
import { registerServiceWorker } from './lib/pwa';
import { OverlayOutlet } from './lib/overlay';
import { openSettings } from './lib/settingsSurface';
import { navigateBackOr } from './lib/scrollHistory';
import { installSessionGuard, ready, refreshSession, requiresLogin, user } from './lib/session';
// Self-host the design-system typefaces (DESIGN.md) so they render for every
// user, not only those who happen to have them installed locally. Subsets load
// on demand via unicode-range. Plus Jakarta Sans 400/500/600/700, JetBrains
// Mono 400/500 — the weights referenced by --fw-* tokens.
import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/app.css';

// Visual accessibility preferences must be present before auth resolves so
// Login/Invite and the first authenticated frame use the same geometry.
applyVisualPreferences({
  interfaceSize: state.interfaceSize,
  highContrast: state.highContrast,
});

function installViewportHeightSync() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  if (!viewport) return;

  // `scroll` fires continuously while a page scrolls on mobile, and writing a
  // custom property on <html> invalidates style for the whole document — so the
  // height it did not change has to not be written.
  let last = '';
  const sync = () => {
    const next = `${viewport.height}px`;
    if (next === last) return;
    last = next;
    root.style.setProperty('--app-viewport-height', next);
  };

  sync();
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  window.addEventListener('orientationchange', sync);
}

installViewportHeightSync();
// Locale dictionaries other than English load on demand. Nothing renders until
// the session resolves anyway (see `App`), so this normally finishes first and
// the interface never flashes English.
void initLocale();
installSessionGuard();
registerServiceWorker();
void refreshSession();

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point missing');

function DiscoverRedirect() {
  const navigate = useNavigate();
  onMount(() => navigate('/search', { replace: true }));
  return <Search />;
}

/**
 * Turns a settings address into an open settings window. It renders nothing:
 * the window mounts from the overlay outlet, which lives outside the router, so
 * it survives the step off this route — and stepping off is the point. A window
 * needs something behind it, and `/settings` no longer draws anything.
 */
function SettingsLink() {
  const params = useParams();
  const navigate = useNavigate();
  onMount(() => {
    openSettings(params.section);
    navigateBackOr(navigate, '/');
  });
  return null;
}

function Player() {
  return (
    <HashRouter root={Shell}>
      <Route path="/" component={Library} />
      <Route path="/library" component={Library} />
      <Route path="/favourites" component={Favourites} />
      <Route path="/search" component={Search} />
      {/* Settings is a window now, not a page — but it still has an address.
          A paired device sends its owner back to `#/settings/devices`
          (lib/trackShare), and bookmarks outlive redesigns. Opening the window
          and stepping off the URL keeps both working without settings owning a
          route it no longer renders anything into. */}
      <Route path="/settings" component={SettingsLink} />
      <Route path="/settings/:section" component={SettingsLink} />
      <Route path="/discover" component={DiscoverRedirect} />
      <Route path="/playlists" component={Playlists} />
      <Route path="/playlists/:name" component={PlaylistDetail} />
      <Route path="/podcasts" component={Podcasts} />
      <Route path="/podcasts/:id" component={PodcastShow} />
      <Route path="/live" component={Live} />
      <Route path="/downloads" component={Downloads} />
      <Route path="/import" component={Migrate} />
      <Route path="/artist/:name" component={Artist} />
      <Route path="/album/:name" component={Album} />
      <Route path="/preview" component={DesignPreview} />
      <Route path="*" component={() => <Placeholder title={t('placeholder.notFoundTitle')} blurb={t('placeholder.notFoundBlurb')} />} />
    </HashRouter>
  );
}

/** `#/invite/<token>` — the link someone is handed before they have an account. */
function inviteToken(): string | null {
  const match = /^#\/invite\/([^/?#]+)/.exec(window.location.hash || '');
  return match ? decodeURIComponent(match[1]) : null;
}

/** When not signed in: redeem an invite if the URL carries one, else log in. */
function InviteOrLogin() {
  const token = inviteToken();
  return token ? <Invite token={token} /> : <Login />;
}

/**
 * Nothing renders until the engine has told us who we are. Booting the stores
 * first would fire a burst of library requests as the wrong account — or as
 * nobody at all — and paint somebody else's data for a frame.
 */
function App() {
  const authenticated = () => !requiresLogin() || Boolean(user());

  createEffect(() => {
    if (!ready() || !authenticated()) return;
    // A leftover `#/invite/<token>` — e.g. a home-screen icon saved on the
    // invite page — must not strand a signed-in user on a dead-link screen.
    // Once there is a session the token is irrelevant: drop it and go to the root.
    if (inviteToken()) window.location.hash = '#/';
    initStore();
  });

  return (
    <>
      <Show when={ready()} fallback={null}>
        <Show when={authenticated()} fallback={<InviteOrLogin />}>
          <Player />
        </Show>
      </Show>
      <OverlayOutlet />
    </>
  );
}

render(() => <App />, root);
