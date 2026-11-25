import type { JSX } from 'solid-js';
import styles from './CoverGlass.module.css';

/** A decorative cover projection behind the transport, clipped independently
 * so focus rings, overlays and seek targets can extend outside the glass. */
export function CoverGlass(props: { artwork: JSX.CSSProperties | undefined }) {
  return <span aria-hidden="true" class={styles.glass}><span style={props.artwork} /></span>;
}
