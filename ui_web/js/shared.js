/**
 * Shared frontend helpers used by both mobile and desktop shells.
 */

export function filterPlaylistsBySearch(playlists, query) {
    if (!query) return playlists;
    const q = query.trim().toLowerCase();
    const out = {};
    Object.keys(playlists || {}).forEach((name) => {
        if (name.toLowerCase().includes(q)) out[name] = playlists[name];
    });
    return out;
}

export function getPointerCoords(e) {
    if (e.clientX != null) return { x: e.clientX, y: e.clientY };
    if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    if (e.changedTouches?.[0]) return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    return { x: 0, y: 0 };
}

export function bindPlaylistWindowActions(options) {
    const {
        store,
        getCurrentPlaylistName,
        setCurrentPlaylistName,
        renderPlaylistDetail,
        showPlaylistList
    } = options;

    window.removeFromPlaylistTrack = (playlistName, trackId) => {
        store.removeFromPlaylist(playlistName, trackId).then(() => {
            if (getCurrentPlaylistName() === playlistName) renderPlaylistDetail(playlistName);
        });
    };

    window.createPlaylistPrompt = () => {
        const name = prompt('Playlist name');
        if (name != null && name.trim()) store.createPlaylist(name.trim());
    };

    window.renamePlaylistPrompt = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        const newName = prompt('Rename playlist', current);
        if (newName != null && newName.trim() && newName.trim() !== current) {
            store.renamePlaylist(current, newName.trim()).then(() => {
                setCurrentPlaylistName(newName.trim());
                renderPlaylistDetail(newName.trim());
            });
        }
    };

    window.duplicatePlaylistPrompt = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        const newName = prompt('Duplicate as', `${current} (copy)`);
        if (newName != null && newName.trim()) store.duplicatePlaylist(current, newName.trim());
    };

    window.deletePlaylistConfirm = () => {
        const current = getCurrentPlaylistName();
        if (!current) return;
        if (!confirm(`Delete playlist "${current}"?`)) return;
        store.deletePlaylist(current).then(() => {
            setCurrentPlaylistName(null);
            window._currentPlaylistTracks = null;
            showPlaylistList();
        });
    };
}

export function showAddToPlaylistPicker(options) {
    const {
        store,
        esc,
        toast,
        itemPaddingClass = 'p-4',
        itemHoverClass = 'active:bg-[var(--surface-overlay)]',
        addHoverClass = 'active:bg-[var(--accent)]/15'
    } = options;
    return (trackId) => {
        const picker = document.getElementById('add-to-playlist-picker');
        const listEl = document.getElementById('add-to-playlist-picker-list');
        const backdrop = document.getElementById('add-to-playlist-picker-backdrop');
        const closeBtn = document.getElementById('add-to-playlist-picker-close');
        if (!picker || !listEl) return;
        window._addToPlaylistTrackId = trackId;
        const playlists = store.state.playlists || {};
        const names = Object.keys(playlists).sort((a, b) => a.localeCompare(b));
        const baseClass = `add-to-playlist-picker-item w-full flex items-center gap-3 ${itemPaddingClass} rounded-xl text-left font-bold text-sm transition-colors`;
        listEl.innerHTML = names.map((name) => (
            `<button type="button" class="${baseClass} ${itemHoverClass} text-[var(--text-main)]" data-playlist-name="${esc(name)}"><i class="fas fa-layer-group text-[var(--text-dim)] w-4"></i><span>${esc(name)}</span></button>`
        )).join('') + `<button type="button" class="${baseClass} ${addHoverClass} text-[var(--accent)]" data-new-playlist><i class="fas fa-plus w-4"></i><span>New playlist...</span></button>`;
        const hide = () => {
            picker.classList.add('hidden');
            window._addToPlaylistTrackId = null;
        };
        listEl.querySelectorAll('.add-to-playlist-picker-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-playlist-name');
                const isNew = btn.hasAttribute('data-new-playlist');
                const tid = window._addToPlaylistTrackId;
                hide();
                if (!tid) return;
                if (isNew) {
                    const newName = prompt('Playlist name');
                    if (newName != null && newName.trim()) {
                        const trimmed = newName.trim();
                        store.createPlaylist(trimmed).then(() => store.addToPlaylist(trimmed, tid)).then(() => toast(`Added to ${trimmed}`));
                    }
                } else if (name) {
                    store.addToPlaylist(name, tid).then(() => toast(`Added to ${name}`));
                }
            });
        });
        if (backdrop) backdrop.addEventListener('click', hide, { once: true });
        if (closeBtn) closeBtn.addEventListener('click', hide, { once: true });
        picker.classList.remove('hidden');
    };
}

export function initLibraryMaintenanceControls(options) {
    const {
        store,
        audioEngine,
        openButtonId,
        purgeButtonId,
        toast,
        onAfterSync
    } = options;

    const modal = document.getElementById('wipe-library-modal');
    const backdrop = document.getElementById('wipe-library-modal-backdrop');
    const input = document.getElementById('wipe-library-confirm-input');
    const cancelBtn = document.getElementById('wipe-library-cancel');
    const submitBtn = document.getElementById('wipe-library-submit');
    const errorEl = document.getElementById('wipe-library-error');
    const openBtn = document.getElementById(openButtonId);

    if (modal && input && submitBtn && openBtn) {
        const showModal = () => {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            input.value = '';
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
            input.focus();
        };
        const hideModal = () => {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            input.value = '';
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
        };
        const checkConfirm = () => {
            const v = input.value.trim();
            submitBtn.disabled = v !== 'CONFIRM' && v !== 'confirm';
            if (errorEl) errorEl.classList.add('hidden');
        };

        openBtn.addEventListener('click', showModal);
        input.addEventListener('input', checkConfirm);
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideModal(); });
        cancelBtn?.addEventListener('click', hideModal);
        backdrop?.addEventListener('click', hideModal);

        submitBtn.addEventListener('click', async () => {
            if (submitBtn.disabled) return;
            const confirmVal = input.value.trim();
            if (confirmVal !== 'CONFIRM' && confirmVal !== 'confirm') return;
            submitBtn.disabled = true;
            if (errorEl) { errorEl.classList.add('hidden'); errorEl.textContent = ''; }
            try {
                const res = await fetch(`${store.apiBase}/api/library/wipe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirm: confirmVal })
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    if (errorEl) {
                        errorEl.textContent = data.error || 'Wipe failed';
                        errorEl.classList.remove('hidden');
                    }
                    submitBtn.disabled = false;
                    toast(data.error || 'Wipe failed');
                    return;
                }
                hideModal();
                store.update({
                    library: [],
                    queue: [],
                    playlists: {},
                    favorites: [],
                    libraryYoutubeIds: [],
                    youtubeToTrackId: {},
                    currentTrack: null,
                    isPlaying: false
                });
                store.save('library', []);
                store.save('playlists', {});
                store.save('favorites', []);
                if (audioEngine?.pause) audioEngine.pause();
                await store.syncLibrary();
                onAfterSync?.();
                toast('Library wiped');
            } catch (err) {
                if (errorEl) {
                    errorEl.textContent = err.message || 'Request failed';
                    errorEl.classList.remove('hidden');
                }
                submitBtn.disabled = false;
                toast(err.message || 'Request failed');
            }
        });
    }

    const purgeBtn = document.getElementById(purgeButtonId);
    if (!purgeBtn) return;
    purgeBtn.addEventListener('click', async () => {
        purgeBtn.disabled = true;
        purgeBtn.classList.add('opacity-60', 'cursor-wait');
        try {
            const res = await fetch(`${store.apiBase}/api/library/purge-missing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast(data.error || 'Purge failed');
            } else {
                const checked = typeof data.checked === 'number' ? data.checked : 0;
                const removed = typeof data.removed === 'number' ? data.removed : 0;
                const msg = removed === 0
                    ? 'No missing tracks found'
                    : `Removed ${removed} missing ${removed === 1 ? 'track' : 'tracks'} (checked ${checked})`;
                await store.syncLibrary();
                onAfterSync?.();
                toast(msg);
            }
        } catch (err) {
            toast(err?.message || 'Purge failed');
        } finally {
            purgeBtn.disabled = false;
            purgeBtn.classList.remove('opacity-60', 'cursor-wait');
        }
    });
}
