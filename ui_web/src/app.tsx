import type { RouteSectionProps } from '@solidjs/router';
import { OverlayOutlet } from './lib/overlay';
import { TabBar } from './components/TabBar';
import { OmniBar } from './components/OmniBar';
import { NowPlaying } from './components/NowPlaying';
import styles from './app.module.css';

/** App shell: scrollable route outlet + persistent player dock + overlay outlet. */
export default function Shell(props: RouteSectionProps) {
  return (
    <div class={styles.app}>
      <main class={styles.content}>{props.children}</main>
      <div class={styles.dock}>
        <OmniBar />
        <TabBar />
      </div>
      <NowPlaying />
      <OverlayOutlet />
    </div>
  );
}
