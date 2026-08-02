import { For, Show, type JSX } from 'solid-js';
import { openOverlay } from '../lib/overlay';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './ActionMenu.module.css';

export interface MenuAction {
  icon?: JSX.Element;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A labelled group of actions, rendered under its own heading. Lets one menu
 * hold several independent choices (e.g. sort order and a display filter)
 * without them reading as a single list. */
export interface ActionMenuSection {
  label: string;
  actions: MenuAction[];
}

export interface ActionMenuOptions {
  title?: string;
  subtitle?: string;
  /** Flat action list. Ignored when `sections` is set. */
  actions?: MenuAction[];
  sections?: ActionMenuSection[];
}

function ActionButton(props: { action: MenuAction; close: () => void }) {
  const tap = createResponsiveTap({
    disabled: () => Boolean(props.action.disabled),
    onTap: () => {
      props.close();
      props.action.onSelect();
    },
  });
  return (
    <button
      type="button"
      class={styles.item}
      classList={{ [styles.danger]: props.action.danger }}
      disabled={props.action.disabled}
      data-pressable
      {...tap}
    >
      <Show when={props.action.icon}>
        <span class={styles.icon}>{props.action.icon}</span>
      </Show>
      <span class={styles.label}>{props.action.label}</span>
    </button>
  );
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
      <Show
        when={props.opts.sections}
        fallback={
          <For each={props.opts.actions}>{(a) => <ActionButton action={a} close={props.close} />}</For>
        }
      >
        <For each={props.opts.sections}>
          {(section) => (
            <div class={styles.section}>
              <span class={styles.sectionLabel}>{section.label}</span>
              <For each={section.actions}>{(a) => <ActionButton action={a} close={props.close} />}</For>
            </div>
          )}
        </For>
      </Show>
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
