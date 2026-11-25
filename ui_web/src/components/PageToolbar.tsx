import { Show, type JSX } from 'solid-js';
import styles from './PageToolbar.module.css';

/** Search takes the available space. Metadata and commands keep their reading order
 * and can wrap on narrow panes, including a window with the player docked. */
export function PageToolbar(props: {
  field?: JSX.Element;
  meta?: JSX.Element;
  actions?: JSX.Element;
  /** The parent section already supplies the page gutter. */
  contained?: boolean;
}) {
  return <header class={styles.toolbar} data-page-toolbar data-contained={props.contained ? '' : undefined}>
    <Show when={props.field}>{field => <div class={styles.field}>{field()}</div>}</Show>
    <Show when={props.meta}>{meta => <span class={styles.meta}>{meta()}</span>}</Show>
    <Show when={props.actions}>{actions => <div class={styles.actions}>{actions()}</div>}</Show>
  </header>;
}
