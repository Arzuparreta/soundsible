import { createSignal, onMount } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { DevicesPanel } from '../components/DeviceSheet';
import { PairedDevicesPanel } from '../components/PairDevice';
import styles from './Settings.module.css';

function Switch(props: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label class={styles.switchRow}>
      <span>{props.label}</span>
      <button
        type="button"
        class={styles.switch}
        classList={{ [styles.switchOn]: props.checked }}
        role="switch"
        aria-checked={props.checked}
        onClick={props.onChange}
      >
        <span class={styles.knob} />
      </button>
    </label>
  );
}

export default function Settings() {
  const [busy, setBusy] = createSignal(false);
  const [learning, setLearning] = createSignal(true);
  const [quality, setQuality] = createSignal('high');
  const [autoUpdate, setAutoUpdate] = createSignal(false);

  onMount(async () => {
    try {
      const d = await api.getDiscoverySettings();
      if (typeof d.learning_enabled === 'boolean') setLearning(d.learning_enabled);
    } catch {
      /* leave defaults */
    }
    try {
      const c = await api.getDownloaderConfig();
      if (c.quality) setQuality(c.quality);
      if (typeof c.auto_update_ytdlp === 'boolean') setAutoUpdate(c.auto_update_ytdlp);
    } catch {
      /* leave defaults */
    }
  });

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

  const toggleLearning = async () => {
    const next = !learning();
    setLearning(next);
    try {
      await api.setDiscoveryLearning(next);
    } catch {
      setLearning(!next);
      toast.error('No se pudo guardar');
    }
  };

  const changeQuality = async (q: string) => {
    setQuality(q);
    try {
      await api.setDownloaderConfig({ quality: q });
      toast.success('Calidad actualizada');
    } catch {
      toast.error('No se pudo guardar');
    }
  };

  const toggleAuto = async () => {
    const next = !autoUpdate();
    setAutoUpdate(next);
    try {
      await api.setDownloaderConfig({ auto_update_ytdlp: next });
    } catch {
      setAutoUpdate(!next);
      toast.error('No se pudo guardar');
    }
  };

  const optimize = async () => {
    const t = toast.loading('Optimizando…');
    try {
      await api.optimizeLibrary();
      t.update('success', 'Biblioteca optimizada');
    } catch {
      t.update('error', 'No se pudo optimizar');
    }
  };

  const cloudSync = async () => {
    const t = toast.loading('Sincronizando…');
    try {
      await api.cloudSync();
      await actions.syncLibrary();
      t.update('success', 'Sincronizado');
    } catch {
      t.update('error', 'No se pudo sincronizar');
    }
  };

  const purge = async () => {
    const ok = await confirmDialog({
      title: 'Purgar archivos perdidos',
      message: 'Quita de la biblioteca las pistas cuyos archivos ya no existen en el disco.',
      confirmLabel: 'Purgar',
    });
    if (!ok) return;
    const t = toast.loading('Purgando…');
    try {
      const r = await api.purgeMissing();
      await actions.syncLibrary();
      t.update('success', `Purgado (${r.removed ?? 0})`);
    } catch {
      t.update('error', 'No se pudo purgar');
    }
  };

  const wipe = async () => {
    const ok = await confirmDialog({
      title: 'Vaciar biblioteca',
      message: 'Se borrará TODA la biblioteca. Esta acción no se puede deshacer.',
      confirmLabel: 'Vaciar todo',
      danger: true,
    });
    if (!ok) return;
    const t = toast.loading('Vaciando…');
    try {
      await api.wipeLibrary();
      await actions.syncLibrary();
      t.update('success', 'Biblioteca vaciada');
    } catch {
      t.update('error', 'No se pudo vaciar');
    }
  };

  return (
    <div class="view">
      <ViewHeader title="Ajustes" />
      <div class={styles.scroll}>
        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Apariencia</h2>
          <div class={styles.row}>
            <span>Tema</span>
            <div class={styles.segment}>
              <button
                class={styles.seg}
                classList={{ [styles.segOn]: state.theme === 'dark' }}
                type="button"
                onClick={() => actions.setTheme('dark')}
              >
                Oscuro
              </button>
              <button
                class={styles.seg}
                classList={{ [styles.segOn]: state.theme === 'light' }}
                type="button"
                onClick={() => actions.setTheme('light')}
              >
                Claro
              </button>
            </div>
          </div>
          <Switch label="Vibración (hápticos)" checked={state.haptics} onChange={() => actions.setHaptics(!state.haptics)} />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Descubrimiento</h2>
          <Switch label="Aprender de mi actividad" checked={learning()} onChange={toggleLearning} />
          <p class={styles.note}>Mejora las recomendaciones usando tu historial local. No se envía a terceros.</p>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Descargas</h2>
          <div class={styles.row}>
            <span>Calidad</span>
            <select class={styles.select} value={quality()} onChange={(e) => changeQuality(e.currentTarget.value)}>
              <option value="low">Baja</option>
              <option value="normal">Normal</option>
              <option value="high">Alta</option>
            </select>
          </div>
          <Switch label="Auto-actualizar yt-dlp" checked={autoUpdate()} onChange={toggleAuto} />
          <div class={styles.actions}>
            <Button variant="secondary" onClick={optimize}>
              Optimizar biblioteca
            </Button>
            <Button variant="secondary" onClick={cloudSync}>
              Sincronizar en la nube
            </Button>
          </div>
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
            <Button variant="secondary" onClick={purge}>
              Purgar archivos perdidos
            </Button>
          </div>
          <button class={styles.dangerBtn} type="button" onClick={wipe}>
            Vaciar biblioteca
          </button>
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
          <h2 class={styles.cardTitle}>Dispositivos</h2>
          <DevicesPanel />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>Dispositivos vinculados</h2>
          <p class={styles.note}>Vincula tu teléfono escaneando un QR para controlarlo y reproducir en remoto.</p>
          <PairedDevicesPanel />
        </section>

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
