import { Control } from '../design/Control';
import { UndoIcon } from './icons';
import styles from './SeamReset.module.css';

/**
 * The way back to an automatic layout. It only exists while the split or
 * docked width is the listener's own, so its presence says that something was
 * changed; its name shows beside it on pointer or focus.
 *
 * The seam between full-screen panels places it on the line that moved, while
 * the compact docked player places it inline in top chrome beside the device
 * button (`class`).
 */
export function SeamReset(props: { label: string; onReset: () => void; class?: string }) {
  return (
    <span class={[styles.seamReset, props.class].filter(Boolean).join(' ')}>
      <Control class={styles.button} aria-label={props.label} onClick={() => props.onReset()}>
        <UndoIcon size={16} />
      </Control>
      <span class={styles.tip} aria-hidden="true">{props.label}</span>
    </span>
  );
}
