import { Show, type JSX } from 'solid-js';
import styles from './ViewHeader.module.css';

export function ViewHeader(props: { title: string; meta?: string; actions?: JSX.Element }) {
  return (
    <header class={styles.header}>
      <div class={styles.heading}>
        <h1 class={styles.title}>{props.title}</h1>
        <Show when={props.meta}>
          <span class={styles.meta}>{props.meta}</span>
        </Show>
      </div>
      <Show when={props.actions}>
        <div class={styles.actions}>{props.actions}</div>
      </Show>
    </header>
  );
}
