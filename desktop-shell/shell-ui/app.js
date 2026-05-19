const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const pathDisplay = document.getElementById('path-display');
const scanPreview = document.getElementById('scan-preview');
const btnChoose = document.getElementById('btn-choose');
const btnContinue = document.getElementById('btn-continue');
const btnRetry = document.getElementById('btn-retry');
const btnLogs = document.getElementById('btn-logs');
const viewFirstRun = document.getElementById('view-first-run');
const viewLoading = document.getElementById('view-loading');
const viewError = document.getElementById('view-error');
const logLoading = document.getElementById('log-loading');
const logError = document.getElementById('log-error');

let selectedPath = null;

function showView(name) {
  viewFirstRun.classList.toggle('hidden', name !== 'first-run');
  viewLoading.classList.toggle('hidden', name !== 'loading');
  viewError.classList.toggle('hidden', name !== 'error');
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
}

btnChoose.addEventListener('click', async () => {
  const path = await invoke('pick_music_folder');
  if (!path) return;
  selectedPath = path;
  pathDisplay.textContent = path;
  pathDisplay.classList.add('filled');
  btnContinue.disabled = false;
  await refreshPreview(path);
});

btnContinue.addEventListener('click', async () => {
  if (!selectedPath) return;
  showView('loading');
  renderLog(logLoading, ['engine: binding loopback', `engine: music_dir=${selectedPath}`]);
  try {
    await invoke('start_engine');
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

invoke('get_engine_status').then(applyStatus).catch(() => {});
