import { createSignal, onMount, For, type JSX } from 'solid-js';
import { A } from '@solidjs/router';
import { state, actions } from '../stores';
import { ViewHeader } from '../components/ViewHeader';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { promptDialog } from '../lib/prompt';
import { DevicesPanel } from '../components/DeviceSheet';
import { PairedDevicesPanel } from '../components/PairDevice';
import { t, locale, setLocale, LOCALES, type Locale } from '../lib/i18n';
import { trackCount } from '../lib/format';
import styles from './Settings.module.css';

function Chevron() {
  return (
    <svg class={styles.chevron} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function Group(props: { label: string; children: JSX.Element }) {
  return (
    <section class={styles.group}>
      <h2 class={styles.groupLabel}>{props.label}</h2>
      {props.children}
    </section>
  );
}

function Switch(props: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <div class={styles.row}>
      <span class={styles.rowLabel}>{props.label}</span>
      <button
        type="button"
        class={styles.switch}
        classList={{ [styles.switchOn]: props.checked }}
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        onClick={props.onChange}
      >
        <span class={styles.knob} />
      </button>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg class={styles.warnIcon} viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3.2L2.4 20.2a1 1 0 0 0 .88 1.5h17.44a1 1 0 0 0 .88-1.5L12 3.2zm0 5.3a.9.9 0 0 1 .9.9v4.4a.9.9 0 0 1-1.8 0V9.4a.9.9 0 0 1 .9-.9zm0 8.4a1.05 1.05 0 1 1 0-2.1 1.05 1.05 0 0 1 0 2.1z"
      />
    </svg>
  );
}

function ActionRow(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  warn?: boolean;
}) {
  return (
    <button
      type="button"
      class={styles.rowBtn}
      classList={{ [styles.rowBtnDanger]: props.danger }}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span class={styles.rowLabel} classList={{ [styles.rowLabelWithIcon]: props.warn }}>
        {props.label}
        {props.warn ? <WarnIcon /> : null}
      </span>
      <Chevron />
    </button>
  );
}

function NavRow(props: { href: string; label: string }) {
  return (
    <A href={props.href} class={styles.rowLink}>
      <span class={styles.rowLabel}>{props.label}</span>
      <Chevron />
    </A>
  );
}

const QUALITY_OPTIONS = ['low', 'normal', 'high'] as const;

function qualityLabel(q: string): string {
  if (q === 'low') return t('settings.qualityLow');
  if (q === 'normal') return t('settings.qualityNormal');
  return t('settings.qualityHigh');
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
      /* defaults */
    }
    try {
      const c = await api.getDownloaderConfig();
      if (c.quality) setQuality(c.quality);
      if (typeof c.auto_update_ytdlp === 'boolean') setAutoUpdate(c.auto_update_ytdlp);
    } catch {
      /* defaults */
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
    const count = state.library.length;
    const typed = await promptDialog({
      title: t('settings.emptyLibraryTitle'),
      message: t('settings.emptyLibraryCountMsg', { count: trackCount(count) }),
      inputLabel: t('settings.emptyLibraryCountLabel'),
      confirmLabel: t('settings.emptyLibraryConfirm'),
      danger: true,
      match: String(count),
    });
    if (typed === null) return;
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
      <ViewHeader title={t('settings.title')} meta={trackCount(state.library.length)} />

      <div class={styles.scroll}>
        <Group label={t('settings.appearance')}>
          <div class={styles.panel}>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('settings.theme')}</span>
              <div class={styles.segment} role="group" aria-label={t('settings.theme')}>
                <button
                  type="button"
                  class={styles.seg}
                  classList={{ [styles.segOn]: state.theme === 'dark' }}
                  aria-label={t('settings.themeDark')}
                  aria-pressed={state.theme === 'dark'}
                  onClick={() => actions.setTheme('dark')}
                >
                  <span class={styles.segIcon}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  class={styles.seg}
                  classList={{ [styles.segOn]: state.theme === 'system' }}
                  aria-label={t('settings.themeSystem')}
                  aria-pressed={state.theme === 'system'}
                  onClick={() => actions.setTheme('system')}
                >
                  <span class={styles.segIcon}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <path d="M8 21h8M12 17v4" />
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  class={styles.seg}
                  classList={{ [styles.segOn]: state.theme === 'light' }}
                  aria-label={t('settings.themeLight')}
                  aria-pressed={state.theme === 'light'}
                  onClick={() => actions.setTheme('light')}
                >
                  <span class={styles.segIcon}>
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('settings.language')}</span>
              <select
                class={styles.select}
                value={locale()}
                aria-label={t('settings.language')}
                onChange={(e) => setLocale(e.currentTarget.value as Locale)}
              >
                <For each={LOCALES}>
                  {(l) => <option value={l.code}>{l.native}</option>}
                </For>
              </select>
            </div>
            <Switch
              label={t('settings.haptics')}
              checked={state.haptics}
              onChange={() => actions.setHaptics(!state.haptics)}
            />
          </div>
        </Group>

        <Group label={t('settings.libraryCard')}>
          <div class={styles.panel}>
            <ActionRow label={t('settings.reload')} onClick={reload} disabled={busy()} />
            <ActionRow label={t('settings.rescan')} onClick={rescan} disabled={busy()} />
            <ActionRow label={t('settings.purgeFiles')} onClick={purge} />
            <NavRow href="/import" label={t('settings.importFrom')} />
            <ActionRow label={t('settings.emptyLibrary')} onClick={wipe} danger warn />
          </div>
        </Group>

        <Group label={t('settings.downloads')}>
          <div class={styles.panel}>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('settings.quality')}</span>
              <div class={styles.segment} role="group" aria-label={t('settings.quality')}>
                <For each={QUALITY_OPTIONS}>
                  {(q) => (
                    <button
                      type="button"
                      class={styles.seg}
                      classList={{ [styles.segOn]: quality() === q }}
                      aria-pressed={quality() === q}
                      onClick={() => changeQuality(q)}
                    >
                      {qualityLabel(q)}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <Switch label={t('settings.autoUpdateYtdlp')} checked={autoUpdate()} onChange={toggleAuto} />
            <Switch label={t('settings.learnActivity')} checked={learning()} onChange={toggleLearning} />
            <ActionRow label={t('settings.optimize')} onClick={optimize} />
            <ActionRow label={t('settings.sync')} onClick={cloudSync} />
          </div>
        </Group>

        <Group label={t('settings.device')}>
          <div class={styles.panel}>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('settings.device')}</span>
              <input
                class={styles.input}
                value={state.device.device_name}
                aria-label={t('settings.device')}
                onInput={(e) => actions.setDeviceName(e.currentTarget.value)}
              />
            </div>
          </div>
        </Group>

        <Group label={t('settings.pairedDevices')}>
          <div class={styles.panel}>
            <PairedDevicesPanel />
          </div>
        </Group>

        <Group label={t('settings.devices')}>
          <div class={styles.panel}>
            <DevicesPanel />
          </div>
        </Group>

        <Group label={t('settings.about')}>
          <div class={styles.panel}>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('settings.engineLabel')}</span>
              <span class={styles.statusRow}>
                <span
                  class={styles.statusDot}
                  classList={{ [styles.statusOn]: state.online, [styles.statusOff]: !state.online }}
                  aria-hidden="true"
                />
                {state.online ? t('common.online') : t('common.offline')}
              </span>
            </div>
            <div class={styles.row}>
              <span class={styles.rowLabel}>{t('brand.soundsible')}</span>
              <span class={styles.mono}>{t('settings.version')}</span>
            </div>
            <NavRow href="/preview" label={t('settings.viewDesign')} />
          </div>
        </Group>
      </div>
    </div>
  );
}
