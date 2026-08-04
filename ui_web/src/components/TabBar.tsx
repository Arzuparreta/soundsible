import { For, Show } from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { openSettings, settingsOpen } from '../lib/settingsSurface';
import { primaryNavigation, type PrimaryNavItem } from './primaryNavigation';
import styles from './TabBar.module.css';

/**
 * An overlay item is not a destination, so it cannot borrow the router's
 * active state. It stays lit for exactly as long as its window is up.
 */
function OverlayTab(props: { tab: PrimaryNavItem }) {
  const tap = createResponsiveTap({
    onTap: (event) => {
      event.preventDefault();
      openSettings();
    },
  });

  return (
    <button
      type="button"
      class={styles.tab}
      classList={{ [styles.active]: settingsOpen() }}
      aria-current={settingsOpen() ? 'true' : undefined}
      data-pressable
      {...tap}
    >
      {props.tab.icon()}
      <span class={styles.label}>{props.tab.label()}</span>
    </button>
  );
}

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav class={styles.bar} aria-label={t('nav.mobile')}>
      <For each={primaryNavigation}>
        {(tab) => {
          const tap = createResponsiveTap({
            onTap: (event) => {
              event.preventDefault();
              if (location.pathname === tab.href) {
                reselectPrimaryTab(tab.href);
                return;
              }
              navigate(tab.href);
            },
          });
          return (
            <Show when={!tab.overlay} fallback={<OverlayTab tab={tab} />}>
              <A
                href={tab.href}
                end={tab.end}
                class={styles.tab}
                activeClass={styles.active}
                data-pressable
                {...tap}
              >
                {tab.icon()}
                <span class={styles.label}>{tab.label()}</span>
              </A>
            </Show>
          );
        }}
      </For>
    </nav>
  );
}
