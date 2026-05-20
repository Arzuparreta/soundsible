const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

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
  const el = typeof target === 'function' ? target() : target;
  if (el && typeof el.focus === 'function') {
    requestAnimationFrame(() => el.focus({ preventScroll: true }));
  }
}

window.shellShowView = showView;

function setContinueEnabled(enabled) {
  btnContinue.disabled = !enabled;
  btnContinue.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function renderLog(container, lines) {
  container.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    if (line.startsWith('error:')) div.classList.add('error');
    if (line.includes('ready') || line.includes('Starting')) div.classList.add('active');
    div.textContent = line;
    container.appendChild(div);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function refreshPreview(path) {
  try {
    const preview = await invoke('preview_music_folder', { path });
    scanPreview.textContent = `${preview.track_count.toLocaleString()} tracks · ${formatBytes(preview.size_bytes)} · scanned in ${(preview.scan_ms / 1000).toFixed(1)}s`;
    scanPreview.classList.remove('hidden');
  } catch {
    scanPreview.classList.add('hidden');
  }
}

async function applyStatus(status) {
  if (status.phase === 'booting') {
    showView('loading');
    renderLog(logLoading, status.log_lines.length ? status.log_lines : ['engine: starting…']);
    return;
  }
  if (status.phase === 'error') {
    showView('error');
    renderLog(logError, status.log_lines.length ? status.log_lines : ['error: engine failed']);
    return;
  }
  if (status.phase === 'ready') {
    return;
  }
  if (status.phase === 'idle') {
    showView('first-run');
  }
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
    // Non-fatal if autostart is unavailable on this platform build.
  }
}

btnChoose.addEventListener('click', async () => {
  try {
    const path = await invoke('pick_music_folder');
    if (!path) return;
    selectedPath = path;
    pathDisplay.textContent = path;
    pathDisplay.classList.add('filled');
    setContinueEnabled(true);
    await refreshPreview(path);
  } catch (err) {
    console.error('Folder picker failed:', err);
    pathDisplay.textContent = `Could not open folder picker: ${err}`;
    pathDisplay.classList.add('filled');
  }
});

btnContinue.addEventListener('click', async () => {
  if (!selectedPath) return;
  showView('loading');
  renderLog(logLoading, ['engine: binding loopback', `engine: music_dir=${selectedPath}`]);
  try {
    await applyAutostartPreference();
    await invoke('start_engine_with_path', { path: selectedPath });
  } catch (err) {
    showView('error');
    renderLog(logError, [`error: ${err}`]);
  }
});

btnRetry.addEventListener('click', async () => {
  showView('loading');
  try {
    await invoke('restart_engine');
  } catch (err) {
    showView('error');
    renderLog(logError, [`error: ${err}`]);
  }
});

btnLogs.addEventListener('click', () => invoke('open_logs'));

listen('engine-status', (event) => {
  applyStatus(event.payload);
});

listen('shell-view', (event) => {
  const view = event.payload;
  if (view === 'pairing') {
    window.shellPairing?.open();
  } else if (view === 'pairing-unavailable') {
    window.shellPairing?.open({ unavailable: true });
  }
});

async function resumeReturningUser() {
  const status = await invoke('get_engine_status');
  if (status.phase === 'ready') {
    return;
  }

  let profile;
  try {
    profile = await invoke('get_startup_profile');
  } catch {
    return;
  }

  if (!profile.auto_start || !profile.music_dir) {
    if (profile.returning_user && profile.music_dir) {
      selectedPath = profile.music_dir;
      pathDisplay.textContent = profile.music_dir;
      pathDisplay.classList.add('filled');
      setContinueEnabled(true);
    }
    return;
  }

  selectedPath = profile.music_dir;
  showView('loading');
  renderLog(logLoading, [
    'engine: resuming your library',
    `engine: music_dir=${profile.music_dir}`,
  ]);

  try {
    await invoke('start_configured_engine');
  } catch (err) {
    showView('error');
    renderLog(logError, [`error: ${err}`]);
  }
}

invoke('get_engine_status')
  .then(applyStatus)
  .then(syncAutostartCheckbox)
  .then(resumeReturningUser)
  .catch(() => {});
