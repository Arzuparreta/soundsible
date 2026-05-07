/**
 * Shared wiring: attach behaviour to DOM (settings, action menu, remote control).
 * Both mobile (app.js / ui.js) and desktop (app_desktop.js) call these with their own selectors.
 */

import { getYouTubeWatchUrlForTrack, shareYouTubeTrack, showLoadingToast } from './shared.js';
import {
    isDeezerSurfaceActionTrack,
    hydrateDeezerVirtualTrack,
    actionMenuToggleQueueDeezer,
    actionMenuShareDeezer,
    actionMenuAddToPlaylistDeezer
} from './deezer_actions.js';
import { radioService } from './radio.js';
import { remoteControl } from './remote_control.js';

function getElement(root, selector) {
    if (!selector) return null;
    const r = root || document;
    const doc = r.nodeType === 9 ? r : (r.ownerDocument || document);
    if (typeof selector === 'string') {
        if (selector.startsWith('#')) return (r.nodeType === 9 ? r : r).querySelector(selector);
        return doc.getElementById(selector);
    }
    return selector;
}

/**
 * Wire settings panel: token import, library order, theme, haptics, status display.
 * @param {Object} selectors - { root?, tokenInput, importBtn, libraryOrderSelect?, themeSelect?, appIconSelect?, hapticsToggle?, themeIndicator?, hapticsIndicator?, statusLed?, statusPulse?, serverStatus?, hostDisplay? }
 * @param {Object} deps - { store, showToast, onLibraryOrderChange?, subscribeIndicators? }
 *   subscribeIndicators: if false, do not subscribe to store for theme/status (caller e.g. UI owns updates).
 */
export function wireSettings(selectors, deps) {
    const { store, showToast, onLibraryOrderChange, subscribeIndicators = true } = deps;
    const root = selectors.root || document;

    const tokenInput = getElement(root, selectors.tokenInput);
    const importBtn = getElement(root, selectors.importBtn);
    if (importBtn && tokenInput) {
        importBtn.addEventListener('click', () => {
            const token = tokenInput.value.trim();
            if (!token) {
                showToast?.('Paste a token first');
                return;
            }
            try {
                if (store.importToken(token)) {
                    showToast?.('Token imported');
                    tokenInput.value = '';
                } else {
                    showToast?.('Import failed');
                }
            } catch (e) {
                showToast?.('Import failed');
            }
        });
    }

    const libraryOrderSelect = getElement(root, selectors.libraryOrderSelect);
    if (libraryOrderSelect) {
        libraryOrderSelect.value = store.state.libraryOrder || 'date_added';
        libraryOrderSelect.addEventListener('change', () => {
            const value = libraryOrderSelect.value;
            if (value && ['date_added', 'alphabetical', 'favorites_first'].includes(value)) {
                store.update({ libraryOrder: value });
                onLibraryOrderChange?.();
            }
        });
    }

    const themeSelect = getElement(root, selectors.themeSelect);
    const appIconSelect = getElement(root, selectors.appIconSelect);
    const themeIndicator = getElement(root, selectors.themeIndicator);
    const hapticsIndicator = getElement(root, selectors.hapticsIndicator);
    const statusLed = getElement(root, selectors.statusLed);
    const statusPulse = getElement(root, selectors.statusPulse);
    const serverStatus = getElement(root, selectors.serverStatus);
    const hostDisplay = getElement(root, selectors.hostDisplay);

    if (themeSelect) {
        themeSelect.value = store.state.theme;
        themeSelect.addEventListener('change', () => {
            const value = themeSelect.value;
            if (value && ['dark', 'light', 'odst'].includes(value)) store.setTheme(value);
        });
    }
    if (appIconSelect) {
        appIconSelect.value = store.state.appIcon || 'default';
        appIconSelect.addEventListener('change', () => {
            const value = appIconSelect.value;
            if (value && ['default', 'alt'].includes(value)) {
                store.setAppIcon(value);
                const link = document.getElementById('app-manifest-link');
                if (link) link.href = value === 'alt' ? 'manifest-alt.json' : 'manifest.json';
            }
        });
    }

    const updateIndicators = (state) => {
        if (themeSelect) themeSelect.value = state.theme;
        if (appIconSelect) appIconSelect.value = state.appIcon || 'default';
        else if (themeIndicator) {
            themeIndicator.style.transform = (state.theme === 'light') ? 'translateX(28px)' : 'translateX(0)';
        }
        if (hapticsIndicator) {
            hapticsIndicator.style.transform = state.hapticsEnabled ? 'translateX(28px)' : 'translateX(0)';
        }
        if (hostDisplay) hostDisplay.textContent = state.activeHost || '';
        const isOnline = state.isOnline;
        if (statusLed) {
            const ledClass = isOnline ? 'bg-green-500' : 'bg-red-500';
            statusLed.className = `relative w-2 h-2 rounded-full ${ledClass} shadow-[0_0_12px_rgba(${isOnline ? '34,197,94' : '239,68,68'},0.8)]`;
            if (statusPulse) statusPulse.className = `absolute inset-0 w-2 h-2 rounded-full ${ledClass} status-pulse`;
        }
        if (serverStatus) {
            const textClass = isOnline ? 'text-green-500' : 'text-red-500';
            serverStatus.textContent = isOnline ? 'Connected' : 'Offline';
            serverStatus.className = `text-sm font-bold ${textClass}`;
        }
    };
    if (subscribeIndicators) {
        updateIndicators(store.state);
        store.subscribe(updateIndicators);
    }

    const ytdlpAutoUpdate = getElement(root, selectors.ytdlpAutoUpdate);
    if (ytdlpAutoUpdate) {
        const getApiBase = () => store.apiBase || '';
        fetch(`${getApiBase()}/api/downloader/config`)
            .then((r) => r.json())
            .then((c) => {
                ytdlpAutoUpdate.checked = c.auto_update_ytdlp === true;
            })
            .catch(() => {});
        ytdlpAutoUpdate.addEventListener('change', () => {
            fetch(`${getApiBase()}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_update_ytdlp: ytdlpAutoUpdate.checked }),
            })
                .then((r) => (r.ok ? showToast?.('Setting saved') : null))
                .catch(() => {});
        });
    }

}

/**
 * Wire action menu buttons. UI still owns opening/closing and setting current track; this binds the action buttons once.
 * @param {Object} selectors - { overlay, sheet?, queueBtn, shareBtn?, editBtn, favBtn, addToPlaylistBtn?, deleteBtn?, removeFromPlaylistBtn?, closeBtn?, startRadioBtn?, trackArt?, trackTitle?, trackArtist? }
 * @param {Object} deps - { store, getCurrentActionTrack, onClose, onShowMetadataEditor, onFavClick?, onAddToPlaylist?, onRemoveFromPlaylist?, showToast? }
 */
export function wireActionMenu(selectors, deps) {
    const { store, getCurrentActionTrack, onClose, onShowMetadataEditor, onFavClick, onAddToPlaylist, onRemoveFromPlaylist, showToast } = deps;
    const root = selectors.root || document;

    const overlay = getElement(root, selectors.overlay);
    const queueBtn = getElement(root, selectors.queueBtn);
    const editBtn = getElement(root, selectors.editBtn);
    const favBtn = getElement(root, selectors.favBtn);
    const addToPlaylistBtn = selectors.addToPlaylistBtn ? getElement(root, selectors.addToPlaylistBtn) : null;
    const deleteBtn = selectors.deleteBtn ? getElement(root, selectors.deleteBtn) : null;
    const removeFromPlaylistBtn = selectors.removeFromPlaylistBtn ? getElement(root, selectors.removeFromPlaylistBtn) : null;
    const closeBtn = getElement(root, selectors.closeBtn);
    const shareBtn = selectors.shareBtn ? getElement(root, selectors.shareBtn) : null;
    const startRadioBtn = selectors.startRadioBtn ? getElement(root, selectors.startRadioBtn) : null;
    const playOnDeviceBtn = selectors.playOnDeviceBtn ? getElement(root, selectors.playOnDeviceBtn) : null;

    if (overlay) overlay.addEventListener('click', () => onClose?.());
    if (closeBtn) closeBtn.addEventListener('click', () => onClose?.());

    if (startRadioBtn) {
        startRadioBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (!track) return;
            await radioService.startRadio(track);
        });
    }

    if (playOnDeviceBtn) {
        playOnDeviceBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) {
                onClose?.();
                return;
            }
            if (isDeezerSurfaceActionTrack(track)) {
                showToast?.('Download to library to use remote play');
                onClose?.();
                return;
            }
            onClose?.();
            const devices = await remoteControl.fetchDevices();
            const currentDeviceId = store.getDeviceId();
            const others = devices.filter(d => d.device_id !== currentDeviceId);

            if (others.length === 0) {
                showToast?.('No other devices connected');
                return;
            }

            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 z-[280] flex items-center justify-center p-4 touch-none';
            modal.style.backgroundColor = 'var(--overlay-bg)';
            modal.innerHTML = `
                <div class="absolute inset-0" style="backdrop-filter: blur(4px);"></div>
                <div class="glass-view rounded-[var(--radius-omni)] border border-[var(--glass-border)] shadow-2xl w-full max-w-xs overflow-hidden relative">
                    <div class="p-4 border-b border-[var(--glass-border)]">
                        <h3 class="text-sm font-black uppercase tracking-widest text-[var(--text-dim)]">Play on device</h3>
                    </div>
                    <div id="play-on-device-list" class="max-h-64 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                        ${others.map(d => `
                            <button type="button" class="play-on-device-item w-full flex items-center gap-3 p-3 rounded-[var(--radius-omni-xs)] hover:bg-[var(--surface-overlay)] active:bg-[var(--bg-card)] transition-colors text-left" data-device-id="${d.device_id.replace(/"/g, '&quot;')}">
                                <div class="w-8 h-8 rounded-full bg-[var(--surface-overlay)] border border-[var(--glass-border)] flex items-center justify-center flex-shrink-0">
                                    <i class="fas ${d.device_type === 'mobile' ? 'fa-mobile-screen-button' : 'fa-desktop'} text-[var(--secondary)] text-xs"></i>
                                </div>
                                <div class="flex-1 min-w-0">
                                    <div class="text-sm font-semibold text-[var(--text-main)] truncate">${remoteControl._escapeHtml(d.device_name || 'Device')}</div>
                                    <div class="text-xs text-[var(--text-dim)]">${d.socket_connected || d.active_sid ? 'Online' : 'Offline'}</div>
                                </div>
                            </button>
                        `).join('')}
                    </div>
                    <button type="button" id="play-on-device-cancel" class="w-full p-3 text-sm font-bold text-[var(--text-dim)] hover:bg-[var(--surface-overlay)] transition-colors border-t border-[var(--glass-border)]">Cancel</button>
                </div>`;
            document.body.appendChild(modal);

            modal.querySelector('.absolute.inset-0').addEventListener('click', () => modal.remove());
            modal.querySelector('#play-on-device-cancel').addEventListener('click', () => modal.remove());

            modal.querySelectorAll('.play-on-device-item').forEach(btn => {
                btn.addEventListener('click', () => {
                    const deviceId = btn.getAttribute('data-device-id');
                    modal.remove();
                    if (deviceId && track.id) {
                        fetch(`${store.apiBase}/api/playback/remote-command`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ device_id: deviceId, command: 'play', track_id: track.id })
                        }).catch(() => {});
                        showToast?.('Sent to device');
                    }
                });
            });
        });
    }

    if (playOnDeviceBtn) {
        playOnDeviceBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) return;
            await showPlayOnDevicePicker(track);
        });
    }

    if (contextPlayOnDeviceBtn) {
        contextPlayOnDeviceBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) return;
            await showPlayOnDevicePicker(track);
        });
    }
}

/**
 * Wire downloader view: search input, search button, results container.
 * Downloader class uses getElementById; for desktop we would pass a different root or refactor Downloader.
 * This helper binds the minimal set so desktop can pass selectors; mobile continues to call Downloader.init() which uses hardcoded ids.
 * @param {Object} selectors - { searchInput, searchBtn, resultsContainer, ... }
 * @param {Object} deps - { store, Downloader, Haptics }
 */
export function wireDownloader(selectors, deps) {
    const { Downloader } = deps;
    if (Downloader && typeof Downloader.init === 'function') {
        Downloader.init();
    }
}

/**
 * Wire remote control: device list refresh, agent token generation, "Play on device" action.
 * @param {Object} selectors - { refreshBtn, deviceListContainer, generateTokenBtn, tokenDisplay, playOnDeviceBtn, contextPlayOnDeviceBtn }
 * @param {Object} deps - { store, showToast, getCurrentActionTrack }
 */
export function wireRemoteControl(selectors, deps) {
    const { store, showToast, getCurrentActionTrack } = deps;

    const refreshBtn = selectors.refreshBtn;
    const deviceListContainer = selectors.deviceListContainer;
    const generateTokenBtn = selectors.generateTokenBtn;
    const tokenDisplay = selectors.tokenDisplay;
    const playOnDeviceBtn = selectors.playOnDeviceBtn;
    const contextPlayOnDeviceBtn = selectors.contextPlayOnDeviceBtn;

    if (refreshBtn && deviceListContainer) {
        const loadDevices = () => {
            remoteControl.renderDeviceList(deviceListContainer);
        };
        refreshBtn.addEventListener('click', loadDevices);
        loadDevices();
    }

    if (generateTokenBtn && tokenDisplay) {
        generateTokenBtn.addEventListener('click', async () => {
            generateTokenBtn.disabled = true;
            generateTokenBtn.textContent = 'Generating...';
            const result = await remoteControl.generateAgentToken();
            generateTokenBtn.disabled = false;
            generateTokenBtn.textContent = 'Generate Token';
            if (result.error) {
                showToast?.(result.error);
                return;
            }
            tokenDisplay.classList.remove('hidden');
            tokenDisplay.value = result.token;
            showToast?.('Token generated');
        });
    }

    async function showPlayOnDevicePicker(track) {
        if (!track?.id) return;
        const devices = await remoteControl.fetchDevices();
        const currentDeviceId = store.getDeviceId();
        const others = devices.filter(d => d.device_id !== currentDeviceId);

        if (others.length === 0) {
            showToast?.('No other devices connected');
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 z-[280] flex items-center justify-center p-4 touch-none';
        modal.style.backgroundColor = 'var(--overlay-bg)';
        modal.innerHTML = `
            <div class="absolute inset-0" style="backdrop-filter: blur(4px);"></div>
            <div class="glass-view rounded-[var(--radius-omni)] border border-[var(--glass-border)] shadow-2xl w-full max-w-xs overflow-hidden relative">
                <div class="p-4 border-b border-[var(--glass-border)]">
                    <h3 class="text-sm font-black uppercase tracking-widest text-[var(--text-dim)]">Play on device</h3>
                </div>
                <div id="play-on-device-list" class="max-h-64 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                    ${others.map(d => `
                        <button type="button" class="play-on-device-item w-full flex items-center gap-3 p-3 rounded-[var(--radius-omni-xs)] hover:bg-[var(--surface-overlay)] active:bg-[var(--bg-card)] transition-colors text-left" data-device-id="${d.device_id.replace(/"/g, '&quot;')}">
                            <div class="w-8 h-8 rounded-full bg-[var(--surface-overlay)] border border-[var(--glass-border)] flex items-center justify-center flex-shrink-0">
                                <i class="fas ${d.device_type === 'mobile' ? 'fa-mobile-screen-button' : 'fa-desktop'} text-[var(--secondary)] text-xs"></i>
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="text-sm font-semibold text-[var(--text-main)] truncate">${remoteControl._escapeHtml(d.device_name || 'Device')}</div>
                                <div class="text-xs text-[var(--text-dim)]">${d.socket_connected || d.active_sid ? 'Online' : 'Offline'}</div>
                            </div>
                        </button>
                    `).join('')}
                </div>
                <button type="button" id="play-on-device-cancel" class="w-full p-3 text-sm font-bold text-[var(--text-dim)] hover:bg-[var(--surface-overlay)] transition-colors border-t border-[var(--glass-border)]">Cancel</button>
            </div>`;
        document.body.appendChild(modal);

        modal.querySelector('.absolute.inset-0').addEventListener('click', () => modal.remove());
        modal.querySelector('#play-on-device-cancel').addEventListener('click', () => modal.remove());

        modal.querySelectorAll('.play-on-device-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const deviceId = btn.getAttribute('data-device-id');
                modal.remove();
                const trackId = track.id;
                if (deviceId && trackId) {
                    fetch(`${store.apiBase}/api/playback/remote-command`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ device_id: deviceId, command: 'play', track_id: trackId })
                    }).catch(() => {});
                    showToast?.('Sent to device');
                }
            });
        });
    }

    if (playOnDeviceBtn) {
        playOnDeviceBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) return;
            await showPlayOnDevicePicker(track);
        });
    }

    if (contextPlayOnDeviceBtn) {
        contextPlayOnDeviceBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) return;
            await showPlayOnDevicePicker(track);
        });
    }
}
