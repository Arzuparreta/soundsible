import { createEffect, createSignal, Show, type Component } from 'solid-js';
import { useHref, useLocation, useNavigate } from '@solidjs/router';
import { IconButton } from '../design/Control';
import { t } from '../lib/i18n';
import { pageVisible } from '../lib/pageVisibility';
import { playerDocked } from '../lib/playerDock';
import { desktopShell } from '../lib/shellLayout';
import { sidebarCollapsed, toggleSidebarCollapsed } from '../lib/sidebarState';
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
        <IconButton
          class={styles.collapseBtn}
          label={collapsed() ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          title={collapsed() ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
          aria-expanded={!collapsed()}
          onClick={toggleSidebarCollapsed}
        >
          <SidebarToggleIcon />
        </IconButton>
        {/* Only a navigation entry should announce itself as the current page. */}
        <a href={home()} class={styles.brand} hidden={collapsed()}>soundsible</a>
      </div>

      <NavigationLinks
        desktop
        collapsed={collapsed()}
        path={location.pathname}
        search={location.search}
        navigate={navigate}
      />
    </aside>
  );
}
