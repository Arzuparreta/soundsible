import { t } from '../lib/i18n';
import { Show, type JSX } from 'solid-js';
import { createResponsiveTap } from '../lib/responsiveTap';
import styles from './ViewHeader.module.css';

export function ViewHeader(props: {
  title: string;
  meta?: string;
  actions?: JSX.Element;
  children?: JSX.Element;
  compact?: boolean;
  onBack?: () => void;
  onTitleTap?: () => void;
}) {
  const tap = createResponsiveTap({
    onTap: () => props.onTitleTap?.(),
  });

  return (
    <header class={styles.header} data-compact={props.compact ? '' : undefined}>
      <Show when={props.onBack}><button type="button" class={styles.back} aria-label={t('common.back')} onClick={props.onBack}>‹</button></Show>
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
      <Show when={props.actions || props.children}>
        <div class={styles.actions}>{props.actions}{props.children}</div>
      </Show>
    </header>
  );
}
