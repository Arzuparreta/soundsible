import { createSignal, Show } from 'solid-js';
import { UsersPanel } from '../components/UsersPanel';
import NativeDevices from './Devices';
import NativeSettingsAccount from './SettingsAccount';
import NativeSettingsRecommendations from './SettingsRecommendations';
import NativeSettingsPlayback from './SettingsPlayback';
import NativeSettingsSubsonic from './SettingsSubsonic';
import { AppearanceSettingsView } from '../components/AppearanceSettingsView';
import { DisplayPreferencesView } from '../components/DisplayPreferencesView';
import { t } from '../lib/i18n';
import { registerNativeBack } from './backNavigation';
import type { createNativeAppearance } from './appearance';
import type { createNativeFeedback } from './feedback';
import { HapticSettingsView } from '../components/HapticSettingsView';
import type { ComponentProps } from 'solid-js';
import styles from './AndroidStart.module.css';

export default function NativeSettings(props: ComponentProps<typeof NativeSettingsAccount> & {
  appearance: ReturnType<typeof createNativeAppearance>;
  feedback: ReturnType<typeof createNativeFeedback>;
  playback: ComponentProps<typeof NativeSettingsPlayback>;
  generation?: () => number;
  subsonic?: ComponentProps<typeof NativeSettingsSubsonic>;
}) {
  const [section, setSection] = createSignal<'account' | 'appearance' | 'accessibility' | 'recommendations' | 'playback' | 'subsonic' | 'users' | 'devices'>('account');
  const captured = props.identity();
  const current = () => captured === props.identity() && props.available();
  registerNativeBack(() => { if (section() === 'account') return false; setSection('account'); return true; });
  return <section class={styles.library} data-testid="android-settings">
    <nav class={styles.tabs} aria-label={t('nav.settings')}>
      <button data-android-settings-account aria-pressed={section() === 'account'} onClick={() => setSection('account')}>{t('account.title')}</button>
      <button data-android-settings-appearance aria-pressed={section() === 'appearance'} onClick={() => setSection('appearance')}>{t('settings.appearance')}</button>
      <button data-android-settings-accessibility aria-pressed={section() === 'accessibility'} onClick={() => setSection('accessibility')}>{t('accessibility.title')}</button>
      <button data-android-settings-recommendations aria-pressed={section() === 'recommendations'} onClick={() => setSection('recommendations')}>{t('settings.group.recommendations')}</button>
      <button data-android-settings-playback aria-pressed={section() === 'playback'} onClick={() => setSection('playback')}>{t('settings.playback')}</button>
      <Show when={props.generation}><button data-android-settings-devices aria-pressed={section() === 'devices'} onClick={() => setSection('devices')}>{t('settings.devices')}</button></Show>
      <Show when={props.user.role === 'admin'}><button data-android-settings-users aria-pressed={section() === 'users'} disabled={!props.available()} onClick={() => setSection('users')}>{t('users.title')}</button></Show>
      <Show when={props.subsonic}><button data-android-settings-subsonic aria-pressed={section() === 'subsonic'} onClick={() => setSection('subsonic')}>Subsonic</button></Show>
    </nav>
    <Show when={section() === 'users' && props.user.role === 'admin'}><section data-testid="android-settings-users">
      <h2>{t('users.title')}</h2><fieldset disabled={!current() || props.busy}><UsersPanel account={() => props.user} current={current} /></fieldset>
    </section></Show>
    <Show when={section() === 'devices' && props.generation}>{generation => <NativeDevices generation={generation()} current={current} />}</Show>
    <Show when={section() === 'account'}><NativeSettingsAccount {...props} /></Show>
    <Show when={section() === 'recommendations'}><NativeSettingsRecommendations identity={props.identity} available={props.available} /></Show>
    <Show when={section() === 'playback'}><NativeSettingsPlayback {...props.playback} /></Show>
    <Show when={section() === 'subsonic' && props.subsonic}>{settings => <NativeSettingsSubsonic {...settings()} />}</Show>
    <Show when={section() === 'appearance'}><AppearanceSettingsView theme={props.appearance.theme()} onTheme={props.appearance.setTheme} /></Show>
    <Show when={section() === 'accessibility'}><DisplayPreferencesView interfaceSize={props.appearance.interfaceSize()} highContrast={props.appearance.highContrast()}
      onSize={props.appearance.setInterfaceSize} onContrast={props.appearance.setHighContrast} />
      <HapticSettingsView enabled={props.feedback.enabled()} onChange={props.feedback.setEnabled} /></Show>
  </section>;
}
