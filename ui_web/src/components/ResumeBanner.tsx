import { createMemo, Show } from 'solid-js';
import { resumeState, actions } from '../stores';
import { readPlaybackSession } from '../lib/playbackSession';
import type { RemotePlaybackState } from '../lib/api';
import { t } from '../lib/i18n';
import styles from './ResumeBanner.module.css';

/** DJ sessions come back as DJ sessions, so the offer says which one it is
 * — picking up a route, its sources and its direction is a different act from
 * picking up a song. */
const isAutoSession = (remote: RemotePlaybackState) =>
  readPlaybackSession(remote.session)?.mode === 'auto';

/**
 * Top banner offering to pick up playback that's active on another device.
 * Driven by the `resumeState` signal (set once on boot by actions.checkResume).
 */
export function ResumeBanner() {
  return (
    <Show when={resumeState()}>
      {(s) => {
        // Read once per offer: unpacking a session is a walk over a whole queue.
        const auto = createMemo(() => isAutoSession(s()));
        return (
        <div class={styles.banner} role="dialog" aria-label={t('resumeBanner.aria')}>
          <div class={styles.icon} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 3v18l15-9z" />
            </svg>
          </div>
          <div class={styles.text}>
            <span class={styles.title}>
              {auto() ? t('resumeBanner.autoTitle') : t('resumeBanner.bannerTitle')}
            </span>
            <span class={styles.sub}>
              {s().track?.title ?? t('resumeBanner.fallbackTrack')}
              {auto() ? ` · ${t('resumeBanner.autoSession')}` : ''}
              {' · '}
              {t('resumeBanner.fromDevice', { device: s().device_name ?? t('resumeBanner.fallbackDevice') })}
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
        );
      }}
    </Show>
  );
}
