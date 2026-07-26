import type { JSX } from 'solid-js';
import styles from './EmptyState.module.css';

/** Quiet, reusable empty/error well. It gives standalone copy a deliberate
 * visual home without turning sparse app states into explanatory dashboards. */
export function EmptyState(props: {
  children: JSX.Element;
  compact?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div
      classList={{
        [styles.state]: true,
        [styles.compact]: props.compact,
        [styles.danger]: props.tone === 'danger',
      }}
      role="status"
    >
      <span class={styles.glyph} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <div class={styles.copy}>{props.children}</div>
    </div>
  );
}
