import { Show, type JSX } from 'solid-js';
import { state, actions } from '../stores';
import { confirmDialog } from '../lib/confirm';
import { t } from '../lib/i18n';
import { RadioIcon } from './icons';

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
        <RadioIcon size={16} />
      </button>
    </Show>
  );
}