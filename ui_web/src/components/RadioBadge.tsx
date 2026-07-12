import { Show, type JSX } from 'solid-js';
import { state, actions } from '../stores';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';

/** Inline `{styles.radioBadge}` class is supplied by the host component so the
 * badge can match its surroundings (mini bar vs full now-playing) without
 * owning a CSS module. While `radioLoading` is true, an extra modifier class
 * `radioBadgeLoading` is added so the host can pulse it. */
export async function onStopRadio(): Promise<void> {
  const ok = await confirmDialog({
    title: t('nowPlaying.stopRadioTitle'),
    message: t('nowPlaying.stopRadioMsg'),
    confirmLabel: t('nowPlaying.stopRadioConfirm'),
    danger: true,
  });
  if (ok) actions.stopRadio();
}

export function RadioBadge(props: { class: string; loadingClass: string }): JSX.Element {
  return (
    <Show when={state.playback.radioMode}>
      <button
        type="button"
        class={props.class}
        classList={{ [props.loadingClass]: state.playback.radioLoading }}
        onClick={() => void onStopRadio()}
        aria-label={t('nowPlaying.radioActiveAria')}
        title={t('nowPlaying.radioActiveAria')}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 12a8 8 0 018-8M4 12a8 8 0 008 8M8 12a4 4 0 014-4" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </Show>
  );
}