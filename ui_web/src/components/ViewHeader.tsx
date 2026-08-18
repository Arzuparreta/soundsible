import { Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './ViewHeader.module.css';

export function ViewHeader(props: {
  title: string;
  meta?: string;
  actions?: JSX.Element;
  onTitleTap?: () => void;
}) {
  const tap = createResponsiveTap({
    onTap: () => props.onTitleTap?.(),
  });

  return (
    <header class={styles.header}>
      <div class={styles.heading}>
        <Show
          when={props.onTitleTap}
          fallback={<h1 class={styles.title}>{props.title}</h1>}
        >
          <h1 class={styles.title}>
            <button type="button" class={styles.titleButton} data-pressable {...tap}>
              {props.title}
            </button>
          </h1>
        </Show>
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
