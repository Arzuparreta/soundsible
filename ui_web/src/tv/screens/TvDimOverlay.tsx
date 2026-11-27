import { createEffect, Show, untrack } from 'solid-js';
import { t } from '../../lib/i18n';
import { state } from '../../stores';
import { useTvFocus } from '../nav/spatial';
import { dimActive, setDimActive } from '../state';
import styles from '../styles/tv.module.css';

export function TvDimOverlay() {
  const focus = useTvFocus();
  let priorFocusId: string | null = null;

  createEffect(() => {
    if (dimActive()) {
      priorFocusId = untrack(focus.activeId);
    } else if (priorFocusId) {
      const target = priorFocusId;
      priorFocusId = null;
      queueMicrotask(() => {
        if (!focus.focusById(target)) {
          focus.reconcileFocus();
        }
      });
    }
  });

  return (
    <Show when={dimActive()}>
      <div
        class={styles.tvDimScreen}
        role="region"
        aria-label={t('tv.player.dimTitle')}
        onClick={() => setDimActive(false)}
      >
        <p class={styles.tvEyebrow}>{t('tv.player.dimTitle')}</p>
        <Show when={state.playback.currentTrack}>
          {(track) => (
            <>
              <h2 class={styles.tvHeroTitle}>{track().title}</h2>
              <p class={styles.tvPageTitle}>{track().artist}</p>
            </>
          )}
        </Show>
        <p class={styles.tvSubtitle}>{t('tv.player.dimHint')}</p>
      </div>
    </Show>
  );
}
