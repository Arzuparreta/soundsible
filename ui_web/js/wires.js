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
 * Wire settings panel: token import, library order, theme, haptics, refetch metadata, status display.
 * @param {Object} selectors - { root?, tokenInput, importBtn, libraryOrderSelect?, themeSelect?, hapticsToggle?, themeIndicator?, hapticsIndicator?, refetchBtn?, refetchStatus?, statusLed?, statusPulse?, serverStatus?, hostDisplay? }
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

    const updateIndicators = (state) => {
        if (themeSelect) themeSelect.value = state.theme;
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

    const refetchBtn = getElement(root, selectors.refetchBtn);
    const refetchStatus = getElement(root, selectors.refetchStatus);
    if (refetchBtn && refetchStatus) {
        refetchBtn.addEventListener('click', async () => {
            refetchBtn.disabled = true;
            refetchBtn.textContent = 'Refetching...';
            refetchStatus.classList.remove('hidden');
            refetchStatus.textContent = 'Starting metadata refetch...';
            try {
                const base = store.apiBase || `${window.location.protocol}//${store.state.activeHost}:${store.state.config?.port || 7390}`;
                const res = await fetch(`${base}/api/library/refetch-metadata`, { method: 'POST' });
                const data = await res.json();
                if (res.ok) {
                    refetchStatus.textContent = `✓ Updated: ${data.updated || 0}, Skipped: ${data.skipped || 0}, Errors: ${data.errors || 0}`;
                    refetchStatus.classList.remove('text-red-400');
                    refetchStatus.classList.add('text-green-400');
                    await store.syncLibrary();
                } else {
                    refetchStatus.textContent = `✗ Error: ${data.error || 'Unknown error'}`;
                    refetchStatus.classList.remove('text-green-400');
                    refetchStatus.classList.add('text-red-400');
                }
            } catch (err) {
                refetchStatus.textContent = `✗ Failed: ${err.message}`;
                refetchStatus.classList.remove('text-green-400');
                refetchStatus.classList.add('text-red-400');
            } finally {
                refetchBtn.disabled = false;
                refetchBtn.textContent = 'Re-fetch Metadata';
            }
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
