import { For, Show, createEffect, onCleanup } from 'solid-js';
import { useLocation, useNavigate, type Navigator } from '@solidjs/router';
import { openPrimaryDestination } from '../lib/tabMemory';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import { desktopShell } from '../lib/shellLayout';
import { downloadCounts } from '../stores';
import { CloseIcon, MenuIcon } from './icons';
import { navigationGroups, navigationItems, primaryDestination, type NavigationGroup } from './primaryNavigation';
import styles from './NavigationMenu.module.css';
import { NavigationItemContent } from './NavigationItemContent';

const mainGroups = navigationGroups.filter((group) => !group.footer);
const footerGroups = navigationGroups.filter((group) => group.footer);

/** Which navigation entry owns the active route, or `''` for neutral entity views. */
export function navigationCurrent(path: string): string {
  return primaryDestination(path);
}

function GroupSection(props: {
  group: NavigationGroup;
  collapsed?: boolean;
  current: () => string;
  select: (href: string, selected: boolean) => void;
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
            const isCurrent = () => props.current() === href;
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
                  props.select(href, isCurrent());
                }}
              >
                <NavigationItemContent icon={item.icon} label={item.label()} collapsed={props.collapsed} />
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
  onSelect?: (go: () => void) => void;
}) {
  const current = () => navigationCurrent(props.path);
  const select = (href: string, selected: boolean) => {
    const go = () => {
      openPrimaryDestination(props.navigate, href, selected, `${props.path}${props.search ?? ''}`, {
        restoreSubroute: false,
      });
    };
    if (props.onSelect) props.onSelect(go);
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
        onSelect={(go) => props.close(go)}
      />
    </div>
  );
}

export function NavigationMenuButton(props: { class?: string } = {}) {
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
