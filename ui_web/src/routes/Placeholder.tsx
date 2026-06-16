import { Show } from 'solid-js';
import { state } from '../stores';
import { openOverlay } from '../lib/overlay';
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
        <h2 class={styles.demoTitle}>Overlay manager</h2>
        <p class={styles.demoText}>
          Este sheet vive en el registro de overlays. Al cerrarlo — o al navegar a otra
          vista — su DOM, listeners y scope reactivo se limpian solos. El leak histórico de
          Discover es imposible por diseño.
        </p>
        <Button onClick={close}>Cerrar</Button>
      </div>
    ));

  return (
    <section class={styles.page}>
      <span class={styles.kicker}>{state.online ? 'engine ●' : 'offline ○'}</span>
      <h1 class={styles.title}>{props.title}</h1>
      <Show when={props.blurb}>
        <p class={styles.blurb}>{props.blurb}</p>
      </Show>
      <div class={styles.actions}>
        <Button onClick={demo}>Probar overlay</Button>
      </div>
    </section>
  );
}
