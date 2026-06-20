import type { RouteSectionProps } from '@solidjs/router';
import { OverlayOutlet } from './lib/overlay';
import { TabBar } from './components/TabBar';
import { Sidebar } from './components/Sidebar';
import { OmniBar } from './components/OmniBar';
import { NowPlaying } from './components/NowPlaying';
import styles from './app.module.css';

/**
 * App shell. Mobile: scrollable outlet + bottom dock (player + tab bar).
 * Desktop (≥1024px, via CSS grid): left sidebar + outlet + player spanning the
 * bottom; the tab bar is hidden and the sidebar takes over navigation.
 */
export default function Shell(props: RouteSectionProps) {
  return (
    <div class={styles.app}>
      <Sidebar />
      <main class={styles.content}>{props.children}</main>
      <div class={styles.dock}>
        <OmniBar />
        <div class={styles.tabbar}>
          <TabBar />
        </div>
      </div>
      <NowPlaying />
      <OverlayOutlet />
    </div>
  );
}
