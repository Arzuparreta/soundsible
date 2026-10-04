import { type JSX } from 'solid-js';
import { state } from '../stores/core';
import { visualPreferenceActions as actions } from '../stores/visualPreferences';
import { t } from '../lib/i18n';
import { openOverlay } from '../lib/overlay';
import { DisplayPreferencesView } from './DisplayPreferencesView';

export function DisplayPreferences(props: { heading?: boolean; onClose?: () => void } = {}) {
  return <DisplayPreferencesView heading={props.heading} onClose={props.onClose}
    interfaceSize={state.interfaceSize} highContrast={state.highContrast}
    onSize={actions.setInterfaceSize} onContrast={actions.setHighContrast} />;
}

export function openDisplayPreferences(): () => void {
  return openOverlay(
    (close) => <DisplayPreferences heading onClose={close} />,
    { ariaLabel: t('accessibility.title') },
  );
}

export function AccessibilityButton(props: { class?: string }): JSX.Element {
  return (
    <button
      type="button"
      class={props.class}
      aria-label={t('accessibility.open')}
      title={t('accessibility.open')}
      onClick={openDisplayPreferences}
    >
      <span aria-hidden="true">Aa</span>
    </button>
  );
}
