import { For, Show } from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { openPrimaryDestination } from '../lib/tabMemory';
import { bottomNavigation } from '../lib/bottomNavigation';
import { downloadCounts } from '../stores';
import { navigationItems, primaryDestination } from './primaryNavigation';
import styles from './TabBar.module.css';

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const active = () => downloadCounts().active;
  return (
    <nav style={{ "grid-template-columns": `repeat(${bottomNavigation().length}, minmax(0, 1fr))` }} class={styles.bar} aria-label={t('nav.mobile')}>
      <For each={bottomNavigation().map(href => navigationItems.find(item => item.href === href)!)}>
        {(tab) => {
          const href = () => tab.href;
          const selected = () => primaryDestination(location.pathname) === tab.href;
          const tap = createResponsiveTap({
            onTap: (event) => {
              event.preventDefault();
              openPrimaryDestination(navigate, href(), selected(), `${location.pathname}${location.search}`, { restoreSubroute: true });
            },
          });
          return (
            <A href={href()} end class={styles.tab} activeClass="" classList={{ [styles.active]: selected() }}
              aria-current={selected() ? 'page' : undefined} data-nav-href={tab.href} data-pressable {...tap}>
              {tab.icon()}<span class={styles.label}>{tab.label()}<Show when={tab.href === '/downloads' && active() > 0}><span class={styles.badge}> ({active()})</span></Show></span>
            </A>
          );
        }}
      </For>
    </nav>
  );
}
