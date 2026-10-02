import { onMount } from 'solid-js';
import { t } from '../lib/i18n';
import logo from '../../../branding/logo-mark.svg';
import styles from './AndroidStart.module.css';

export default function AndroidStart() {
  onMount(() => window.__SOUNDSIBLE_BOOT__?.complete());
  return <main class={styles.start} data-testid="android-unconfigured">
    <img src={logo} alt="" width="64" height="64" />
    <h1>{t('android.title')}</h1>
    <p>{t('android.unconfigured')}</p>
  </main>;
}
