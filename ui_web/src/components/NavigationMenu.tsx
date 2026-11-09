import { For, Show, createEffect, onCleanup } from 'solid-js';
import { useLocation, useNavigate, type Navigator } from '@solidjs/router';
import { openPrimaryDestination } from '../lib/tabMemory';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import { desktopShell } from '../lib/shellLayout';
import { setLibraryTab } from '../lib/libraryView';
import { downloadCounts } from '../stores';
import { CloseIcon, MenuIcon } from './icons';
import { navigationGroups, navigationItems, mobileNavGroup } from './primaryNavigation';
import styles from './NavigationMenu.module.css';

const LIBRARY_VIEWS = ['songs', 'albums', 'artists'] as const;

/**
 * Which entry is the current page. Exactly one entry announces it: a Library
 * view owns it while it is open, and Library itself only when no view below it
 * does. `inside` marks the parent of a current view, which is drawn as the
 * branch the listener is in but never announced as the page.
 */
export function navigationCurrent(path: string, search = ''): { href: string; inside?: string } {
  const href = mobileNavGroup(path, search);
  if (href.startsWith('/library?view=')) return { href, inside: '/' };
  // Saved albums and artists are sections of the Library page, with no entry.
  if (href.startsWith('/?saved=')) return { href: '/' };
  return { href };
}

export function NavigationLinks(props: { path: string; search?: string; select?: (href: string, view?: string, selected?: boolean) => void }) {
  const current = () => navigationCurrent(props.path, props.search);
  return <For each={navigationGroups}>{group => <section class={styles.group}>
    <h2>{group.label()}</h2>
    <nav aria-label={group.label()}><For each={group.hrefs}>{href => {
      const item = navigationItems.find(item => item.href === href)!;
      const isCurrent = () => current().href === href;
      // Re-selecting a destination climbs to its root; Library is selected
      // from any of its views, as it is in the tab bar.
      const selected = () => isCurrent() || current().inside === href;
      return <>
        <a href={`#${href}`} class={styles.item} data-nav-href={href}
          classList={{ [styles.active]: isCurrent(), [styles.inside]: current().inside === href }}
          aria-current={isCurrent() ? 'page' : undefined}
          onClick={event => { if (props.select) { event.preventDefault(); props.select(href, undefined, selected()); } }}>
          <span class={styles.icon}>{item.icon()}</span><span class={styles.label}>{item.label()}</span>
          <Show when={href === '/downloads' && downloadCounts().active > 0}><span class={styles.badge}>{downloadCounts().active}</span></Show>
        </a>
        <Show when={href === '/'}><div class={styles.views}><For each={LIBRARY_VIEWS}>{view => {
          const viewHref = `/library?view=${view}`;
          return <a href={`#${viewHref}`} class={`${styles.item} ${styles.view}`}
            classList={{ [styles.active]: current().href === viewHref }}
            aria-current={current().href === viewHref ? 'page' : undefined}
            onClick={event => { if (props.select) { event.preventDefault(); props.select(viewHref, view); } else setLibraryTab(view); }}>
            <span class={styles.label}>{t(`library.${view}` as 'library.songs')}</span>
          </a>;
        }}</For></div></Show>
      </>;
    }}</For></nav>
  </section>}</For>;
}

function Drawer(props: { path: () => string; search: () => string; close: (after?: () => void) => void; navigate: Navigator; onViewChange?: () => void }) {
  createEffect(() => { if (desktopShell()) props.close(); });
  // Overlay lives outside the app root, so background controls cannot receive focus.
  const root = document.getElementById('app');
  const wasInert = root?.inert;
  if (root) root.inert = true;
  onCleanup(() => { if (root) root.inert = wasInert ?? false; });
  return <div class={styles.drawer}>
    <header class={styles.head}><strong>Soundsible</strong><button type="button" class={styles.close} aria-label={t('common.close')} onClick={() => props.close()}><CloseIcon /></button></header>
    <NavigationLinks path={props.path()} search={props.search()} select={(href, view, selected = false) => props.close(() => {
      if (view) { props.onViewChange?.(); setLibraryTab(view); props.navigate(href); }
      else openPrimaryDestination(props.navigate, href, selected, `${props.path()}${props.search()}`);
    })} />
  </div>;
}

export function NavigationMenuButton(props: { onViewChange?: () => void; class?: string } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  return <Show when={!desktopShell()}><button type="button" class={props.class ?? styles.trigger}
    aria-label={t('nav.menu')} aria-haspopup="dialog" data-pressable
    onClick={event => { event.currentTarget.focus(); openOverlay(close =>
      <Drawer path={() => location.pathname} search={() => location.search} close={close} navigate={navigate} onViewChange={props.onViewChange} />,
      { variant: 'drawer', history: true, ariaLabel: () => t('nav.menu') }); }}>
    <MenuIcon />
  </button></Show>;
}
