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

/** The menu body (header + action buttons). Shared by the bottom-sheet
 * (`openActionMenu`) and the cursor-anchored popover (`openContextMenu`). */
export function ActionMenuList(props: { opts: ActionMenuOptions; close: () => void }) {
  return (
    <div class={styles.menu}>
      <Show when={props.opts.title}>
        <header class={styles.head}>
          <span class={styles.title}>{props.opts.title}</span>
          <Show when={props.opts.subtitle}>
            <span class={styles.sub}>{props.opts.subtitle}</span>
          </Show>
        </header>
      </Show>
      <For each={props.opts.actions}>
        {(a) => (
          <button
            type="button"
            class={styles.item}
            classList={{ [styles.danger]: a.danger }}
            disabled={a.disabled}
            onClick={() => {
              props.close();
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
  );
}

/**
 * Action sheet. Renders through `openOverlay`, so it is a bottom sheet on mobile
 * and a centered popover on desktop (overlay.module.css handles placement).
 * For a cursor-anchored context menu use `openContextMenu` (lib/contextMenu).
 */
export function openActionMenu(opts: ActionMenuOptions): void {
  openOverlay((close) => <ActionMenuList opts={opts} close={close} />);
}
