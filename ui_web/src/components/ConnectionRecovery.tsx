import { Show } from 'solid-js';
import Button from './Button';
import { AccessibilityButton } from './DisplayPreferences';
import { t } from '../lib/i18n';
import styles from '../routes/Login.module.css';

/** Recovery must work before authenticated code has been downloaded. */
export function ConnectionRecovery(props: { offline?: boolean; busy?: boolean; retry: () => void }) {
  return <div class={styles.screen}>
    <section class={styles.card} aria-busy={props.busy}>
      <AccessibilityButton class={styles.accessibilityButton} />
      <div class={styles.brand} role={props.busy ? 'status' : 'alert'}>
        <h1 class={styles.title}>{t(props.busy ? 'common.loading' : props.offline ? 'common.offline' : 'common.loadFailed')}</h1>
        <Show when={props.offline}><p class={styles.blurb}>{t('library.unreachableEmpty')}</p></Show>
      </div>
      <Button disabled={props.busy} onClick={props.retry}>{t('common.retry')}</Button>
    </section>
  </div>;
}
