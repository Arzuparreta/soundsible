import { createSignal, onMount, For, Show, type JSX } from 'solid-js';
import { state, actions } from '../stores';
import { api } from '../lib/api';
import { t, locale, setLocale, LOCALES, type Locale } from '../lib/i18n';
import { toast } from '../lib/toast';
import { confirmDialog } from '../lib/confirm';
import { passwordDialog } from '../lib/passwordDialog';
import { promptDialog } from '../lib/prompt';
import { trackCount } from '../lib/format';
import { changePassword, isAdmin, logout, updateProfile, user } from '../lib/session';
import { associationUrl } from '../lib/trackShare';
import { communityConfig, loadCommunityConfig } from '../lib/community';
import { accessibleSections, findSectionById } from '../lib/settingsIndex';
import { DevicesPanel } from './DeviceSheet';
import { PairedDevicesPanel } from './PairDevice';
import { DisplayPreferences } from './DisplayPreferences';
import { LosslessUpgrades } from './LosslessUpgrades';
import {
  ActionRow,
  InputRow,
  NavRow,
  SegmentedRow,
  SelectRow,
  SettingRow,
  SettingsGroup,
  SwitchRow,
  ValueRow,
} from './SettingsRows';
import styles from './SettingsSections.module.css';

/**
 * Every setting in the product, sorted into eight self-contained submenus.
 * A section owns its own data: nothing is fetched until you open it, and the
 * index only ever needs the static descriptor above `content`.
 */
export interface SettingsSection {
  id: string;
  title: () => string;
  blurb: () => string;
  tone: 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  icon: () => JSX.Element;
  /** Admin-only sections act on the shared server, not on this account. */
  adminOnly?: boolean;
  /** Extra words the settings search should match — the labels living inside. */
  keywords: () => string[];
  content: () => JSX.Element;
}

const svg = (path: JSX.Element) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

/* ── Account ──────────────────────────────────────────────────────────── */

function AccountSection() {
  const editName = async () => {
    const me = user();
    if (!me) return;
    const name = await promptDialog({
      title: t('account.changeName'),
      inputLabel: t('account.name'),
      initial: me.display_name,
      confirmLabel: t('common.save'),
    });
    if (!name || name.trim() === me.display_name) return;
    try {
      await updateProfile({ display_name: name.trim() });
      toast.success(t('account.nameChanged'));
    } catch {
      toast.error(t('account.nameFailed'));
    }
  };

  const editUsername = async () => {
    const me = user();
    if (!me) return;
    const name = await promptDialog({
      title: t('account.changeUsername'),
      message: t('account.usernameHint'),
      inputLabel: t('account.username'),
      initial: me.username,
      confirmLabel: t('common.save'),
    });
    if (!name || name.trim() === me.username) return;
    try {
      await updateProfile({ username: name.trim() });
      toast.success(t('account.usernameChanged'));
    } catch {
      toast.error(t('account.usernameFailed'));
    }
  };

  const updatePassword = async () => {
    const me = user();
    if (!me) return;
    const current = me.has_password
      ? await promptDialog({
          title: t('account.changePassword'),
          inputLabel: t('account.currentPassword'),
          confirmLabel: t('common.continue'),
        })
      : '';
    if (current === null) return;
    const next = await passwordDialog({
      title: t('account.changePassword'),
      message: t('account.passwordHint'),
      confirmLabel: t('common.save'),
    });
    if (!next) return;
    try {
      await changePassword(current ?? '', next);
      toast.success(t('account.passwordChanged'));
    } catch {
      toast.error(t('account.passwordFailedHint'));
    }
  };

  const signOut = async () => {
    const ok = await confirmDialog({
      title: t('account.signOut'),
      message: t('account.signOutConfirm'),
      confirmLabel: t('account.signOut'),
    });
    if (ok) await logout();
  };

  return (
    <Show when={user()}>
      {(me) => (
        <>
          <div class={styles.identity}>
            <span
              class={styles.avatar}
              style={{ background: me().avatar_color ?? 'var(--accent)' }}
              aria-hidden="true"
            >
              {(me().display_name || me().username).trim().slice(0, 1)}
            </span>
            <span class={styles.identityText}>
              <span class={styles.identityName}>{me().display_name}</span>
              <span class={styles.identityHandle}>@{me().username}</span>
            </span>
          </div>

          <SettingsGroup label={t('settings.group.profile')} note={t('account.usernameHint')}>
            <ActionRow label={t('account.changeName')} onClick={editName} />
            <ActionRow label={t('account.changeUsername')} onClick={editUsername} />
            <ActionRow
              label={t('account.changePassword')}
              hint={me().has_password ? undefined : t('settings.note.noPassword')}
              onClick={updatePassword}
            />
          </SettingsGroup>

          <Show when={isAdmin()}>
            <SettingsGroup label={t('users.title')} note={t('settings.note.people')}>
              <NavRow href="/settings/users" label={t('account.manageUsers')} />
            </SettingsGroup>
          </Show>

          <SettingsGroup>
            <ActionRow label={t('account.signOut')} onClick={signOut} danger />
          </SettingsGroup>
        </>
      )}
    </Show>
  );
}

/* ── Appearance ───────────────────────────────────────────────────────── */

const THEMES = ['dark', 'system', 'light'] as const;

function themeIcon(theme: (typeof THEMES)[number]): JSX.Element {
  if (theme === 'dark') return svg(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />);
  if (theme === 'light')
    return svg(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>,
    );
  return svg(
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>,
  );
}

function themeLabel(theme: (typeof THEMES)[number]): string {
  if (theme === 'dark') return t('settings.themeDark');
  if (theme === 'light') return t('settings.themeLight');
  return t('settings.themeSystem');
}

function AppearanceSection() {
  return (
    <SettingsGroup label={t('settings.appearance')} note={t('settings.note.theme')}>
      <SegmentedRow
        label={t('settings.theme')}
        options={THEMES.map((theme) => ({
          value: theme,
          icon: themeIcon(theme),
          aria: themeLabel(theme),
        }))}
        value={state.theme as (typeof THEMES)[number]}
        onChange={(theme) => actions.setTheme(theme)}
      />
      <SelectRow
        label={t('settings.language')}
        value={locale()}
        onChange={(value) => setLocale(value as Locale)}
      >
        <For each={LOCALES}>{(l) => <option value={l.code}>{l.native}</option>}</For>
      </SelectRow>
    </SettingsGroup>
  );
}

/* ── Accessibility ────────────────────────────────────────────────────── */

function AccessibilitySection() {
  return (
    <>
      <SettingsGroup label={t('accessibility.title')} note={t('accessibility.intro')} plain>
        <DisplayPreferences />
      </SettingsGroup>
      <SettingsGroup label={t('settings.group.feedback')} note={t('settings.note.haptics')}>
        <SwitchRow
          label={t('settings.haptics')}
          checked={state.haptics}
          onChange={() => actions.setHaptics(!state.haptics)}
        />
      </SettingsGroup>
    </>
  );
}

/* ── Playback & recommendations ───────────────────────────────────────── */

function PlaybackSection() {
  const [learning, setLearning] = createSignal(true);
  const [autoplay, setAutoplay] = createSignal(state.playback.autoplayEnabled);
  const [leveling, setLeveling] = createSignal(state.playback.volumeLeveling);

  onMount(async () => {
    try {
      const d = await api.getDiscoverySettings();
      if (typeof d.learning_enabled === 'boolean') setLearning(d.learning_enabled);
      if (typeof d.autoplay_enabled === 'boolean') setAutoplay(d.autoplay_enabled);
      if (typeof d.volume_leveling === 'boolean') setLeveling(d.volume_leveling);
    } catch {
      /* keep the optimistic defaults */
    }
  });

  const toggleLeveling = async () => {
    const next = !leveling();
    setLeveling(next);
    if (!(await actions.setVolumeLeveling(next))) setLeveling(!next);
  };

  const toggleAutoplay = async () => {
    const next = !autoplay();
    setAutoplay(next);
    if (!(await actions.setAutoplayEnabled(next))) setAutoplay(!next);
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

  const resetLearning = async () => {
    const ok = await confirmDialog({
      title: t('settings.resetLearning'),
      message: t('settings.resetLearningConfirm'),
      confirmLabel: t('settings.resetLearning'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.resetDiscoveryProfile();
      toast.success(t('settings.resetLearningDone'));
    } catch {
      toast.error(t('settings.toast.notSaved'));
    }
  };

  return (
    <>
      <SettingsGroup label={t('settings.playback')} note={t('settings.note.volumeLeveling')}>
        <SwitchRow
          label={t('settings.volumeLeveling')}
          checked={leveling()}
          onChange={toggleLeveling}
        />
      </SettingsGroup>

      <SettingsGroup label={t('settings.group.upNext')} note={t('settings.note.autoplay')}>
        <SwitchRow label={t('settings.autoplay')} checked={autoplay()} onChange={toggleAutoplay} />
      </SettingsGroup>

      <SettingsGroup label={t('settings.group.recommendations')} note={t('settings.learnActivityNote')}>
        <SwitchRow label={t('settings.learnActivity')} checked={learning()} onChange={toggleLearning} />
        <ActionRow label={t('settings.resetLearning')} onClick={resetLearning} />
      </SettingsGroup>
    </>
  );
}

/* ── Library ──────────────────────────────────────────────────────────── */

function LibrarySection() {
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
    <>
      <SettingsGroup>
        <ValueRow label={t('settings.tracks')} value={String(state.library.length)} />
      </SettingsGroup>

      <SettingsGroup label={t('settings.group.sync')} note={t('settings.note.sync')}>
        <ActionRow label={t('settings.reload')} onClick={reload} disabled={busy()} />
        <ActionRow label={t('settings.rescan')} onClick={rescan} disabled={busy()} />
        <Show when={isAdmin()}>
          <ActionRow label={t('settings.sync')} onClick={cloudSync} />
        </Show>
      </SettingsGroup>

      <SettingsGroup label={t('settings.importCard')} note={t('settings.importNote')}>
        <NavRow href="/import" label={t('settings.importFrom')} />
      </SettingsGroup>

      <SettingsGroup label={t('settings.group.maintenance')} note={t('settings.note.maintenance')}>
        <Show when={isAdmin()}>
          <ActionRow label={t('settings.optimize')} onClick={optimize} />
        </Show>
        <ActionRow label={t('settings.purgeFiles')} onClick={purge} />
        <Show when={isAdmin()}>
          <ActionRow label={t('settings.emptyLibrary')} onClick={wipe} danger warn />
        </Show>
      </SettingsGroup>
    </>
  );
}

/* ── Downloads ────────────────────────────────────────────────────────── */

const QUALITY_OPTIONS = ['low', 'normal', 'high'] as const;

function qualityLabel(q: (typeof QUALITY_OPTIONS)[number]): string {
  if (q === 'low') return t('settings.qualityLow');
  if (q === 'normal') return t('settings.qualityNormal');
  return t('settings.qualityHigh');
}

function DownloadsSection() {
  const [quality, setQuality] = createSignal<(typeof QUALITY_OPTIONS)[number]>('high');
  const [autoUpdateYtdlp, setAutoUpdateYtdlp] = createSignal(false);
  const [autoUpdateCurlCffi, setAutoUpdateCurlCffi] = createSignal(false);

  onMount(async () => {
    try {
      const c = await api.getDownloaderConfig();
      if (c.quality) setQuality(c.quality as (typeof QUALITY_OPTIONS)[number]);
      if (typeof c.auto_update_ytdlp === 'boolean') setAutoUpdateYtdlp(c.auto_update_ytdlp);
      if (typeof c.auto_update_curl_cffi === 'boolean') setAutoUpdateCurlCffi(c.auto_update_curl_cffi);
    } catch {
      /* keep defaults */
    }
  });

  const changeQuality = async (q: (typeof QUALITY_OPTIONS)[number]) => {
    const previous = quality();
    setQuality(q);
    try {
      await api.setDownloaderConfig({ quality: q });
      toast.success(t('settings.toast.qualityUpdated'));
    } catch {
      setQuality(previous);
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const toggleAutoYtdlp = async () => {
    const next = !autoUpdateYtdlp();
    setAutoUpdateYtdlp(next);
    try {
      await api.setDownloaderConfig({ auto_update_ytdlp: next });
    } catch {
      setAutoUpdateYtdlp(!next);
      toast.error(t('settings.toast.notSaved'));
    }
  };

  const toggleAutoCurlCffi = async () => {
    const next = !autoUpdateCurlCffi();
    setAutoUpdateCurlCffi(next);
    try {
      await api.setDownloaderConfig({ auto_update_curl_cffi: next });
    } catch {
      setAutoUpdateCurlCffi(!next);
      toast.error(t('settings.toast.notSaved'));
    }
  };

  return (
    <>
      <SettingsGroup label={t('settings.quality')} note={t('settings.note.quality')}>
        <SegmentedRow
          label={t('settings.quality')}
          options={QUALITY_OPTIONS.map((q) => ({ value: q, label: qualityLabel(q) }))}
          value={quality()}
          onChange={changeQuality}
        />
      </SettingsGroup>

      <LosslessUpgrades />

      <SettingsGroup label={t('settings.group.updates')} note={t('settings.note.updates')}>
        <SwitchRow
          label={t('settings.autoUpdateYtdlp')}
          checked={autoUpdateYtdlp()}
          onChange={toggleAutoYtdlp}
        />
        <SwitchRow
          label={t('settings.autoUpdateCurlCffi')}
          checked={autoUpdateCurlCffi()}
          onChange={toggleAutoCurlCffi}
        />
      </SettingsGroup>
    </>
  );
}

/* ── Devices ──────────────────────────────────────────────────────────── */

function DevicesSection() {
  const sharedLinks = associationUrl();
  return (
    <>
      <SettingsGroup label={t('settings.group.thisDevice')} note={t('settings.note.device')}>
        <InputRow
          label={t('settings.deviceName')}
          value={state.device.device_name}
          onInput={(value) => actions.setDeviceName(value)}
        />
        <Show when={sharedLinks}>
          <ActionRow
            label={t('settings.openSharedLinks')}
            hint={t('settings.sharedLinks')}
            onClick={() => window.location.assign(sharedLinks!)}
          />
        </Show>
      </SettingsGroup>

      <SettingsGroup label={t('settings.pairedDevices')} note={t('settings.pairNote')}>
        <PairedDevicesPanel />
      </SettingsGroup>

      <SettingsGroup label={t('settings.group.network')} note={t('settings.note.network')}>
        <DevicesPanel />
      </SettingsGroup>
    </>
  );
}

/* ── Community ────────────────────────────────────────────────────────── */

function CommunitySection() {
  const [loading, setLoading] = createSignal(true);
  const refresh = async () => {
    setLoading(true);
    try {
      await loadCommunityConfig(true);
    } finally {
      setLoading(false);
    }
  };
  onMount(() => void refresh().catch(() => {}));

  const source = () => {
    const value = communityConfig();
    if (!value) return t('common.loading');
    return t(`settings.communitySource.${value.source}`);
  };
  const status = () => {
    const value = communityConfig();
    if (!value) return loading() ? t('common.loading') : t('settings.communityState.unavailable');
    return t(`settings.communityState.${value.state}`);
  };

  return (
    <SettingsGroup label={t('settings.community')} note={t('settings.note.community')}>
      <ValueRow label={t('settings.communityService')} value={source()} />
      <ValueRow label={t('settings.communityStatus')} value={status()} />
      <Show when={communityConfig()?.source === 'custom' && communityConfig()?.api_url}>
        <ValueRow
          label={t('settings.communityRelay')}
          value={<span class={styles.mono}>{communityConfig()!.api_url}</span>}
        />
      </Show>
      <Show when={!loading() && communityConfig()?.state === 'unavailable'}>
        <ActionRow label={t('common.retry')} onClick={refresh} />
      </Show>
    </SettingsGroup>
  );
}

/* ── About ────────────────────────────────────────────────────────────── */

function AboutSection() {
  return (
    <>
      <SettingsGroup label={t('settings.connection')}>
        <SettingRow label={t('settings.engineLabel')}>
          <span class={styles.status}>
            <span
              class={styles.statusDot}
              classList={{ [styles.statusOn]: state.online, [styles.statusOff]: !state.online }}
              aria-hidden="true"
            />
            {state.online ? t('common.online') : t('common.offline')}
          </span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('settings.about')}>
        <ValueRow
          label={t('brand.soundsible')}
          value={<span class={styles.mono}>{t('settings.version')}</span>}
        />
        <NavRow href="/preview" label={t('settings.viewDesign')} />
      </SettingsGroup>
    </>
  );
}

/* ── The registry ─────────────────────────────────────────────────────── */

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'account',
    title: () => t('account.title'),
    blurb: () => t('settings.blurb.account'),
    tone: 'accent',
    icon: () =>
      svg(
        <>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </>,
      ),
    keywords: () => [
      t('account.changeName'),
      t('account.changeUsername'),
      t('account.changePassword'),
      t('account.manageUsers'),
      t('account.signOut'),
      t('users.title'),
    ],
    content: () => <AccountSection />,
  },
  {
    id: 'appearance',
    title: () => t('settings.appearance'),
    blurb: () => t('settings.blurb.appearance'),
    tone: 'info',
    icon: () =>
      svg(
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" stroke="none" />
        </>,
      ),
    keywords: () => [
      t('settings.theme'),
      t('settings.themeDark'),
      t('settings.themeLight'),
      t('settings.themeSystem'),
      t('settings.language'),
    ],
    content: () => <AppearanceSection />,
  },
  {
    id: 'accessibility',
    title: () => t('accessibility.title'),
    blurb: () => t('settings.blurb.accessibility'),
    tone: 'success',
    icon: () =>
      svg(
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v.01M8.5 10.5h7M12 10.5V16M12 16l-1.8 2.5M12 16l1.8 2.5" />
        </>,
      ),
    keywords: () => [
      t('accessibility.interfaceSize'),
      t('accessibility.highContrast'),
      t('settings.haptics'),
    ],
    content: () => <AccessibilitySection />,
  },
  {
    id: 'playback',
    title: () => t('settings.playback'),
    blurb: () => t('settings.blurb.playback'),
    tone: 'accent',
    icon: () =>
      svg(
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M10 8.8l5.5 3.2-5.5 3.2z" />
        </>,
      ),
    keywords: () => [
      t('settings.volumeLeveling'),
      t('settings.volumeLevelingSearch'),
      t('settings.autoplay'),
      t('settings.learnActivity'),
      t('settings.resetLearning'),
      t('settings.discovery'),
    ],
    content: () => <PlaybackSection />,
  },
  {
    id: 'library',
    title: () => t('settings.libraryCard'),
    blurb: () => t('settings.blurb.library'),
    tone: 'warning',
    icon: () =>
      svg(
        <>
          <path d="M4 19V5a2 2 0 0 1 2-2h12v16" />
          <path d="M6 21h12M4 19a2 2 0 0 1 2-2h12" />
        </>,
      ),
    keywords: () => [
      t('settings.reload'),
      t('settings.rescan'),
      t('settings.purgeFiles'),
      t('settings.optimize'),
      t('settings.sync'),
      t('settings.importFrom'),
      t('settings.emptyLibrary'),
    ],
    content: () => <LibrarySection />,
  },
  {
    id: 'downloads',
    title: () => t('settings.downloads'),
    blurb: () => t('settings.blurb.downloads'),
    tone: 'info',
    adminOnly: true,
    icon: () => svg(<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" />),
    keywords: () => [
      t('settings.quality'),
      t('settings.losslessUpgrades'),
      t('settings.losslessStatusLabel'),
      t('settings.losslessRunNow'),
      t('settings.losslessRecheck'),
      t('settings.autoUpdateYtdlp'),
      t('settings.autoUpdateCurlCffi'),
    ],
    content: () => <DownloadsSection />,
  },
  {
    id: 'devices',
    title: () => t('settings.devices'),
    blurb: () => t('settings.blurb.devices'),
    tone: 'neutral',
    icon: () =>
      svg(
        <>
          <rect x="3" y="5" width="12" height="9" rx="1.5" />
          <path d="M2 18h11" />
          <rect x="16" y="9" width="6" height="11" rx="1.5" />
        </>,
      ),
    keywords: () => [
      t('settings.deviceName'),
      t('settings.pairedDevices'),
      t('settings.sharedLinks'),
      t('settings.openSharedLinks'),
    ],
    content: () => <DevicesSection />,
  },
  {
    id: 'community',
    title: () => t('settings.community'),
    blurb: () => t('settings.blurb.community'),
    tone: 'success',
    icon: () =>
      svg(
        <>
          <path d="M4 16.5a5.5 5.5 0 0 1 0-9M20 7.5a5.5 5.5 0 0 1 0 9" />
          <path d="M7.5 13.5a2.5 2.5 0 0 1 0-3M16.5 10.5a2.5 2.5 0 0 1 0 3" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
        </>,
      ),
    keywords: () => [
      t('settings.communityService'),
      t('settings.communityStatus'),
      t('settings.communityRelay'),
      'Live',
    ],
    content: () => <CommunitySection />,
  },
  {
    id: 'about',
    title: () => t('settings.about'),
    blurb: () => t('settings.blurb.about'),
    tone: 'neutral',
    icon: () =>
      svg(
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8v.01" />
        </>,
      ),
    keywords: () => [t('settings.engineLabel'), t('settings.version'), t('settings.viewDesign')],
    content: () => <AboutSection />,
  },
];

/** The index, grouped so the eight submenus read as three intentions. */
export const SETTINGS_GROUPS: { label: () => string; ids: string[] }[] = [
  { label: () => t('settings.group.you'), ids: ['account'] },
  { label: () => t('settings.group.preferences'), ids: ['appearance', 'accessibility', 'playback'] },
  { label: () => t('settings.group.system'), ids: ['library', 'downloads', 'devices', 'community', 'about'] },
];

/** Sections the signed-in account is actually allowed to open. */
export function visibleSections(): SettingsSection[] {
  return accessibleSections(SETTINGS_SECTIONS, isAdmin());
}

export function findSection(id: string | undefined): SettingsSection | undefined {
  return findSectionById(visibleSections(), id);
}
