import type { JSX } from 'solid-js';
import styles from './Spinner.module.css';

export interface SpinnerProps {
  /** Diameter in px. Defaults to 16. */
  size?: number;
  /** Invert the ring for use on top of a filled accent surface. */
  onAccent?: boolean;
  /** Screen-reader label. Omit for spinners next to text that already says it. */
  label?: string;
  class?: string;
}

/**
 * The shared indeterminate spinner. One ring, one keyframe — every surface that
 * needs "working on it" uses this instead of its own copy.
 */
export function Spinner(props: SpinnerProps) {
  const style = (): JSX.CSSProperties | undefined =>
    props.size ? ({ '--size': `${props.size}px` } as JSX.CSSProperties) : undefined;
  return (
    <span
      classList={{
        [styles.spinner]: true,
        [styles.onAccent]: props.onAccent,
        ...(props.class ? { [props.class]: true } : {}),
      }}
      style={style()}
      role={props.label ? 'status' : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : true}
    />
  );
}
