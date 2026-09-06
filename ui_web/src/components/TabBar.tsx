import { For } from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { primaryNavigation } from './primaryNavigation';
import styles from './TabBar.module.css';

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
          );
        }}
      </For>
    </nav>
  );
}
