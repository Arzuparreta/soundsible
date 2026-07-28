import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { applyStaticTranslations, locale, t } from './l10n.js';
import {
  createScanGeneration,
  errorText,
  folderPathFromDialogResult,
  formatBytes,
} from './onboarding.js';

applyStaticTranslations();

const pathDisplay = document.getElementById('path-display');
const scanPreview = document.getElementById('scan-preview');
const btnChoose = document.getElementById('btn-choose');
const btnContinue = document.getElementById('btn-continue');
const btnRetry = document.getElementById('btn-retry');
const btnLogs = document.getElementById('btn-logs');
const chkAutostart = document.getElementById('chk-autostart');
const viewFirstRun = document.getElementById('view-first-run');
const viewLoading = document.getElementById('view-loading');
const viewError = document.getElementById('view-error');
const viewPairing = document.getElementById('view-pairing');
const logLoading = document.getElementById('log-loading');
const logError = document.getElementById('log-error');

let selectedPath = null;
const scans = createScanGeneration();

const focusTargets = {
  'first-run': btnChoose,
  loading: () => viewLoading.querySelector('h2'),
  error: btnRetry,
  pairing: () => viewPairing?.querySelector('h1'),
};

function showView(name) {
  viewFirstRun.classList.toggle('hidden', name !== 'first-run');
  viewLoading.classList.toggle('hidden', name !== 'loading');
  viewError.classList.toggle('hidden', name !== 'error');
  if (viewPairing) viewPairing.classList.toggle('hidden', name !== 'pairing');
  document.getElementById('app').dataset.view = name;

  const target = focusTargets[name];
  const element = typeof target === 'function' ? target() : target;
  if (element && typeof element.focus === 'function') {
    requestAnimationFrame(() => element.focus({ preventScroll: true }));
  }
}

window.shellShowView = showView;

function setContinueEnabled(enabled) {
  btnContinue.disabled = !enabled;
  btnContinue.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function setSelectionState(state, message) {
  pathDisplay.dataset.state = state;
  pathDisplay.textContent = message;
  pathDisplay.classList.toggle('filled', state !== 'empty');
  pathDisplay.classList.toggle('error', state === 'error');
  pathDisplay.setAttribute('aria-busy', state === 'opening' || state === 'scanning' ? 'true' : 'false');
}

function renderLog(container, lines) {
  container.replaceChildren();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    if (line.startsWith('error:')) div.classList.add('error');
    if (line.includes('ready') || line.includes('Starting')) div.classList.add('active');
    div.textContent = line;
    container.appendChild(div);
  }
}

async function writeShellLog(level, message) {
  try {
    await invoke('log_shell_event', { level, message });
  } catch {
    // Diagnostics must never turn a recoverable UI error into a second error.
  }
}

async function refreshPreview(path) {
  const generation = scans.next();
  setContinueEnabled(false);
  setSelectionState('scanning', t('scanning'));
  scanPreview.classList.add('hidden');
  try {
    const preview = await invoke('preview_music_folder', { path });
    if (!scans.isCurrent(generation)) return false;
    selectedPath = preview.path;
    setSelectionState('ready', preview.path);
    const skipped = preview.inaccessible_entries
      ? t('skipped', { count: preview.inaccessible_entries.toLocaleString(locale()) })
      : '';
    scanPreview.textContent = t('tracks', {
      count: preview.track_count.toLocaleString(locale()),
      size: formatBytes(preview.size_bytes, locale()),
      seconds: (preview.scan_ms / 1000).toLocaleString(locale(), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    }) + skipped;
    scanPreview.classList.remove('hidden');
    setContinueEnabled(true);
    return true;
  } catch (error) {
    if (!scans.isCurrent(generation)) return false;
    selectedPath = null;
    setSelectionState('error', t('scanFailed'));
    await writeShellLog('error', `folder scan failed: ${errorText(error)}`);
    return false;
  }
}

async function applyStatus(status) {
  if (status.phase === 'booting') {
    showView('loading');
    renderLog(logLoading, status.log_lines.length ? status.log_lines : [t('engineStarting')]);
    return;
  }
  if (status.phase === 'error') {
    showView('error');
    renderLog(logError, status.log_lines.length ? status.log_lines : ['error: engine failed']);
    return;
  }
  if (status.phase === 'idle') showView('first-run');
}

async function syncAutostartCheckbox() {
  try {
    chkAutostart.checked = await invoke('get_autostart');
  } catch {
    chkAutostart.checked = false;
  }
}

async function applyAutostartPreference() {
  try {
    await invoke('set_autostart', { enabled: chkAutostart.checked });
  } catch {
    // Autostart is non-fatal on restricted Windows installations.
  }
}

btnChoose.addEventListener('click', async () => {
  scans.cancel();
  selectedPath = null;
  setContinueEnabled(false);
  btnChoose.disabled = true;
  setSelectionState('opening', t('openingPicker'));
  try {
    const result = await open({
      directory: true,
      multiple: false,
      title: t('dialogTitle'),
    });
    const path = folderPathFromDialogResult(result);
    if (!path) {
      setSelectionState('empty', t('noFolder'));
      return;
    }
    await refreshPreview(path);
  } catch (error) {
    setSelectionState('error', t('pickerFailed'));
    await writeShellLog('error', `folder picker failed: ${errorText(error)}`);
  } finally {
    btnChoose.disabled = false;
  }
});

btnContinue.addEventListener('click', async () => {
  if (!selectedPath) return;
  showView('loading');
  renderLog(logLoading, [t('engineStarting'), `engine: music_dir=${selectedPath}`]);
  try {
    await applyAutostartPreference();
    await invoke('start_engine_with_path', { path: selectedPath });
  } catch (error) {
    showView('error');
    renderLog(logError, [`error: ${errorText(error)}`]);
    await writeShellLog('error', `engine start failed: ${errorText(error)}`);
  }
});

btnRetry.addEventListener('click', async () => {
  showView('loading');
  try {
    await invoke('restart_engine');
  } catch (error) {
    showView('error');
    renderLog(logError, [`error: ${errorText(error)}`]);
  }
});

btnLogs.addEventListener('click', () => invoke('open_logs'));

listen('engine-status', (event) => applyStatus(event.payload));
listen('shell-view', (event) => {
  if (event.payload === 'pairing') window.shellPairing?.open();
  if (event.payload === 'pairing-unavailable') window.shellPairing?.open({ unavailable: true });
});

async function resumeReturningUser() {
  const status = await invoke('get_engine_status');
  if (status.phase === 'ready') return;

  let profile;
  try {
    profile = await invoke('get_startup_profile');
  } catch {
    return;
  }

  if (profile.configured_but_missing) {
    setSelectionState('error', t('configuredMissing'));
    return;
  }
  if (!profile.auto_start || !profile.music_dir) {
    if (profile.returning_user && profile.music_dir) {
      selectedPath = profile.music_dir;
      setSelectionState('ready', profile.music_dir);
      setContinueEnabled(true);
    }
    return;
  }

  selectedPath = profile.music_dir;
  showView('loading');
  renderLog(logLoading, [t('engineResuming'), `engine: music_dir=${profile.music_dir}`]);
  try {
    await invoke('start_configured_engine');
  } catch (error) {
    showView('error');
    renderLog(logError, [`error: ${errorText(error)}`]);
  }
}

invoke('get_engine_status')
  .then(applyStatus)
  .then(syncAutostartCheckbox)
  .then(resumeReturningUser)
  .catch((error) => writeShellLog('error', `shell initialization failed: ${errorText(error)}`));
