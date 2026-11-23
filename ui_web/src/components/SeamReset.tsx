import { Control } from '../design/Control';
import { UndoIcon } from './icons';
import styles from './SeamReset.module.css';

/**
 * The way back to an automatic split, on the line that was moved. It only
 * exists while the split is the listener's own, so its presence says that
 * something was changed; its name shows beside it on pointer or focus.
 *
 * The seam between the player's panels and the edge of the docked player both
 * use it: one gesture to resize, the same button to undo it. The host places
 * it on its line (`class`).
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
