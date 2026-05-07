/**
 * Remote Control: cross-device playback control (mobile <-> desktop).
 * Singleton with device list rendering + remote control modal.
 */
import { store } from './store.js';
import { getApiBase } from './config.js';
import { Resolver } from './resolver.js';

const POLL_INTERVAL_MS = 3000;

class RemoteControl {
    constructor() {
        this._modalEl = null;
        this._targetDeviceId = null;
        this._pollTimer = null;
    }

    get _apiBase() {
        return getApiBase(store.state.activeHost);
    }

    async fetchDevices() {
        try {
            const res = await fetch(`${this._apiBase}/api/devices`);
            if (!res.ok) return [];
            const data = await res.json();
            return data.devices || [];
        } catch (e) {
            console.error('Remote control: fetch devices failed', e);
            return [];
        }
    }

    async fetchDeviceState(deviceId) {
        try {
            const res = await fetch(`${this._apiBase}/api/playback/state?device_id=${encodeURIComponent(deviceId)}`);
            if (res.status === 204 || !res.ok) return null;
            return await res.json();
        } catch (e) {
            return null;
        }
    }

    async sendRemoteCommand(deviceId, command, positionSec) {
        try {
            const body = { device_id: deviceId, command };
            if (positionSec !== undefined) body.position_sec = positionSec;
            const res = await fetch(`${this._apiBase}/api/playback/remote-command`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return await res.json();
        } catch (e) {
            console.error('Remote command failed:', e);
            return { error: String(e) };
        }
    }

    /**
     * Create a "Play on device" device-picker modal.
     * @param {Array} others - Array of device objects (excluding self)
     * @param {{ id: string, title: string }} track - Track to send
     * @param {object} store - Store instance
     * @param {Function} showToast - Toast function
     * @returns {HTMLElement}
     */
    createDevicePickerModal(others, track, store, showToast) {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:1280;display:flex;align-items:center;justify-content:center;padding:16px;background-color:rgba(0,0,0,0.65);';
        modal.setAttribute('aria-label', 'Play on device picker');

        const sheet = document.createElement('div');
        sheet.style.cssText = [
            'background:var(--bg-card, #1a1a1f)',
            'border:1px solid var(--glass-border, rgba(255,255,255,0.08))',
            'border-radius:var(--radius-omni, 24px)',
            'box-shadow:0 20px 60px rgba(0,0,0,0.5)',
            'width:100%',
            'max-width:320px',
            'overflow:hidden',
            'position:relative'
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'padding:16px;border-bottom:1px solid var(--glass-border, rgba(255,255,255,0.08));';
        header.innerHTML = '<h3 style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-dim, #999);margin:0">Play on device</h3>';
        sheet.appendChild(header);

        const list = document.createElement('div');
        list.style.cssText = 'max-height:256px;overflow-y:auto;padding:8px';
        for (const d of others) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.style.cssText = [
                'width:100%',
                'display:flex',
                'align-items:center',
                'gap:12px',
                'padding:12px',
                'border-radius:12px',
                'border:none',
                'background:transparent',
                'color:var(--text-main, #eee)',
                'font:inherit',
                'text-align:left',
                'cursor:pointer',
                'transition:background 0.15s'
            ].join(';');
            btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--surface-overlay, rgba(255,255,255,0.06))'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });

            const icon = d.device_type === 'mobile' ? 'fa-mobile-screen-button' : 'fa-desktop';
            const label = d.device_type === 'mobile' ? 'Phone' : 'Desktop';
            const isOnline = d.socket_connected || d.active_sid;
            const name = this._escapeHtml(d.device_name || label);

            btn.innerHTML = [
                `<span style="width:32px;height:32px;border-radius:50%;background:var(--surface-overlay, rgba(255,255,255,0.06));border:1px solid var(--glass-border, rgba(255,255,255,0.08));display:flex;align-items:center;justify-content:center;flex-shrink:0">`,
                `<i class="fas ${icon}" style="color:var(--secondary, #aaa);font-size:12px"></i>`,
                `</span>`,
                `<span style="flex:1;min-width:0">`,
                `<span style="display:block;font-size:13px;font-weight:600;color:var(--text-main, #eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>`,
                `<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim, #999);margin-top:2px">`,
                `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${isOnline ? '#22c55e' : 'rgba(239,68,68,0.6)'};flex-shrink:0;box-shadow:${isOnline ? '0 0 6px rgba(34,197,94,0.7)' : 'none'}"></span>`,
                `${isOnline ? 'Online' : 'Offline'}`,
                ` · ${label}`,
                `</span></span>`,
                `<i class="fas fa-chevron-right" style="color:var(--text-dim, #999);font-size:11px;flex-shrink:0"></i>`
            ].join('');

            btn.addEventListener('click', () => {
                modal.remove();
                if (track && track.id) {
                    fetch(`${this._apiBase}/api/playback/remote-command`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ device_id: d.device_id, command: 'play', track_id: track.id })
                    }).catch(() => {});
                    showToast?.('Sent to device');
                }
            });
            list.appendChild(btn);
        }
        sheet.appendChild(list);

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = [
            'width:100%',
            'padding:12px',
            'border:none',
            'border-top:1px solid var(--glass-border, rgba(255,255,255,0.08))',
            'background:transparent',
            'color:var(--text-dim, #999)',
            'font-size:13px',
            'font-weight:600',
            'cursor:pointer',
            'transition:background 0.15s'
        ].join(';');
        cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'var(--surface-overlay, rgba(255,255,255,0.06))'; });
        cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
        cancelBtn.addEventListener('click', () => modal.remove());
        sheet.appendChild(cancelBtn);

        modal.appendChild(sheet);
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

        return modal;
    }

    async generateAgentToken() {
        try {
            const res = await fetch(`${this._apiBase}/api/agent/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                return { error: data.error || 'Admin token required' };
            }
            return await res.json();
        } catch (e) {
            return { error: String(e) };
        }
    }

    _deviceIcon(type) {
        if (type === 'mobile') return 'fa-mobile-screen-button';
        if (type === 'agent') return 'fa-robot';
        return 'fa-desktop';
    }

    _deviceLabel(type) {
        if (type === 'mobile') return 'Phone';
        if (type === 'agent') return 'Agent';
        return 'Desktop';
    }

    /** Render device list inside a container element. Returns a cleanup fn. */
    async renderDeviceList(container) {
        if (!container) return () => {};
        const currentDeviceId = store.getDeviceId();
        const devices = await this.fetchDevices();
        const others = devices.filter(d => d.device_id !== currentDeviceId);

        if (others.length === 0) {
            container.innerHTML = `
                <div class="text-xs text-[var(--text-dim)] text-center py-3">
                    No other devices connected. Open Soundsible on another device on the same network.
                </div>`;
            return () => {};
        }

        let html = '';
        for (const d of others) {
            const icon = this._deviceIcon(d.device_type);
            const label = this._deviceLabel(d.device_type);
            const isOnline = d.socket_connected || d.active_sid;
            const statusDot = isOnline
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)] flex-shrink-0"></span>'
                : '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500/60 flex-shrink-0"></span>';
            const statusText = isOnline ? 'Online' : 'Offline';
            const deviceIdEscaped = d.device_id.replace(/'/g, "\\'");
            const nameEscaped = (d.device_name || label).replace(/'/g, "\\'");

            html += `
                <button type="button"
                    class="w-full flex items-center gap-3 p-3 rounded-[var(--radius-omni-xs)] hover:bg-[var(--surface-overlay)] active:bg-[var(--bg-card)] transition-colors text-left border border-[var(--glass-border)] mb-2"
                    onclick="window._remoteControl.openDevice('${deviceIdEscaped}', '${nameEscaped}')">
                    <div class="w-9 h-9 rounded-full bg-[var(--surface-overlay)] border border-[var(--glass-border)] flex items-center justify-center flex-shrink-0">
                        <i class="fas ${icon} text-[var(--secondary)] text-sm"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="text-sm font-semibold text-[var(--text-main)] truncate">${this._escapeHtml(d.device_name || label)}</div>
                        <div class="text-xs text-[var(--text-dim)] flex items-center gap-1.5 mt-0.5">
                            ${statusDot}<span>${statusText}</span><span class="opacity-50">${label}</span>
                        </div>
                    </div>
                    <i class="fas fa-chevron-right text-[var(--text-dim)] text-xs flex-shrink-0"></i>
                </button>`;
        }
        container.innerHTML = html;

        // Click handler cleanup
        const cleanup = () => {
            window._remoteControl = null;
        };
        return cleanup;
    }

    _escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    _ensureModal() {
        if (this._modalEl) return this._modalEl;

        const modal = document.createElement('div');
        modal.id = 'remote-control-modal';
        modal.className = 'fixed inset-0 z-[270] hidden flex items-center justify-center p-4 touch-none';
        modal.style.backgroundColor = 'var(--overlay-bg)';
        modal.innerHTML = `
            <div id="remote-control-backdrop" class="absolute inset-0" style="backdrop-filter: blur(4px);"></div>
            <div class="glass-view rounded-[var(--radius-omni)] border border-[var(--glass-border)] shadow-2xl w-full max-w-sm overflow-hidden relative">
                <div class="p-4 border-b border-[var(--glass-border)] flex items-center justify-between">
                    <h3 id="rc-device-name" class="text-sm font-black uppercase tracking-widest text-[var(--text-main)]">Device</h3>
                    <button type="button" id="rc-close-btn" class="w-8 h-8 rounded-full hover:bg-[var(--surface-overlay)] flex items-center justify-center text-[var(--text-dim)]"><i class="fas fa-times"></i></button>
                </div>
                <div id="rc-now-playing" class="p-4 border-b border-[var(--glass-border)] hidden">
                    <div class="flex items-start gap-4">
                        <div id="rc-cover" class="w-16 h-16 rounded-[var(--radius-omni-xs)] bg-cover bg-center flex-shrink-0 bg-[var(--bg-card)] border border-[var(--glass-border)]"></div>
                        <div class="flex-1 min-w-0">
                            <div id="rc-track-title" class="text-sm font-bold text-[var(--text-main)] truncate">—</div>
                            <div id="rc-track-artist" class="text-xs text-[var(--text-dim)] truncate mt-0.5">—</div>
                            <div id="rc-track-progress" class="text-[10px] font-mono text-[var(--secondary)] mt-1">0:00</div>
                        </div>
                    </div>
                </div>
                <div id="rc-no-playback" class="p-6 text-center text-sm text-[var(--text-dim)] hidden">
                    <i class="fas fa-music text-3xl opacity-30 mb-3 block"></i>
                    Nothing playing on this device
                </div>
                <div class="flex items-stretch">
                    <button type="button" id="rc-play-btn" class="flex-1 flex items-center justify-center gap-2 py-4 text-sm font-bold text-[var(--text-main)] hover:bg-[var(--surface-overlay)] active:bg-[var(--bg-card)] transition-colors border-r border-[var(--glass-border)]">
                        <i class="fas fa-play text-[var(--accent)]"></i><span id="rc-play-label">Play</span>
                    </button>
                    <button type="button" id="rc-next-btn" class="flex-1 flex items-center justify-center gap-2 py-4 text-sm font-bold text-[var(--text-main)] hover:bg-[var(--surface-overlay)] active:bg-[var(--bg-card)] transition-colors">
                        <i class="fas fa-forward text-[var(--secondary)]"></i><span>Next</span>
                    </button>
                </div>
            </div>`;

        document.body.appendChild(modal);

        document.getElementById('rc-close-btn').addEventListener('click', () => this.hideModal());
        document.getElementById('remote-control-backdrop').addEventListener('click', () => this.hideModal());

        document.getElementById('rc-play-btn').addEventListener('click', () => {
            if (!this._targetDeviceId) return;
            const currentIsPlaying = this._lastState?.is_playing;
            if (currentIsPlaying) {
                this.sendRemoteCommand(this._targetDeviceId, 'pause');
            } else {
                this.sendRemoteCommand(this._targetDeviceId, 'play');
            }
        });

        document.getElementById('rc-next-btn').addEventListener('click', () => {
            if (!this._targetDeviceId) return;
            this.sendRemoteCommand(this._targetDeviceId, 'next');
        });

        this._modalEl = modal;
        return modal;
    }

    openDevice(deviceId, deviceName) {
        this._targetDeviceId = deviceId;
        this._lastState = null;

        const modal = this._ensureModal();
        modal.querySelector('#rc-device-name').textContent = deviceName || 'Device';
        modal.classList.remove('hidden');
        modal.classList.add('flex');

        this._refresh();
        this._startPolling();
    }

    hideModal() {
        if (this._modalEl) {
            this._modalEl.classList.add('hidden');
            this._modalEl.classList.remove('flex');
        }
        this._stopPolling();
        this._targetDeviceId = null;
    }

    _startPolling() {
        this._stopPolling();
        if (this._targetDeviceId) {
            this._pollTimer = setInterval(() => this._refresh(), POLL_INTERVAL_MS);
        }
    }

    _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
    }

    async _refresh() {
        if (!this._targetDeviceId || !this._modalEl || this._modalEl.classList.contains('hidden')) return;

        const state = await this.fetchDeviceState(this._targetDeviceId);
        this._lastState = state;

        const np = this._modalEl.querySelector('#rc-now-playing');
        const noPlayback = this._modalEl.querySelector('#rc-no-playback');
        const playBtn = this._modalEl.querySelector('#rc-play-btn');
        const playLabel = this._modalEl.querySelector('#rc-play-label');
        const playIcon = playBtn?.querySelector('i');

        if (!state || !state.track_id) {
            if (np) np.classList.add('hidden');
            if (noPlayback) noPlayback.classList.remove('hidden');
            if (playLabel) playLabel.textContent = 'Play';
            if (playIcon) { playIcon.className = 'fas fa-play text-[var(--accent)]'; }
            if (noPlayback) noPlayback.closest('.flex').querySelector('.flex.items-stretch').classList.add('opacity-50', 'pointer-events-none');
            return;
        }

        if (np) np.classList.remove('hidden');
        if (noPlayback) noPlayback.classList.add('hidden');
        noPlayback?.closest('.flex').querySelector('.flex.items-stretch')?.classList.remove('opacity-50', 'pointer-events-none');

        this._modalEl.querySelector('#rc-track-title').textContent = state.track?.title || 'Unknown Track';
        this._modalEl.querySelector('#rc-track-artist').textContent = state.track?.artist || 'Unknown Artist';

        const pos = Math.max(0, state.position_sec || 0);
        const mins = Math.floor(pos / 60);
        const secs = Math.floor(pos % 60);
        this._modalEl.querySelector('#rc-track-progress').textContent = `${mins}:${String(secs).padStart(2, '0')}`;

        const cover = this._modalEl.querySelector('#rc-cover');
        if (state.track?.id) {
            const track = store.state.library.find(t => t.id === state.track.id) || null;
            const coverUrl = track ? Resolver.getCoverUrl(track) : null;
            if (coverUrl) cover.style.backgroundImage = `url("${String(coverUrl).replace(/"/g, '%22')}")`;
            else cover.style.backgroundImage = '';
        } else {
            cover.style.backgroundImage = '';
        }

        const isPlaying = state.is_playing;
        if (playLabel) playLabel.textContent = isPlaying ? 'Pause' : 'Play';
        if (playIcon) {
            playIcon.className = isPlaying
                ? 'fas fa-pause text-[var(--accent)]'
                : 'fas fa-play text-[var(--accent)]';
        }
    }
}

export const remoteControl = new RemoteControl();

window._remoteControl = remoteControl;
