import { createEffect, createSignal, Show, type Component } from 'solid-js';
import { useHref, useLocation, useNavigate } from '@solidjs/router';
import { IconButton } from '../design/Control';
import { t } from '../lib/i18n';
import { setLibraryTab } from '../lib/libraryView';
import { pageVisible } from '../lib/pageVisibility';
import { playerDocked } from '../lib/playerDock';
import { desktopShell } from '../lib/shellLayout';
import { sidebarCollapsed, toggleSidebarCollapsed } from '../lib/sidebarState';
import { openPrimaryDestination } from '../lib/tabMemory';
import { nowPlayingOpen } from '../stores';
import { SidebarToggleIcon } from './icons';
import { NavigationLinks } from './NavigationMenu';
import styles from './Sidebar.module.css';

type StageBackdropComponent = Component<Parameters<typeof import('./StageBackdrop').StageBackdrop>[0]>;

export function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const home = useHref(() => '/');
  const collapsed = sidebarCollapsed;
  const [stageBackdrop, setStageBackdrop] = createSignal<StageBackdropComponent>();
  let loadingBackdrop = false;

  createEffect(() => {
    if (!desktopShell() || stageBackdrop() || loadingBackdrop) return;
    loadingBackdrop = true;
    void import('./StageBackdrop').then(
      (module) => {
        setStageBackdrop(() => module.StageBackdrop);
      },
      () => {
        loadingBackdrop = false;
      },
    );
  });

  return (
    <aside class={styles.sidebar} data-stage-surface="" data-collapsed={collapsed() ? '' : undefined}>
      <Show when={stageBackdrop()} keyed>
        {(Backdrop) => (
          <Backdrop visible={desktopShell() && pageVisible() && !(nowPlayingOpen() && !playerDocked())} />
        )}
      </Show>
      <div class={styles.header}>
        {/* A plain link, not a router `A`: that would announce itself as the
            current page beside Library, and only a navigation entry should. */}
        <Show when={!collapsed()}>
          <a href={home()} class={styles.brand}>soundsible</a>
        </Show>
        <IconButton
          class={styles.collapseBtn}
          label={collapsed() ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          title={collapsed() ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          aria-expanded={!collapsed()}
          onClick={toggleSidebarCollapsed}
        >
          <SidebarToggleIcon />
        </IconButton>
      </div>

      <NavigationLinks
        desktop
        collapsed={collapsed()}
        path={location.pathname}
        search={location.search}
        select={(href, view, selected = false) => {
          if (view) {
            setLibraryTab(view);
            navigate(href);
          } else {
            openPrimaryDestination(navigate, href, selected, `${location.pathname}${location.search}`);
          }
        }}
      />
    </aside>
  );
}
