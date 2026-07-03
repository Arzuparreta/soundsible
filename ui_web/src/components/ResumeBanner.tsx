import { Show } from 'solid-js';
import { resumeState, actions } from '../stores';
import { t } from '../lib/i18n';
import styles from './ResumeBanner.module.css';

/**
 * Top banner offering to pick up playback that's active on another device.
 * Driven by the `resumeState` signal (set once on boot by actions.checkResume).
 */
export function ResumeBanner() {
  return (
    <Show when={resumeState()}>
      {(s) => (
        <div class={styles.banner} role="dialog" aria-label={t('resumeBanner.aria')}>
          <div class={styles.icon} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 3v18l15-9z" />
            </svg>
          </div>
          <div class={styles.text}>
            <span class={styles.title}>{t('resumeBanner.bannerTitle')}</span>
            <span class={styles.sub}>
              {s().track?.title ?? t('resumeBanner.fallbackTrack')} · {t('resumeBanner.fromDevice', { device: s().device_name ?? t('resumeBanner.fallbackDevice') })}
            </span>
          </div>
          <div class={styles.actions}>
            <button class={styles.no} type="button" onClick={() => actions.dismissResume()}>
              {t('resumeBanner.no')}
            </button>
            <button class={styles.yes} type="button" onClick={() => actions.resumeHere()}>
              {t('resumeBanner.resume')}
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}
