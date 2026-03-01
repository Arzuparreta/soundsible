/**
 * Shared wiring: attach behaviour to DOM (settings, action menu).
 * Both mobile (app.js / ui.js) and desktop (app_desktop.js) call these with their own selectors.
 */

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
        if (statusLed && serverStatus) {
            const isOnline = state.isOnline;
            statusLed.className = `relative w-2 h-2 rounded-full bg-${isOnline ? 'green' : 'red'}-500 shadow-[0_0_12px_rgba(${isOnline ? '34,197,94' : '239,68,68'},0.8)]`;
            if (statusPulse) statusPulse.className = `absolute inset-0 w-2 h-2 rounded-full bg-${isOnline ? 'green' : 'red'}-500 status-pulse`;
            serverStatus.textContent = isOnline ? 'Connected' : 'Offline';
            serverStatus.className = `text-sm font-bold text-${isOnline ? 'green' : 'red'}-500`;
        }
    };
    if (subscribeIndicators) {
        updateIndicators(store.state);
        store.subscribe(updateIndicators);
    }

    const ytdlpAutoUpdate = getElement(root, selectors.ytdlpAutoUpdate);
    if (ytdlpAutoUpdate) {
        const apiBase = store.apiBase || '';
        fetch(`${apiBase}/api/downloader/config`)
            .then((r) => r.json())
            .then((c) => {
                ytdlpAutoUpdate.checked = c.auto_update_ytdlp === true;
            })
            .catch(() => {});
        ytdlpAutoUpdate.addEventListener('change', () => {
            fetch(`${apiBase}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_update_ytdlp: ytdlpAutoUpdate.checked }),
            })
                .then((r) => (r.ok ? showToast?.('Setting saved') : null))
                .catch(() => {});
        });
    }

    const lastfmInput = getElement(root, selectors.lastfmInput);
    const lastfmSave = getElement(root, selectors.lastfmSave);
    const lastfmStatus = getElement(root, selectors.lastfmStatus);
    if (lastfmSave && lastfmInput) {
        lastfmSave.addEventListener('click', async () => {
            const key = (lastfmInput.value || '').trim();
            if (!key) {
                if (lastfmStatus) { lastfmStatus.textContent = 'Enter an API key.'; lastfmStatus.classList.remove('hidden'); }
                return;
            }
            lastfmSave.disabled = true;
            if (lastfmStatus) { lastfmStatus.textContent = 'Saving…'; lastfmStatus.classList.remove('hidden'); }
            try {
                const apiBase = store.apiBase || '';
                const res = await fetch(`${apiBase}/api/downloader/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lastfm_api_key: key }),
                });
                if (res.ok) {
                    if (lastfmStatus) { lastfmStatus.textContent = 'Saved.'; lastfmStatus.classList.remove('hidden'); }
                    lastfmInput.value = '';
                    showToast?.('Last.fm key saved');
                } else {
                    const d = await res.json().catch(() => ({}));
                    if (lastfmStatus) { lastfmStatus.textContent = d.error || 'Save failed.'; lastfmStatus.classList.remove('hidden'); }
                }
            } catch (err) {
                if (lastfmStatus) { lastfmStatus.textContent = 'Network error.'; lastfmStatus.classList.remove('hidden'); }
            }
            lastfmSave.disabled = false;
        });
    }

}

/**
 * Wire action menu buttons. UI still owns opening/closing and setting current track; this binds the action buttons once.
 * @param {Object} selectors - { overlay, sheet?, queueBtn, editBtn, favBtn, addToPlaylistBtn?, deleteBtn?, removeFromPlaylistBtn?, closeBtn?, trackArt?, trackTitle?, trackArtist? }
 * @param {Object} deps - { store, getCurrentActionTrack, onClose, onShowMetadataEditor, onFavClick?, onAddToPlaylist?, onRemoveFromPlaylist? }
 */
export function wireActionMenu(selectors, deps) {
    const { store, getCurrentActionTrack, onClose, onShowMetadataEditor, onFavClick, onAddToPlaylist, onRemoveFromPlaylist } = deps;
    const root = selectors.root || document;

    const overlay = getElement(root, selectors.overlay);
    const queueBtn = getElement(root, selectors.queueBtn);
    const editBtn = getElement(root, selectors.editBtn);
    const favBtn = getElement(root, selectors.favBtn);
    const addToPlaylistBtn = selectors.addToPlaylistBtn ? getElement(root, selectors.addToPlaylistBtn) : null;
    const deleteBtn = selectors.deleteBtn ? getElement(root, selectors.deleteBtn) : null;
    const removeFromPlaylistBtn = selectors.removeFromPlaylistBtn ? getElement(root, selectors.removeFromPlaylistBtn) : null;
    const closeBtn = getElement(root, selectors.closeBtn);

    if (overlay) overlay.addEventListener('click', () => onClose?.());
    if (closeBtn) closeBtn.addEventListener('click', () => onClose?.());

    if (queueBtn) {
        queueBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            if (track) store.toggleQueue(track.id);
            onClose?.();
        });
    }

    if (favBtn) {
        favBtn.addEventListener('click', () => {
            if (onFavClick) {
                onFavClick(getCurrentActionTrack?.());
            } else {
                const track = getCurrentActionTrack?.();
                if (track) store.toggleFavourite(track.id);
                onClose?.();
            }
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            if (track && confirm('Delete?')) store.deleteTrack(track.id);
            onClose?.();
        });
    }

    if (editBtn) {
        editBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (track) onShowMetadataEditor?.(track.id);
        });
    }

    if (addToPlaylistBtn && onAddToPlaylist) {
        addToPlaylistBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (track) onAddToPlaylist(track.id);
        });
    }

    if (removeFromPlaylistBtn && onRemoveFromPlaylist) {
        removeFromPlaylistBtn.addEventListener('click', () => {
            const track = getCurrentActionTrack?.();
            onClose?.();
            if (track) onRemoveFromPlaylist(track);
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
