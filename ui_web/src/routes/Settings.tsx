import { createSignal, onMount, For } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import Button from '../components/Button';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { DevicesPanel } from '../components/DeviceSheet';
import { PairedDevicesPanel } from '../components/PairDevice';
import { t, locale, setLocale, LOCALES, type Locale } from '../lib/i18n';
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
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const changeQuality = async (q: string) => {
    setQuality(q);
    try {
      await api.setDownloaderConfig({ quality: q });
      toast.success(t('settings.toast.qualityUpdated'));
    } catch {
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const toggleAuto = async () => {
    const next = !autoUpdate();
    setAutoUpdate(next);
    try {
      await api.setDownloaderConfig({ auto_update_ytdlp: next });
    } catch {
      setAutoUpdate(!next);
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const optimize = async () => {
    const h = toast.loading(t('settings.toast.optimizing'));
    try {
      await api.optimizeLibrary();
      h.update('success', t('settings.toast.optimized'));
    } catch {
      h.update('error', t('settings.toast.optimizeFailed'));
    }
  };

  const cloudSync = async () => {
    const h = toast.loading(t('settings.toast.syncing'));
    try {
      await api.cloudSync();
      await actions.syncLibrary();
      h.update('success', t('settings.toast.synced'));
    } catch {
      h.update('error', t('settings.toast.syncFailed'));
    }
  };

  const purge = async () => {
    const ok = await confirmDialog({
      title: t('settings.purgeTitle'),
      message: t('settings.purgeMsg'),
      confirmLabel: t('settings.purgeConfirm'),
    });
    if (!ok) return;
    const h = toast.loading(t('settings.toast.purging'));
    try {
      const r = await api.purgeMissing();
      await actions.syncLibrary();
      h.update('success', t('settings.toast.purged', { count: r.removed ?? 0 }));
    } catch {
      h.update('error', t('settings.toast.purgeFailed'));
    }
  };

  const wipe = async () => {
    const ok = await confirmDialog({
      title: t('settings.emptyLibraryTitle'),
      message: t('settings.emptyLibraryMsg'),
      confirmLabel: t('settings.emptyLibraryConfirm'),
      danger: true,
    });
    if (!ok) return;
    const h = toast.loading(t('settings.toast.emptying'));
    try {
      await api.wipeLibrary();
      await actions.syncLibrary();
      h.update('success', t('settings.toast.emptied'));
    } catch {
      h.update('error', t('settings.toast.emptyFailed'));
    }
  };

  return (
    <div class="view">
      <ViewHeader title={t('settings.title')} />
      <div class={styles.scroll}>
        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.appearance')}</h2>
          <div class={styles.row}>
            <span>{t('settings.theme')}</span>
            <div class={styles.segment}>
              <button
                class={styles.seg}
                classList={{ [styles.segOn]: state.theme === 'dark' }}
                type="button"
                onClick={() => actions.setTheme('dark')}
              >
                {t('settings.themeDark')}
              </button>
              <button
                class={styles.seg}
                classList={{ [styles.segOn]: state.theme === 'light' }}
                type="button"
                onClick={() => actions.setTheme('light')}
              >
                {t('settings.themeLight')}
              </button>
            </div>
          </div>
          <Switch
            label={t('settings.haptics')}
            checked={state.haptics}
            onChange={() => actions.setHaptics(!state.haptics)}
          />
          <div class={styles.row}>
            <span>{t('settings.language')}</span>
            <select
              class={styles.select}
              value={locale()}
              onChange={(e) => setLocale(e.currentTarget.value as Locale)}
            >
              <For each={LOCALES}>
                {(l) => <option value={l.code}>{l.native}</option>}
              </For>
            </select>
          </div>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.discovery')}</h2>
          <Switch label={t('settings.learnActivity')} checked={learning()} onChange={toggleLearning} />
          <p class={styles.note}>{t('settings.learnActivityNote')}</p>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.downloads')}</h2>
          <div class={styles.row}>
            <span>{t('settings.quality')}</span>
            <select class={styles.select} value={quality()} onChange={(e) => changeQuality(e.currentTarget.value)}>
              <option value="low">{t('settings.qualityLow')}</option>
              <option value="normal">{t('settings.qualityNormal')}</option>
              <option value="high">{t('settings.qualityHigh')}</option>
            </select>
          </div>
          <Switch label={t('settings.autoUpdateYtdlp')} checked={autoUpdate()} onChange={toggleAuto} />
          <div class={styles.actions}>
            <Button variant="secondary" onClick={optimize}>
              {t('settings.optimize')}
            </Button>
            <Button variant="secondary" onClick={cloudSync}>
              {t('settings.sync')}
            </Button>
          </div>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.libraryCard')}</h2>
          <p class={styles.row}>
            <span>{t('settings.tracks')}</span>
            <span class={styles.mono}>{state.library.length}</span>
          </p>
          <div class={styles.actions}>
            <Button variant="secondary" disabled={busy()} onClick={reload}>
              {t('settings.reload')}
            </Button>
            <Button variant="secondary" disabled={busy()} onClick={rescan}>
              {t('settings.rescan')}
            </Button>
            <Button variant="secondary" onClick={purge}>
              {t('settings.purgeFiles')}
            </Button>
          </div>
          <button class={styles.dangerBtn} type="button" onClick={wipe}>
            {t('settings.emptyLibrary')}
          </button>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.importCard')}</h2>
          <p class={styles.note}>{t('settings.importNote')}</p>
          <A href="/import" class={styles.link}>
            {t('settings.importFrom')}
          </A>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.device')}</h2>
          <input
            class={styles.input}
            value={state.device.device_name}
            onInput={(e) => actions.setDeviceName(e.currentTarget.value)}
          />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.devices')}</h2>
          <DevicesPanel />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.pairedDevices')}</h2>
          <p class={styles.note}>{t('settings.pairNote')}</p>
          <PairedDevicesPanel />
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.connection')}</h2>
          <p class={styles.row}>
            <span>{t('settings.engineLabel')}</span>
            <span classList={{ [styles.ok]: state.online, [styles.bad]: !state.online }}>
              {state.online ? t('common.online') : t('common.offline')}
            </span>
          </p>
        </section>

        <section class={styles.card}>
          <h2 class={styles.cardTitle}>{t('settings.about')}</h2>
          <p class={styles.row}>
            <span>{t('brand.soundsible')}</span>
            <span class={styles.mono}>{t('settings.version')}</span>
          </p>
          <A href="/preview" class={styles.link}>
            {t('settings.viewDesign')}
          </A>
        </section>
      </div>
    </div>
  );
}
