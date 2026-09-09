import { For, Index, Show } from 'solid-js';
import { t } from '../lib/i18n';
import { bottomNavigation, setBottomNavigation } from '../lib/bottomNavigation';
import { defaultBottomNavigation, navigationItems } from './primaryNavigation';
import { SettingsGroup } from './SettingsRows';
import styles from './BottomNavigationSettings.module.css';

export function BottomNavigationSettings() {
  const change = (index: number, href: string) => {
    const next = [...bottomNavigation()];
    const previous = next.indexOf(href);
    if (previous >= 0) next[previous] = next[index];
    next[index] = href;
    setBottomNavigation(next);
  };
  return <SettingsGroup label={t('nav.bottomBar')} note={t('nav.bottomBarHint')}>
    <div class={styles.editor}>
      <div class={styles.preview} aria-hidden="true"><For each={bottomNavigation()}>{href => {
        const item = navigationItems.find(item => item.href === href)!;
        return <div>{item.icon()}<span>{item.label()}</span></div>;
      }}</For></div>
      <Index each={bottomNavigation()}>{(href, index) => <div class={styles.row}>
        <label for={`bottom-position-${index}`}>{t('nav.position', { position: index + 1 })}</label>
        <select id={`bottom-position-${index}`} value={href()} onChange={event => change(index, event.currentTarget.value)}>
          <For each={navigationItems}>{item => <option value={item.href} selected={item.href === href()}>{item.label()}</option>}</For>
        </select>
        <button type="button" disabled={bottomNavigation().length <= 3}
          aria-label={t('nav.removeDestination', { name: navigationItems.find(item => item.href === href())!.label() })}
          onClick={() => setBottomNavigation(bottomNavigation().filter((_, i) => i !== index))}>×</button>
      </div>}</Index>
      <div class={styles.actions}>
        <Show when={bottomNavigation().length < 5}><button type="button" onClick={() => setBottomNavigation([...bottomNavigation(), navigationItems.find(item => !bottomNavigation().includes(item.href))!.href])}>{t('nav.addDestination')}</button></Show>
        <button type="button" onClick={() => setBottomNavigation([...defaultBottomNavigation])}>{t('nav.restoreDefaults')}</button>
      </div>
    </div>
  </SettingsGroup>;
}
