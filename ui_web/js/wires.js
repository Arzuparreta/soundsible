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
import { adminFetch } from './admin_auth.js';

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
 * @param {Object} selectors - { root?, tokenInput, importBtn, libraryOrderSelect?, themeSelect?, appIconSelect?, hapticsToggle?, themeIndicator?, hapticsIndicator?, statusLed?, statusPulse?, serverStatus?, hostDisplay?, musicDirInput?, musicDirSaveBtn?, musicDirHint? }
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
        adminFetch(`${getApiBase()}/api/downloader/config`)
            .then((r) => r.json())
            .then((c) => {
                ytdlpAutoUpdate.checked = c.auto_update_ytdlp === true;
            })
            .catch(() => {});
        ytdlpAutoUpdate.addEventListener('change', () => {
            adminFetch(`${getApiBase()}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_update_ytdlp: ytdlpAutoUpdate.checked }),
            })
                .then((r) => (r.ok ? showToast?.('Setting saved') : null))
                .catch(() => {});
        });
    }

    const musicDirInput = getElement(root, selectors.musicDirInput);
    const musicDirSaveBtn = getElement(root, selectors.musicDirSaveBtn);
    const musicDirHint = getElement(root, selectors.musicDirHint);
    if (musicDirInput && musicDirSaveBtn) {
        const getApiBase = () => store.apiBase || '';
        const refreshMusicDir = () => {
            adminFetch(`${getApiBase()}/api/setup/music-dir`)
                .then((r) => (r.ok ? r.json() : Promise.reject()))
                .then((j) => {
                    musicDirInput.value = j.music_dir || '';
                    if (musicDirHint) {
                        if (j.env_override) {
                            musicDirHint.textContent =
                                'Using SOUNDSIBLE_MUSIC_DIR; saving still updates the stored path for when that env is unset.';
                        } else if (j.effective_source === 'persisted') {
                            musicDirHint.textContent = 'Using your saved music library folder.';
                        } else {
                            musicDirHint.textContent = 'Using the default folder until you save a path.';
                        }
                    }
                })
                .catch(() => {});
        };
        refreshMusicDir();
        musicDirSaveBtn.addEventListener('click', () => {
            const v = musicDirInput.value.trim();
            if (!v) {
                showToast?.('Enter a folder path');
                return;
            }
            adminFetch(`${getApiBase()}/api/setup/music-dir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ music_dir: v }),
            })
                .then(async (r) => {
                    let j = {};
                    try {
                        j = await r.json();
                    } catch (_) {}
                    if (!r.ok) {
                        showToast?.(j.error || 'Could not save music folder');
                        return;
                    }
                    showToast?.('Music folder saved');
                    refreshMusicDir();
                })
                .catch(() => showToast?.('Could not save music folder'));
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

            const modal = remoteControl.createDevicePickerModal(others, track, store, showToast);
            document.body.appendChild(modal);
        });
    }

    if (queueBtn) {
        queueBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) {
                onClose?.();
                return;
            }
            if (isDeezerSurfaceActionTrack(track)) {
                await actionMenuToggleQueueDeezer(track, store, showToast);
                onClose?.();
                return;
            }
            store.toggleQueue(track.id);
            onClose?.();
        });
    }

    if (shareBtn) {
        shareBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) {
                onClose?.();
                return;
            }
            if (isDeezerSurfaceActionTrack(track)) {
                await actionMenuShareDeezer(track, showToast);
                onClose?.();
                return;
            }
            if (getYouTubeWatchUrlForTrack(track)) shareYouTubeTrack(track, showToast);
            onClose?.();
        });
    }

    if (favBtn) {
        favBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            if (!track) return;
            if (isDeezerSurfaceActionTrack(track)) {
                await hydrateDeezerVirtualTrack(track);
                const libId = track._libraryTrackId;
                if (!libId) {
                    showToast?.('Download to library to use favourites');
                    onClose?.();
                    return;
                }
                const libTrack = store.state.library.find((t) => t.id === libId);
                if (onFavClick && libTrack) {
                    onFavClick(libTrack);
                } else {
                    store.toggleFavourite(libId);
                    onClose?.();
                }
                return;
            }
            if (onFavClick) {
                onFavClick(track);
            } else {
                store.toggleFavourite(track.id);
                onClose?.();
            }
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            if (isDeezerSurfaceActionTrack(track)) {
                onClose?.();
                return;
            }
            if (track && confirm('Delete?')) store.deleteTrack(track.id);
            onClose?.();
        });
    }

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (isDeezerSurfaceActionTrack(track)) return;
            if (track) onShowMetadataEditor?.(track.id);
        });
    }

    if (addToPlaylistBtn && onAddToPlaylist) {
        addToPlaylistBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (!track) return;
            if (isDeezerSurfaceActionTrack(track)) {
                await actionMenuAddToPlaylistDeezer(track, showToast, onAddToPlaylist);
                return;
            }
            onAddToPlaylist(track.id);
        });
    }

    if (removeFromPlaylistBtn && onRemoveFromPlaylist) {
        removeFromPlaylistBtn.addEventListener('click', async () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (!track) return;
            if (isDeezerSurfaceActionTrack(track)) {
                await hydrateDeezerVirtualTrack(track);
                if (track._libraryTrackId) onRemoveFromPlaylist({ id: track._libraryTrackId });
                return;
            }
            onRemoveFromPlaylist(track);
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
    const root = selectors.root || document;

    const refreshBtn = getElement(root, selectors.refreshBtn);
    const deviceListContainer = getElement(root, selectors.deviceListContainer);
    const generateTokenBtn = getElement(root, selectors.generateTokenBtn);
    const tokenDisplay = getElement(root, selectors.tokenDisplay);
    const playOnDeviceBtn = getElement(root, selectors.playOnDeviceBtn);
    const contextPlayOnDeviceBtn = getElement(root, selectors.contextPlayOnDeviceBtn);

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

        const modal = remoteControl.createDevicePickerModal(others, track, store, showToast);
        document.body.appendChild(modal);
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
 * Playlist migration: match Spotify / Apple export against library, create playlist.
 * @param {Object} selectors - { root?, formatSelect, payloadTextarea, previewBtn, hintEl, includeConfirmCheckbox, playlistNameInput, importBtn }
 * @param {Object} deps - { store, showToast, onAfterImport? }
 */
export function wireMigration(selectors, deps) {
    const { store, showToast, onAfterImport } = deps;
    const root = selectors.root || document;

    const fmtEl = getElement(root, selectors.formatSelect);
    const textEl = getElement(root, selectors.payloadTextarea);
    const previewBtn = getElement(root, selectors.previewBtn);
    const hintEl = getElement(root, selectors.hintEl);
    const includeConfirmEl = getElement(root, selectors.includeConfirmCheckbox);
    const nameEl = getElement(root, selectors.playlistNameInput);
    const importBtn = getElement(root, selectors.importBtn);

    /** @type {unknown[]|null} */
    let lastMatches = null;

    /**
     * @param {boolean} includeConfirm
     * @returns {string[]}
     */
    function collectTrackIds(includeConfirm) {
        if (!lastMatches || !Array.isArray(lastMatches)) return [];
        const ids = [];
        for (const m of lastMatches) {
            if (!m || typeof m !== 'object') continue;
            const tid = m.matched_track_id;
            if (!tid || typeof tid !== 'string') continue;
            if (m.auto_accept) ids.push(tid);
            else if (includeConfirm && m.needs_confirmation) ids.push(tid);
        }
        return ids;
    }

    if (previewBtn && textEl && fmtEl) {
        previewBtn.addEventListener('click', async () => {
            const format = String(fmtEl.value || '').trim();
            const text = String(textEl.value || '').trim();
            if (!format) {
                showToast?.('Choose export format');
                return;
            }
            if (!text) {
                showToast?.('Paste export text');
                return;
            }
            previewBtn.disabled = true;
            try {
                const res = await adminFetch(`${store.apiBase}/api/migration/preview`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ format, text }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    lastMatches = null;
                    if (hintEl) hintEl.textContent = data.error || `Preview failed (${res.status})`;
                    showToast?.(data.error || 'Preview failed');
                    return;
                }
                lastMatches = data.matches || [];
                const st = data.stats || {};
                const parts = [
                    `Matched ${st.matched ?? 0} / ${st.total ?? 0}`,
                    `auto ${st.auto_accept ?? 0}`,
                    `confirm ${st.needs_confirmation ?? 0}`,
                    `unmatched ${st.unmatched ?? 0}`,
                ];
                if (hintEl) hintEl.textContent = parts.join(' · ');
                showToast?.('Preview ready');
            } catch (_) {
                lastMatches = null;
                if (hintEl) hintEl.textContent = 'Request failed';
                showToast?.('Preview failed');
            } finally {
                previewBtn.disabled = false;
            }
        });
    }

    if (importBtn && nameEl) {
        importBtn.addEventListener('click', async () => {
            const name = String(nameEl.value || '').trim();
            if (!name) {
                showToast?.('Playlist name required');
                return;
            }
            const includeConfirm = !!(includeConfirmEl && includeConfirmEl.checked);
            const track_ids = collectTrackIds(includeConfirm);
            if (!track_ids.length) {
                showToast?.('Run preview first — no tracks to import');
                return;
            }
            importBtn.disabled = true;
            try {
                const res = await adminFetch(`${store.apiBase}/api/migration/import-playlist`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playlist_name: name, track_ids }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    showToast?.(data.error || `Import failed (${res.status})`);
                    return;
                }
                showToast?.(`Playlist "${name}" (${data.track_count ?? track_ids.length} tracks)`);
                nameEl.value = '';
                await store.syncLibrary().catch(() => {});
                onAfterImport?.();
            } catch (_) {
                showToast?.('Import failed');
            } finally {
                importBtn.disabled = false;
            }
        });
    }
}
