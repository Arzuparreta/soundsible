import QRCode from 'qrcode';

import { store } from './store.js';
import { adminFetch, hasOwnerToken } from './admin_auth.js';

const POLL_MS = 2000;

class DesktopPairingController {
    constructor() {
        this._modalEl = null;
        this._pollTimer = null;
        this._activeSessionId = null;
        this._activeSessionStatus = null;
    }

    get _apiBase() {
        return store.apiBase;
    }

    async _fetchJson(path, options = {}) {
        const res = await adminFetch(`${this._apiBase}${path}`, options);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const message = data?.error || `Request failed (${res.status})`;
            throw new Error(message);
        }
        return data;
    }

    async fetchPairingSessions() {
        const data = await this._fetchJson('/api/pairing/sessions');
        return data.sessions || [];
    }

    async fetchPairedDevices() {
        const data = await this._fetchJson('/api/paired-devices');
        return data.devices || [];
    }

    async createPairingSession() {
        return this._fetchJson('/api/pairing/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ auto_confirm: true, display_active: true }),
        });
    }

    async setDisplayState(sessionId, active) {
        const endpoint = active ? 'display-open' : 'display-close';
        return this._fetchJson(`/api/pairing/sessions/${encodeURIComponent(sessionId)}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: active ? JSON.stringify({ auto_confirm: true }) : undefined,
        });
    }

    async cancelSession(sessionId) {
        return this._fetchJson(`/api/pairing/sessions/${encodeURIComponent(sessionId)}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
    }

    async revokePairedDevice(tokenId) {
        return this._fetchJson(`/api/paired-devices/${encodeURIComponent(tokenId)}/revoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
    }

    async renderPairedDevices(container, { showToast } = {}) {
        if (!container) return;
        container.innerHTML = '<div class="text-xs text-[var(--text-dim)] text-center py-3">Loading...</div>';
        try {
            const devices = await this.fetchPairedDevices();
            if (devices.length === 0) {
                container.innerHTML = '<div class="text-xs text-[var(--text-dim)] text-center py-3">No paired phones yet.</div>';
                return;
            }
            container.innerHTML = devices.map((device) => `
                <div class="rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--surface-overlay)] p-3 flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="text-sm font-semibold text-[var(--text-main)] truncate">${this._escapeHtml(device.name || 'Paired device')}</div>
                        <div class="text-xs text-[var(--text-dim)] mt-1">${this._escapeHtml(device.device_type || 'phone')} · ${this._escapeHtml((device.scopes || []).join(', ') || 'no scopes')}</div>
                        <div class="text-[11px] text-[var(--text-dim)] mt-1">Last used: ${this._formatTimestamp(device.last_used_at) || 'Never'}</div>
                    </div>
                    <button type="button" data-token-id="${this._escapeHtml(device.token_id)}" class="desktop-paired-revoke-btn shrink-0 px-3 py-2 rounded-[var(--radius-omni-xs)] text-xs font-bold bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors">Revoke</button>
                </div>
            `).join('');
            container.querySelectorAll('.desktop-paired-revoke-btn').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const tokenId = btn.getAttribute('data-token-id');
                    if (!tokenId) return;
                    btn.disabled = true;
                    btn.textContent = 'Revoking...';
                    try {
                        await this.revokePairedDevice(tokenId);
                        showToast?.('Paired device revoked');
                        await this.renderPairedDevices(container, { showToast });
                    } catch (error) {
                        btn.disabled = false;
                        btn.textContent = 'Revoke';
                        showToast?.(error.message || 'Could not revoke device');
                    }
                });
            });
        } catch (error) {
            container.innerHTML = `<div class="text-xs text-red-400 text-center py-3">${this._escapeHtml(error.message || 'Could not load paired devices')}</div>`;
        }
    }

    async openPairingModal({ showToast, onDevicesChanged } = {}) {
        if (this._modalEl) return;
        if (!hasOwnerToken()) {
            showToast?.('Owner token missing. Open the desktop player with ?owner_token=... or inject it from the shell.');
        }

        let session;
        try {
            session = await this.createPairingSession();
        } catch (error) {
            showToast?.(error.message || 'Could not start pairing');
            return;
        }

        this._activeSessionId = session.session_id;
        this._activeSessionStatus = session.status;

        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[290] flex items-center justify-center p-4';
        modal.style.background = 'rgba(6,8,12,0.78)';
        modal.innerHTML = `
            <div class="absolute inset-0" data-role="backdrop"></div>
            <div class="relative w-full max-w-xl rounded-[var(--radius-omni)] border border-[var(--glass-border)] bg-[var(--bg-card)] shadow-[0_20px_80px_rgba(0,0,0,0.55)] overflow-hidden">
                <div class="flex items-start justify-between gap-4 p-5 border-b border-[var(--glass-border)]">
                    <div class="min-w-0">
                        <p class="text-[10px] font-black uppercase tracking-[0.2em] text-[var(--accent)]">Pair phone</p>
                        <h2 class="text-lg font-bold text-[var(--text-main)] mt-1">Scan and connect</h2>
                        <p class="text-xs text-[var(--text-dim)] mt-1 leading-relaxed">This session stays auto-confirmable while the sheet is open.</p>
                    </div>
                    <button type="button" class="w-10 h-10 rounded-full border border-[var(--glass-border)] bg-[var(--surface-overlay)] text-[var(--text-dim)] hover:text-[var(--text-main)] transition-colors" data-role="close" aria-label="Close pairing dialog">
                        <i class="fas fa-xmark"></i>
                    </button>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-[240px,1fr] gap-5 p-5">
                    <div class="flex flex-col gap-3">
                        <div class="rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-white p-3 flex items-center justify-center min-h-[240px]">
                            <canvas data-role="qr-canvas" width="220" height="220" class="max-w-full h-auto"></canvas>
                        </div>
                        <div data-role="qr-warning" class="text-xs text-amber-400 hidden"></div>
                    </div>
                    <div class="min-w-0 space-y-4">
                        <div class="rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--surface-overlay)] p-4">
                            <div class="text-[10px] font-black uppercase tracking-widest text-[var(--text-dim)]">Pairing code</div>
                            <div data-role="pair-code" class="mt-2 text-2xl font-black tracking-[0.18em] text-[var(--text-main)]"></div>
                            <div data-role="session-status" class="mt-2 text-xs text-[var(--text-dim)]"></div>
                        </div>
                        <div class="rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--surface-overlay)] p-4">
                            <div class="text-[10px] font-black uppercase tracking-widest text-[var(--text-dim)] mb-2">Open on phone</div>
                            <a data-role="claim-url" href="#" target="_blank" rel="noopener" class="block text-sm text-[var(--accent)] break-all hover:underline"></a>
                            <div class="text-[11px] text-[var(--text-dim)] mt-2">If scanning is unavailable, open the link and enter the code manually.</div>
                        </div>
                        <div class="rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] bg-[var(--surface-overlay)] p-4">
                            <div class="flex items-center justify-between gap-3">
                                <div class="text-[10px] font-black uppercase tracking-widest text-[var(--text-dim)]">Diagnostics</div>
                                <button type="button" data-role="toggle-diagnostics" aria-expanded="false" class="text-xs font-bold text-[var(--accent)] hover:underline">Show</button>
                            </div>
                            <div data-role="diagnostics-panel" class="hidden mt-3 space-y-3">
                                <div class="text-[11px] text-[var(--text-dim)]">Raw QR payload for debugging and manual shell inspection.</div>
                                <div class="flex items-center justify-end">
                                    <button type="button" data-role="copy-qr" class="text-xs font-bold text-[var(--accent)] hover:underline">Copy payload</button>
                                </div>
                                <textarea data-role="qr-text" rows="4" class="input-theme w-full rounded-[var(--radius-omni-xs)] px-3 py-3 text-[var(--secondary)] font-mono text-[11px] focus:outline-none" readonly></textarea>
                            </div>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <button type="button" data-role="copy-code" class="px-4 py-3 rounded-[var(--radius-omni-xs)] text-sm font-bold bg-[var(--surface-overlay)] text-[var(--text-main)] border border-[var(--glass-border)] hover:bg-[var(--bg-card)] transition-colors">Copy code</button>
                            <button type="button" data-role="cancel-session" class="px-4 py-3 rounded-[var(--radius-omni-xs)] text-sm font-bold bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-colors">Cancel session</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        this._modalEl = modal;
        document.body.appendChild(modal);

        const closeButton = modal.querySelector('[data-role="close"]');
        const backdrop = modal.querySelector('[data-role="backdrop"]');
        const codeEl = modal.querySelector('[data-role="pair-code"]');
        const statusEl = modal.querySelector('[data-role="session-status"]');
        const claimLink = modal.querySelector('[data-role="claim-url"]');
        const qrTextEl = modal.querySelector('[data-role="qr-text"]');
        const qrCanvas = modal.querySelector('[data-role="qr-canvas"]');
        const qrWarning = modal.querySelector('[data-role="qr-warning"]');
        const diagnosticsPanel = modal.querySelector('[data-role="diagnostics-panel"]');
        const diagnosticsToggle = modal.querySelector('[data-role="toggle-diagnostics"]');

        const renderSession = async (record) => {
            if (!record) return;
            this._activeSessionStatus = record.status;
            if (codeEl) codeEl.textContent = record.code || '--------';
            if (statusEl) {
                const lines = [];
                lines.push(`Status: ${record.status}`);
                if (record.device_name) lines.push(`Device: ${record.device_name}`);
                if (record.completed_at) lines.push('Pairing completed');
                else if (record.claimed_at) lines.push('Waiting for desktop to finish');
                else lines.push('Waiting for phone claim');
                statusEl.textContent = lines.join(' · ');
            }
            const claimUrl = record.connect?.claim_url || '';
            if (claimLink) {
                claimLink.textContent = claimUrl || 'LAN URL unavailable. Enable LAN access to scan from a phone.';
                claimLink.href = claimUrl || '#';
                claimLink.classList.toggle('pointer-events-none', !claimUrl);
            }
            if (qrTextEl) qrTextEl.value = record.connect?.qr_text || '';
            if (qrWarning) {
                const missingLan = !record.connect?.presentable;
                qrWarning.textContent = missingLan
                    ? 'LAN access is not currently available from this runtime, so the QR can only carry the code payload.'
                    : '';
                qrWarning.classList.toggle('hidden', !missingLan);
            }
            if (qrCanvas && record.connect?.qr_text) {
                try {
                    await QRCode.toCanvas(qrCanvas, record.connect.qr_text, {
                        width: 220,
                        margin: 1,
                        errorCorrectionLevel: 'M',
                        color: {
                            dark: '#0b1220',
                            light: '#ffffff',
                        },
                    });
                } catch (error) {
                    console.error('QR render failed', error);
                }
            }
        };

        const copyText = async (text, okMessage) => {
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                showToast?.(okMessage);
            } catch (_) {
                showToast?.('Copy failed');
            }
        };

        modal.querySelector('[data-role="copy-code"]')?.addEventListener('click', () => copyText(session.code, 'Pairing code copied'));
        modal.querySelector('[data-role="copy-qr"]')?.addEventListener('click', () => copyText(session.connect?.qr_text || '', 'QR payload copied'));
        diagnosticsToggle?.addEventListener('click', () => {
            const expanded = diagnosticsToggle.getAttribute('aria-expanded') === 'true';
            diagnosticsToggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            diagnosticsToggle.textContent = expanded ? 'Show' : 'Hide';
            diagnosticsPanel?.classList.toggle('hidden', expanded);
        });
        modal.querySelector('[data-role="cancel-session"]')?.addEventListener('click', async () => {
            if (!this._activeSessionId) return;
            try {
                await this.cancelSession(this._activeSessionId);
                showToast?.('Pairing session cancelled');
            } catch (error) {
                showToast?.(error.message || 'Could not cancel pairing');
            }
            this._closeModal();
        });

        const closeModal = async () => {
            if (this._activeSessionId && this._activeSessionStatus && ['pending', 'claimed'].includes(this._activeSessionStatus)) {
                try {
                    await this.setDisplayState(this._activeSessionId, false);
                } catch (_) {}
            }
            this._closeModal();
        };

        closeButton?.addEventListener('click', closeModal);
        backdrop?.addEventListener('click', closeModal);

        await renderSession(session);
        this._startPolling({
            sessionId: session.session_id,
            onUpdate: async (record) => {
                await renderSession(record);
                if (record?.status === 'completed' || record?.status === 'cancelled') {
                    this._stopPolling();
                    if (record.status === 'completed') showToast?.('Phone paired');
                    onDevicesChanged?.();
                }
            },
            onError: (message) => showToast?.(message),
        });
    }

    _startPolling({ sessionId, onUpdate, onError }) {
        this._stopPolling();
        this._pollTimer = setInterval(async () => {
            try {
                const sessions = await this.fetchPairingSessions();
                const record = sessions.find((entry) => entry.session_id === sessionId);
                if (record) await onUpdate(record);
            } catch (error) {
                onError?.(error.message || 'Could not refresh pairing status');
            }
        }, POLL_MS);
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    _closeModal() {
        this._stopPolling();
        this._activeSessionId = null;
        this._activeSessionStatus = null;
        if (this._modalEl) {
            this._modalEl.remove();
            this._modalEl = null;
        }
    }

    bindDesktopSettings(selectors, { showToast, onDevicesChanged } = {}) {
        const openBtn = document.getElementById(selectors.openBtn);
        const pairedDevicesContainer = document.getElementById(selectors.pairedDevicesContainer);
        const refreshPairedBtn = document.getElementById(selectors.refreshPairedBtn);

        const reloadPairedDevices = async () => {
            await this.renderPairedDevices(pairedDevicesContainer, { showToast });
        };

        if (openBtn) {
            openBtn.addEventListener('click', async () => {
                await this.openPairingModal({
                    showToast,
                    onDevicesChanged: async () => {
                        await reloadPairedDevices();
                        onDevicesChanged?.();
                    },
                });
            });
        }
        if (refreshPairedBtn) {
            refreshPairedBtn.addEventListener('click', reloadPairedDevices);
        }
        reloadPairedDevices();
    }

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    _formatTimestamp(value) {
        if (!value) return '';
        const normalized = String(value).replace(' ', 'T') + (String(value).includes('T') ? '' : 'Z');
        const date = new Date(normalized);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
    }
}

export const desktopPairing = new DesktopPairingController();
