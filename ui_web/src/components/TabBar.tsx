import { For, Show } from 'solid-js';
import { A, useLocation, useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { createResponsiveTap } from '../lib/responsiveTap';
import { reselectPrimaryTab } from '../lib/tabNavigation';
import { mobileLibraryHref } from '../lib/libraryView';
import { downloadCounts } from '../stores';
import { mobilePrimaryNavigation, mobileNavGroup, primaryNavigation, libraryShortcuts as shortcuts } from './primaryNavigation';
import { openActionMenu } from './ActionMenu';
import styles from './TabBar.module.css';

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const active = () => downloadCounts().active;
  const more = () => openActionMenu({
    title: t('nav.more'),
    actions: ['/podcasts', '/live', '/downloads', '/settings'].map((href) => {
      const item = [...primaryNavigation, ...shortcuts].find((entry) => entry.href === href)!;
      return {
        get label() { return `${item.label()}${href === '/downloads' && active() > 0 ? ` (${active()})` : ''}`; },
        icon: item.icon(),
        selected: location.pathname === href || location.pathname.startsWith(`${href}/`),
        onSelect: () => navigate(href),
      };
    }),
  }, true);
  return (
    <nav class={styles.bar} aria-label={t('nav.mobile')}>
      <For each={mobilePrimaryNavigation}>
        {(tab) => {
          const href = () => tab.href === '/' ? mobileLibraryHref() : tab.href;
          const selected = () => mobileNavGroup(location.pathname) === tab.href;
          const tap = createResponsiveTap({
            onTap: (event) => {
              event.preventDefault();
              if (location.pathname === href() || (tab.href === '/' && location.pathname === '/library')) {
                reselectPrimaryTab(href());
              } else navigate(href());
            },
          });
          return (
            <A href={href()} end class={styles.tab} activeClass="" classList={{ [styles.active]: selected() }}
              aria-current={selected() ? 'page' : undefined} data-pressable {...tap}>
              {tab.icon()}<span class={styles.label}>{tab.label()}</span>
            </A>
          );
        }}
      </For>
      <button type="button" class={styles.tab} classList={{ [styles.active]: mobileNavGroup(location.pathname) === 'more' }}
        aria-current={mobileNavGroup(location.pathname) === 'more' ? 'page' : undefined}
        aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus(); more(); }} data-pressable>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
        </svg>
        <span class={styles.label}>{t('nav.more')}<Show when={active() > 0}><span class={styles.badge} aria-label={`${t('nav.downloads')}: ${active()}`}>•</span></Show></span>
      </button>
    </nav>
  );
}
