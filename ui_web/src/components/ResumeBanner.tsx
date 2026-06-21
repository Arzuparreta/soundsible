import { Show } from 'solid-js';
import { resumeState, actions } from '../stores';
import styles from './ResumeBanner.module.css';

/**
 * Top banner offering to pick up playback that's active on another device.
 * Driven by the `resumeState` signal (set once on boot by actions.checkResume).
 */
export function ResumeBanner() {
  return (
    <Show when={resumeState()}>
      {(s) => (
        <div class={styles.banner} role="dialog" aria-label="Reanudar reproducción">
          <div class={styles.icon} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 3v18l15-9z" />
            </svg>
          </div>
          <div class={styles.text}>
            <span class={styles.title}>¿Reanudar reproducción?</span>
            <span class={styles.sub}>
              {s().track?.title ?? 'Una pista'} · desde {s().device_name ?? 'otro dispositivo'}
            </span>
          </div>
          <div class={styles.actions}>
            <button class={styles.no} type="button" onClick={() => actions.dismissResume()}>
              No
            </button>
            <button class={styles.yes} type="button" onClick={() => actions.resumeHere()}>
              Reanudar
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
