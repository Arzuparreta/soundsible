import { For, Show, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import styles from './ActionMenu.module.css';

export interface MenuAction {
  icon?: JSX.Element;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface ActionMenuOptions {
  title?: string;
  subtitle?: string;
  actions: MenuAction[];
}

/**
 * Context menu / action sheet. Renders through `openOverlay`, so it is a
 * bottom sheet on mobile and a centered popover on desktop (overlay.module.css
 * handles the responsive placement). Replaces the legacy long-press/right-click
 * action menu that the new UI dropped entirely.
 */
export function openActionMenu(opts: ActionMenuOptions): void {
  openOverlay((close) => (
    <div class={styles.menu}>
      <Show when={opts.title}>
        <header class={styles.head}>
          <span class={styles.title}>{opts.title}</span>
          <Show when={opts.subtitle}>
            <span class={styles.sub}>{opts.subtitle}</span>
          </Show>
        </header>
      </Show>
      <For each={opts.actions}>
        {(a) => (
          <button
            type="button"
            class={styles.item}
            classList={{ [styles.danger]: a.danger }}
            disabled={a.disabled}
            onClick={() => {
              close();
              a.onSelect();
            }}
          >
            <Show when={a.icon}>
              <span class={styles.icon}>{a.icon}</span>
            </Show>
            <span class={styles.label}>{a.label}</span>
          </button>
        )}
      </For>
    </div>
  ));
}
