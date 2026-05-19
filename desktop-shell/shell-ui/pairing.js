const { invoke } = window.__TAURI__.core;

const POLL_MS = 2000;

let activeSessionId = null;
let activeSessionStatus = null;
let pollTimer = null;

const viewPairing = document.getElementById('view-pairing');
const pairingUnavailable = document.getElementById('pairing-unavailable');
const pairingLanWarning = document.getElementById('pairing-lan-warning');
const pairingQr = document.getElementById('pairing-qr');
const pairingCode = document.getElementById('pairing-code');
const pairingStatus = document.getElementById('pairing-status');
const pairingClaimUrl = document.getElementById('pairing-claim-url');
const pairedDevices = document.getElementById('paired-devices');
const btnCopyCode = document.getElementById('btn-copy-code');
const btnCancelPairing = document.getElementById('btn-cancel-pairing');
const btnRefreshPaired = document.getElementById('btn-refresh-paired');
const btnBackPlayer = document.getElementById('btn-back-player');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function formatTimestamp(value) {
  if (!value) return '';
  const normalized = String(value).replace(' ', 'T') + (String(value).includes('T') ? '' : 'Z');
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function copyText(text, okMessage) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    pairingStatus.textContent = okMessage;
  } catch {
    pairingStatus.textContent = 'Copy failed';
  }
}

async function renderSession(session) {
  if (!session) return;
  activeSessionStatus = session.status;
  pairingCode.textContent = session.code || '--------';

  const lines = [`Status: ${session.status}`];
  if (session.device_name) lines.push(`Device: ${session.device_name}`);
  if (session.status === 'completed') lines.push('Pairing completed');
  else if (session.claimed_at) lines.push('Waiting for desktop to finish');
  else lines.push('Waiting for phone claim');
  pairingStatus.textContent = lines.join(' · ');

  const claimUrl = session.connect?.claim_url || '';
  pairingClaimUrl.textContent = claimUrl || 'LAN URL unavailable. Enable LAN access to scan from a phone.';
  pairingClaimUrl.href = claimUrl || '#';
  pairingClaimUrl.classList.toggle('disabled', !claimUrl);

  const missingLan = !session.connect?.presentable;
  pairingLanWarning.textContent = missingLan
    ? 'LAN access is not available from this runtime, so the QR only carries the pairing code payload.'
    : '';
  pairingLanWarning.classList.toggle('hidden', !missingLan);

  const qrText = session.connect?.qr_text || '';
  if (qrText) {
    try {
      pairingQr.src = await invoke('pairing_qr_data_url', { qrText });
      pairingQr.classList.remove('hidden');
    } catch {
      pairingQr.removeAttribute('src');
    }
  }
}

async function renderPairedDevices() {
  pairedDevices.innerHTML = '<div class="paired-empty">Loading…</div>';
  try {
    const data = await invoke('pairing_list_devices');
    const devices = data.devices || [];
    if (!devices.length) {
      pairedDevices.innerHTML = '<div class="paired-empty">No paired phones yet.</div>';
      return;
    }
    pairedDevices.innerHTML = devices.map((device) => `
      <div class="paired-device">
        <div>
          <div class="paired-device-name">${escapeHtml(device.name || 'Paired device')}</div>
          <div class="paired-device-meta">${escapeHtml(device.device_type || 'phone')} · ${escapeHtml((device.scopes || []).join(', ') || 'no scopes')}</div>
          <div class="paired-device-meta">Last used: ${escapeHtml(formatTimestamp(device.last_used_at) || 'Never')}</div>
        </div>
        <button type="button" class="btn btn-danger btn-inline paired-revoke" data-token-id="${escapeHtml(device.token_id)}">Revoke</button>
      </div>
    `).join('');

    pairedDevices.querySelectorAll('.paired-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tokenId = btn.getAttribute('data-token-id');
        if (!tokenId) return;
        btn.disabled = true;
        btn.textContent = 'Revoking…';
        try {
          await invoke('pairing_revoke_device', { tokenId });
          await renderPairedDevices();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Revoke';
          pairingStatus.textContent = String(err);
        }
      });
    });
  } catch (err) {
    pairedDevices.innerHTML = `<div class="paired-empty">${escapeHtml(String(err))}</div>`;
  }
}

function startPolling(sessionId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const data = await invoke('pairing_list_sessions');
      const sessions = data.sessions || [];
      const record = sessions.find((entry) => entry.session_id === sessionId);
      if (!record) return;
      await renderSession(record);
      if (record.status === 'completed' || record.status === 'cancelled') {
        stopPolling();
        if (record.status === 'completed') {
          pairingStatus.textContent = 'Phone paired successfully.';
          await renderPairedDevices();
        }
      }
    } catch (err) {
      pairingStatus.textContent = String(err);
    }
  }, POLL_MS);
}

async function closeActiveSession() {
  if (activeSessionId && activeSessionStatus && ['pending', 'claimed'].includes(activeSessionStatus)) {
    try {
      await invoke('pairing_display_close', { sessionId: activeSessionId });
    } catch {
      // Non-fatal when leaving the screen.
    }
  }
  stopPolling();
  activeSessionId = null;
  activeSessionStatus = null;
}

async function startPairingSession() {
  pairingUnavailable.classList.add('hidden');
  pairingStatus.textContent = 'Starting pairing session…';
  try {
    const session = await invoke('pairing_create_session');
    activeSessionId = session.session_id;
    activeSessionStatus = session.status;
    await renderSession(session);
    await renderPairedDevices();
    startPolling(session.session_id);
  } catch (err) {
    pairingUnavailable.textContent = String(err);
    pairingUnavailable.classList.remove('hidden');
    pairingStatus.textContent = '';
  }
}

async function openPairingView({ unavailable = false } = {}) {
  window.shellShowView?.('pairing');
  pairingUnavailable.classList.toggle('hidden', !unavailable);
  if (unavailable) {
    pairingStatus.textContent = '';
    await renderPairedDevices();
    return;
  }
  await startPairingSession();
}

btnCopyCode?.addEventListener('click', () => {
  copyText(pairingCode.textContent.replace(/-/g, '').trim(), 'Pairing code copied');
});

btnCancelPairing?.addEventListener('click', async () => {
  if (!activeSessionId) return;
  try {
    await invoke('pairing_cancel_session', { sessionId: activeSessionId });
    pairingStatus.textContent = 'Pairing session cancelled.';
  } catch (err) {
    pairingStatus.textContent = String(err);
  }
  await closeActiveSession();
});

btnRefreshPaired?.addEventListener('click', () => renderPairedDevices());

btnBackPlayer?.addEventListener('click', async () => {
  await closeActiveSession();
  try {
    await invoke('open_player');
  } catch (err) {
    pairingStatus.textContent = String(err);
  }
});

window.shellPairing = {
  open: openPairingView,
  close: closeActiveSession,
};
