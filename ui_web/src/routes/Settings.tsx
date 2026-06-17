import { createSignal } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import styles from './Settings.module.css';

export default function Settings() {
  const [busy, setBusy] = createSignal(false);

  const reload = async () => {
    setBusy(true);
    await actions.syncLibrary();
    setBusy(false);
  };
  const rescan = async () => {
    setBusy(true);
    await actions.rescanLibrary();
    setBusy(false);
  };

  return (
    <div class="view">
      <ViewHeader title="Ajustes" />
      <div class={styles.scroll}>
        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Conexión</h2>
          <p class={styles.row}>
            <span>Engine</span>
            <span classList={{ [styles.ok]: state.online, [styles.bad]: !state.online }}>
              {state.online ? 'Conectado' : 'Sin conexión'}
            </span>
          </p>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Biblioteca</h2>
          <p class={styles.row}>
            <span>Pistas</span>
            <span class={styles.mono}>{state.library.length}</span>
          </p>
          <div class={styles.actions}>
            <Button variant="secondary" disabled={busy()} onClick={reload}>
              Recargar
            </Button>
            <Button variant="secondary" disabled={busy()} onClick={rescan}>
              Re-escanear archivos
            </Button>
          </div>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Dispositivo</h2>
          <input
            class={styles.input}
            value={state.device.device_name}
            onInput={(e) => actions.setDeviceName(e.currentTarget.value)}
          />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Acerca de</h2>
          <p class={styles.row}>
            <span>Soundsible</span>
            <span class={styles.mono}>Beta · UI Solid</span>
          </p>
          <A href="/preview" class={styles.link}>
            Ver design system
          </A>
        </section>
      </div>
    </div>
  );
}
