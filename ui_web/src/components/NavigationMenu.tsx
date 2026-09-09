import { For, Show, createEffect, onCleanup } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import { desktopShell } from '../lib/shellLayout';
import { libraryTab, setLibraryTab } from '../lib/libraryView';
import { downloadCounts } from '../stores';
import { navigationGroups, navigationItems, mobileNavGroup } from './primaryNavigation';
import styles from './NavigationMenu.module.css';

export function NavigationLinks(props: { path: string; select?: (href: string, view?: string) => void }) {
  return <For each={navigationGroups}>{group => <section class={styles.group}>
    <h2>{group.label()}</h2>
    <nav aria-label={group.label()}><For each={group.hrefs}>{href => {
      const item = navigationItems.find(item => item.href === href)!;
      return <>
        <a href={`#${href}`} class={styles.item}
          classList={{ [styles.active]: mobileNavGroup(props.path) === href }}
          aria-current={mobileNavGroup(props.path) === href ? 'page' : undefined}
          onClick={event => { if (props.select) { event.preventDefault(); props.select(href); } }}>
          <span class={styles.icon}>{item.icon()}</span><span>{item.label()}</span>
          <Show when={href === '/downloads' && downloadCounts().active > 0}><span class={styles.badge}>{downloadCounts().active}</span></Show>
        </a>
        <Show when={href === '/'}><div class={styles.views}><For each={['songs', 'albums', 'artists']}>{view =>
          <a href="#/" class={styles.item}
            aria-current={['/', '/library'].includes(props.path) && libraryTab() === view ? 'page' : undefined}
            onClick={event => { if (props.select) { event.preventDefault(); props.select('/', view); } else setLibraryTab(view); }}>
            <span class={styles.icon}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <Show when={view === 'songs'}><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/></Show>
              <Show when={view === 'albums'}><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></Show>
              <Show when={view === 'artists'}><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0116 0v2"/></Show>
            </svg></span>{t(`library.${view}` as 'library.songs')}
          </a>
        }</For></div></Show>
      </>;
    }}</For></nav>
  </section>}</For>;
}

function Drawer(props: { path: () => string; close: (after?: () => void) => void; navigate: (href: string) => void; onViewChange?: () => void }) {
  createEffect(() => { if (desktopShell()) props.close(); });
  // Overlay lives outside the app root, so background controls cannot receive focus.
  const root = document.getElementById('app');
  const wasInert = root?.inert;
  if (root) root.inert = true;
  onCleanup(() => { if (root) root.inert = wasInert ?? false; });
  return <div class={styles.drawer}>
    <header class={styles.head}><strong>Soundsible</strong><button type="button" class={styles.close} aria-label={t('common.close')} onClick={() => props.close()}>×</button></header>
    <NavigationLinks path={props.path()} select={(href, view) => props.close(() => {
      if (view) { props.onViewChange?.(); setLibraryTab(view); }
      props.navigate(href);
    })} />
  </div>;
}

export function NavigationMenuButton(props: { onViewChange?: () => void } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  return <Show when={!desktopShell()}><button type="button" class={styles.trigger}
    aria-label={t('nav.menu')} aria-haspopup="dialog" data-pressable
    onClick={event => { event.currentTarget.focus(); openOverlay(close =>
      <Drawer path={() => location.pathname} close={close} navigate={navigate} onViewChange={props.onViewChange} />,
      { variant: 'drawer', history: true, ariaLabel: () => t('nav.menu') }); }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
  </button></Show>;
}
