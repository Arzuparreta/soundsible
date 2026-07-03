import { Show } from 'solid-js';
import { state } from '../stores';
import { openOverlay } from '../lib/overlay';
import { t } from '../lib/i18n';
import Button from '../components/Button';
import styles from './Placeholder.module.css';

/**
 * Temporary view body used by every route until the real Phase 3 views land.
 * It exercises the architecture: reads `online` from the store (reactive) and
 * opens a sheet through the overlay manager (leak-proof).
 */
export function Placeholder(props: { title: string; blurb?: string }) {
  const demo = () =>
    openOverlay((close) => (
      <div class={styles.demo}>
        <h2 class={styles.demoTitle}>{t('placeholder.overlayHeading')}</h2>
        <p class={styles.demoText}>
          {t('placeholder.overlayText')}
        </p>
        <Button onClick={close}>{t('placeholder.overlayClose')}</Button>
      </div>
    ));

  return (
    <section class={styles.page}>
      <span class={styles.kicker}>{state.online ? t('placeholder.statusOnline') : t('placeholder.statusOffline')}</span>
      <h1 class={styles.title}>{props.title}</h1>
      <Show when={props.blurb}>
        <p class={styles.blurb}>{props.blurb}</p>
      </Show>
      <div class={styles.actions}>
        <Button onClick={demo}>{t('placeholder.tryOverlay')}</Button>
      </div>
    </section>
  );
}
