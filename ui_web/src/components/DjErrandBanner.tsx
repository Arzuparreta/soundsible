import { Show } from 'solid-js';
import { Control } from '../design/Control';
import { djErrand, endDjErrand } from '../lib/djErrand';
import { t } from '../lib/i18n';
import styles from './DjErrandBanner.module.css';

/**
 * What the next pick will do, while a DJ errand waits for one. It sits over
 * the app, where the music is chosen, because that is where the listener is
 * looking: the player asked, the app answers.
 */
export function DjErrandBanner() {
  const title = () => {
    const current = djErrand();
    if (!current) return '';
    if (current.kind === 'route') return t(current.beforeQueueId ? 'djErrand.route' : 'djErrand.routeEnd');
    return t(current.kind === 'reference' ? 'djErrand.reference' : 'djErrand.change');
  };
  return (
    <Show when={djErrand()}>
      <div class={styles.banner} role="status" data-dj-errand="">
        <div class={styles.text}>
          <strong>{title()}</strong>
          <span>{t('djErrand.hint')}</span>
        </div>
        <Control class={styles.cancel} onClick={() => endDjErrand(false)}>{t('common.cancel')}</Control>
      </div>
    </Show>
  );
}
