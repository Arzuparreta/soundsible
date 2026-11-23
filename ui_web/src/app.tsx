import { useLocation, useNavigate, type RouteSectionProps } from '@solidjs/router';
import { createEffect, createSignal, onCleanup, onMount, Show, type Component } from 'solid-js';
import { rememberTabLocation } from './lib/tabMemory';
import { registerMusicNavigator } from './lib/musicNavigation';
import { nowPlayingOpen } from './stores';
import { player } from './stores/player';
import { ToastOutlet } from './lib/toast';
import { TabBar } from './components/TabBar';
import { Sidebar } from './components/Sidebar';
import { OmniBar } from './components/OmniBar';
import { DjErrandBanner } from './components/DjErrandBanner';
import { AppBar } from './components/AppBar';
import { ResumeBanner } from './components/ResumeBanner';
import { ContextMenuOutlet } from './lib/contextMenu';
import { ScrollHistoryManager } from './lib/scrollHistory';
import { communityInUse } from './lib/communityGate';
import styles from './app.module.css';

/**
 * App shell. Mobile: top bar + scrollable outlet + bottom dock (player + tab
 * bar). The top bar belongs to the shell, not the routes: pages describe it
 * with `useAppBar` and it stays put while they change underneath.
 * Desktop (≥1024px, via CSS grid): left sidebar + outlet + player spanning the
 * bottom; the tab bar is hidden and the sidebar takes over navigation.
 */
export default function Shell(props: RouteSectionProps) {
  onCleanup(registerMusicNavigator(useNavigate()));
  const location = useLocation();
  createEffect(() => rememberTabLocation(location.pathname, location.search));
  const [playerSurface, setPlayerSurface] = createSignal<Component>();
  let loadingPlayerSurface = false;
  const loadPlayerSurface = () => {
    if (playerSurface() || loadingPlayerSurface) return;
    loadingPlayerSurface = true;
    void import('./components/PlayerSurface').then(
      (module) => { setPlayerSurface(() => module.PlayerSurface); },
      () => { loadingPlayerSurface = false; },
    );
  };
  onMount(loadPlayerSurface);
  createEffect(() => {
    if (nowPlayingOpen() || player().playback.currentTrack || player().remote) loadPlayerSurface();
  });
  // The broadcast bridge, WebRTC and the Live client are fetched only once
  // Live is in use (lib/communityGate), not with the first library paint.
  const [bridge, setBridge] = createSignal<Component>();
  createEffect(() => {
    if (!communityInUse() || bridge()) return;
    void import('./components/CommunityBridge').then((module) => setBridge(() => module.CommunityBridge), () => {});
  });
  return (
    // The mini-player floats over the routes on touch, so the shell has to say
    // when it is up: that is what lets every scroller reserve room for it
    // (app.css). Same condition the pill hides itself on — there is one track
    // or there is not.
    <div class={styles.app} data-mini-player={player().playback.currentTrack || player().remote ? '' : undefined}>
      <ScrollHistoryManager />
      <Show when={bridge()} keyed>{(Bridge) => <Bridge />}</Show>
      <Sidebar />
      <main class={styles.content}>
        <AppBar />
        <DjErrandBanner />
        {/* The routes scroll here, under a bar that never moves. */}
        <div class={styles.outlet} data-app-outlet>{props.children}</div>
      </main>
      <div class={styles.dock}>
        <OmniBar />
        <div class={styles.tabbar}>
          <TabBar />
        </div>
      </div>
      <Show when={playerSurface()} keyed>{(Surface) => <Surface />}</Show>
      <ResumeBanner />
      <ContextMenuOutlet />
      <ToastOutlet />
    </div>
  );
}
