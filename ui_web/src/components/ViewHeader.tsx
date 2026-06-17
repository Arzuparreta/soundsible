import { Show } from 'solid-js';
import styles from './ViewHeader.module.css';

export function ViewHeader(props: { title: string; meta?: string }) {
  return (
    <header class={styles.header}>
      <h1 class={styles.title}>{props.title}</h1>
      <Show when={props.meta}>
        <span class={styles.meta}>{props.meta}</span>
      </Show>
    </header>
  );
}
