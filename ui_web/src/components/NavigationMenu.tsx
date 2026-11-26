import { For, Show, createEffect, onCleanup } from 'solid-js';
import { useLocation, useNavigate, type Navigator } from '@solidjs/router';
import { openPrimaryDestination } from '../lib/tabMemory';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import { desktopShell } from '../lib/shellLayout';
import { setLibraryTab } from '../lib/libraryView';
import { downloadCounts } from '../stores';
import { CloseIcon, MenuIcon } from './icons';
import { navigationGroups, navigationItems, mobileNavGroup, type NavigationGroup } from './primaryNavigation';
import styles from './NavigationMenu.module.css';

const LIBRARY_VIEW_PREFIX = '/library?view=';
const mainGroups = navigationGroups.filter((group) => !group.footer);
const footerGroups = navigationGroups.filter((group) => group.footer);

function libraryViewOf(href: string): string | undefined {
  return href.startsWith(LIBRARY_VIEW_PREFIX) ? href.slice(LIBRARY_VIEW_PREFIX.length) : undefined;
}

/**
 * Which entry is the current page. Exactly one entry announces it: a Library
 * view owns it while it is open, and Library itself only when no view below it
 * does. `inside` keeps Library's "climb to root" return behaviour alive without
 * lighting up a second row in the sidebar.
 */
export function navigationCurrent(path: string, search = ''): { href: string; inside?: string } {
  const href = mobileNavGroup(path, search);
  if (href.startsWith(LIBRARY_VIEW_PREFIX)) return { href, inside: '/' };
  // Saved albums and artists are sections of the Library page, with no entry.
  if (href.startsWith('/?saved=')) return { href: '/' };
  return { href };
}

function GroupSection(props: {
  group: NavigationGroup;
  collapsed?: boolean;
  current: () => { href: string; inside?: string };
  select: (href: string, view: string | undefined, selected: boolean) => void;
}) {
  return (
    <section
      class={styles.group}
      classList={{ [styles.footerGroup]: Boolean(props.group.footer) }}
    >
      <Show when={props.group.showHeading}>
        <h2 aria-hidden={props.collapsed || undefined}>
          <span hidden={props.collapsed}>{props.group.label()}</span>
        </h2>
      </Show>
      <nav aria-label={props.group.label()}>
        <For each={props.group.hrefs}>
          {(href) => {
            const item = navigationItems.find((entry) => entry.href === href)!;
            const view = libraryViewOf(href);
            const isCurrent = () => props.current().href === href;
            // Re-selecting Library from any of its views climbs back to `/`.
            const selected = () => isCurrent() || props.current().inside === href;
            const hasDownloads = () => href === '/downloads' && downloadCounts().active > 0;
            return (
              <a
                href={`#${href}`}
                class={styles.item}
                data-nav-href={href}
                classList={{
                  [styles.subItem]: Boolean(props.group.secondary),
                  [styles.active]: isCurrent(),
                }}
                aria-current={isCurrent() ? 'page' : undefined}
                aria-label={props.collapsed ? item.label() : undefined}
                title={props.collapsed ? item.label() : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  props.select(href, view, selected());
                }}
              >
                <span class={styles.icon}>{item.icon()}</span>
                <span class={styles.label} hidden={props.collapsed}>{item.label()}</span>
                <Show when={hasDownloads()}>
                  <span
                    class={props.collapsed ? styles.badgeDot : styles.badge}
                    aria-hidden={props.collapsed || undefined}
                  >
                    {props.collapsed ? undefined : downloadCounts().active}
                  </span>
                </Show>
              </a>
            );
          }}
        </For>
      </nav>
    </section>
  );
}

export function NavigationLinks(props: {
  path: string;
  search?: string;
  collapsed?: boolean;
  desktop?: boolean;
  navigate: Navigator;
  onSelect?: (go: () => void, view: string | undefined) => void;
}) {
  const current = () => navigationCurrent(props.path, props.search);
  const select = (href: string, view: string | undefined, selected: boolean) => {
    const go = () => {
      if (view) {
        setLibraryTab(view);
        props.navigate(href);
      } else {
        openPrimaryDestination(props.navigate, href, selected, `${props.path}${props.search ?? ''}`);
      }
    };
    if (props.onSelect) props.onSelect(go, view);
    else go();
  };

  return (
    <div
      class={styles.links}
      classList={{ [styles.desktopLinks]: Boolean(props.desktop) }}
    >
      <div class={styles.scrollGroups}>
        <For each={mainGroups}>
          {(group) => (
            <GroupSection
              group={group}
              collapsed={props.collapsed}
              current={current}
              select={select}
            />
          )}
        </For>
      </div>
      <For each={footerGroups}>
        {(group) => (
          <GroupSection
            group={group}
            collapsed={props.collapsed}
            current={current}
            select={select}
          />
        )}
      </For>
    </div>
  );
}

function Drawer(props: {
  path: () => string;
  search: () => string;
  close: (after?: () => void) => void;
  navigate: Navigator;
  onViewChange?: () => void;
}) {
  createEffect(() => { if (desktopShell()) props.close(); });
  // Overlay lives outside the app root, so background controls cannot receive focus.
  const root = document.getElementById('app');
  const wasInert = root?.inert;
  if (root) root.inert = true;
  onCleanup(() => { if (root) root.inert = wasInert ?? false; });
  return (
    <div class={styles.drawer}>
      <header class={styles.head}>
        <strong>soundsible</strong>
        <button type="button" class={styles.close} aria-label={t('common.close')} onClick={() => props.close()}>
          <CloseIcon />
        </button>
      </header>
      <NavigationLinks
        path={props.path()}
        search={props.search()}
        navigate={props.navigate}
        onSelect={(go, view) => props.close(() => {
          if (view) props.onViewChange?.();
          go();
        })}
      />
    </div>
  );
}

export function NavigationMenuButton(props: { onViewChange?: () => void; class?: string } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <Show when={!desktopShell()}>
      <button
        type="button"
        class={props.class ?? styles.trigger}
        aria-label={t('nav.menu')}
        aria-haspopup="dialog"
        data-pressable
        onClick={(event) => {
          event.currentTarget.focus();
          openOverlay(
            (close) => (
              <Drawer
                path={() => location.pathname}
                search={() => location.search}
                close={close}
                navigate={navigate}
                onViewChange={props.onViewChange}
              />
            ),
            { variant: 'drawer', history: true, ariaLabel: () => t('nav.menu') },
          );
        }}
      >
        <MenuIcon />
      </button>
    </Show>
  );
}
