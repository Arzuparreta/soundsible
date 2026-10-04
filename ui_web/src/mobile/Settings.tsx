import { createSignal, Show } from 'solid-js';
import NativeSettingsAccount from './SettingsAccount';
import { AppearanceSettingsView } from '../components/AppearanceSettingsView';
import { DisplayPreferencesView } from '../components/DisplayPreferencesView';
import { t } from '../lib/i18n';
import { registerNativeBack } from './backNavigation';
import type { createNativeAppearance } from './appearance';
import type { ComponentProps } from 'solid-js';
import styles from './AndroidStart.module.css';

export default function NativeSettings(props: ComponentProps<typeof NativeSettingsAccount> & {
  appearance: ReturnType<typeof createNativeAppearance>;
}) {
  const [section, setSection] = createSignal<'account' | 'appearance' | 'accessibility'>('account');
  registerNativeBack(() => { if (section() === 'account') return false; setSection('account'); return true; });
  return <section class={styles.library} data-testid="android-settings">
    <nav class={styles.tabs} aria-label={t('nav.settings')}>
      <button data-android-settings-account aria-pressed={section() === 'account'} onClick={() => setSection('account')}>{t('account.title')}</button>
      <button data-android-settings-appearance aria-pressed={section() === 'appearance'} onClick={() => setSection('appearance')}>{t('settings.appearance')}</button>
      <button data-android-settings-accessibility aria-pressed={section() === 'accessibility'} onClick={() => setSection('accessibility')}>{t('accessibility.title')}</button>
    </nav>
    <Show when={section() === 'account'}><NativeSettingsAccount {...props} /></Show>
    <Show when={section() === 'appearance'}><AppearanceSettingsView theme={props.appearance.theme()} onTheme={props.appearance.setTheme} /></Show>
    <Show when={section() === 'accessibility'}><DisplayPreferencesView interfaceSize={props.appearance.interfaceSize()} highContrast={props.appearance.highContrast()}
      onSize={props.appearance.setInterfaceSize} onContrast={props.appearance.setHighContrast} /></Show>
  </section>;
}
