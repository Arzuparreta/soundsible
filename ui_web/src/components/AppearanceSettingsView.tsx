import { For } from 'solid-js';
import { EXTRA_THEMES, type Theme } from '../boot/themes';
import { t, locale, setLocale, LOCALES, type Locale } from '../lib/i18n';
import { ChoiceGroup, SelectRow, SettingsGroup } from './SettingsRows';

const labels: Record<Theme, () => string> = {
  system: () => t('settings.themeSystem'), dark: () => t('settings.themeDark'),
  light: () => t('settings.themeLight'), slate: () => t('settings.themeSlate'),
  'pure-black': () => t('settings.themePureBlack'), 'forest-green': () => t('settings.themeForestGreen'),
};
const order: Theme[] = ['system', 'dark', 'light', ...EXTRA_THEMES];

/** The same appearance choices, with the runtime preference injected. */
export function AppearanceSettingsView(props: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return <>
    <ChoiceGroup anchor="theme" label={t('settings.theme')} value={props.theme} onChange={props.onTheme}
      options={order.map(theme => ({ value: theme, label: labels[theme](), hint: theme === 'system' ? t('settings.note.theme') : undefined }))} />
    <SettingsGroup><SelectRow anchor="language" label={t('settings.language')} value={locale()} onChange={value => void setLocale(value as Locale)}>
      <For each={LOCALES}>{language => <option value={language.code}>{language.native}</option>}</For>
    </SelectRow></SettingsGroup>
  </>;
}
