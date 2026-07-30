import type { RouteSectionProps } from '@solidjs/router';
import { ToastOutlet } from './lib/toast';
import { TabBar } from './components/TabBar';
import { Sidebar } from './components/Sidebar';
import { OmniBar } from './components/OmniBar';
import { PlayerSurface } from './components/PlayerSurface';
import { ResumeBanner } from './components/ResumeBanner';
import { ContextMenuOutlet } from './lib/contextMenu';
import { ScrollHistoryManager } from './lib/scrollHistory';
import styles from './app.module.css';

/**
 * App shell. Mobile: scrollable outlet + bottom dock (player + tab bar).
 * Desktop (≥1024px, via CSS grid): left sidebar + outlet + player spanning the
 * bottom; the tab bar is hidden and the sidebar takes over navigation.
 */
export default function Shell(props: RouteSectionProps) {
  return (
    <div class={styles.app}>
      <ScrollHistoryManager />
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
