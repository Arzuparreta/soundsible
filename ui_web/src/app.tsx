import type { RouteSectionProps } from '@solidjs/router';
import { state } from './stores';
import { ToastOutlet } from './lib/toast';
import { TabBar } from './components/TabBar';
import { Sidebar } from './components/Sidebar';
import { OmniBar } from './components/OmniBar';
import { PlayerSurface } from './components/PlayerSurface';
import { ResumeBanner } from './components/ResumeBanner';
import { ContextMenuOutlet } from './lib/contextMenu';
import { ScrollHistoryManager } from './lib/scrollHistory';
import { CommunityBridge } from './components/CommunityBridge';
import styles from './app.module.css';

/**
 * App shell. Mobile: scrollable outlet + bottom dock (player + tab bar).
 * Desktop (≥1024px, via CSS grid): left sidebar + outlet + player spanning the
 * bottom; the tab bar is hidden and the sidebar takes over navigation.
 */
export default function Shell(props: RouteSectionProps) {
  return (
    // The mini-player floats over the routes on touch, so the shell has to say
    // when it is up: that is what lets every scroller reserve room for it
    // (app.css). Same condition the pill hides itself on — there is one track
    // or there is not.
    <div class={styles.app} data-mini-player={state.playback.currentTrack ? '' : undefined}>
      <ScrollHistoryManager />
      <CommunityBridge />
      <Sidebar />
      <main class={styles.content}>{props.children}</main>
      <div class={styles.dock}>
        <OmniBar />
        <div class={styles.tabbar}>
          <TabBar />
        </div>
      </div>
      <PlayerSurface />
      <ResumeBanner />
      <ContextMenuOutlet />
      <ToastOutlet />
    </div>
  );
}
