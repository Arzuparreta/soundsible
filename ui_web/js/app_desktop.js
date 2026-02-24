/**
 * Soundsible Desktop Entry Point
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { connectionManager } from './connection.js';
import { audioEngine } from './audio.js';
import { Downloader } from './downloader.js';
import * as renderers from './renderers.js';
import { scoreLibrary, scoreArtist, mergeAndSortByScore } from './search.js';
import { wireSettings, wireActionMenu } from './wires.js';
import { DesktopUI } from './ui_desktop.js';

console.log('Soundsible Desktop initializing...');

function playTrack(trackId) {
    const state = store.state;
    let context = state.library;
    if (DesktopUI.currentView === 'home') {
        context = window._currentHomeTracks ?? renderers.sortLibraryTracks(state.library, state.libraryOrder || 'date_added', state.favorites);
    } else if (DesktopUI.currentView === 'favourites') context = window._currentFavTracks ?? context;
    else if (DesktopUI.currentView === 'artist-detail') context = window._currentArtistTracks ?? context;
    else if (DesktopUI.currentView === 'playlist-detail') context = window._currentPlaylistTracks ?? context;
    else if (DesktopUI.currentView === 'search') context = window._currentSearchTracks ?? context;
    const track = context?.find((t) => t.id === trackId);
    if (track) {
        audioEngine.setContext(context);
        store.update({ currentTrack: track });
        audioEngine.playTrack(track);
    }
}

function showArtistDetail(artistName) {
    window._currentArtistName = artistName;
    window._currentArtistTracks = renderers.getArtistTracks(artistName, store.state.library);
    const titleEl = document.getElementById('desktop-artist-detail-title');
    const coverEl = document.getElementById('desktop-artist-detail-cover');
    const tracksEl = document.getElementById('desktop-artist-tracks');
    const albumsEl = document.getElementById('desktop-artist-albums');
    renderers.renderArtistDetail(artistName, store.state.library, { titleEl, coverEl }, tracksEl, albumsEl);
    DesktopUI.showView('artist-detail');
}

function filterPlaylistsBySearch(playlists, query) {
    if (!query) return playlists;
    const q = query.trim().toLowerCase();
    const out = {};
    Object.keys(playlists || {}).forEach((name) => {
        if (name.toLowerCase().includes(q)) out[name] = playlists[name];
    });
    return out;
}

function renderPlaylists() {
    const state = store.state;
    const input = document.getElementById('desktop-playlist-search-input');
    const container = document.getElementById('desktop-playlist-list-container');
    if (!container) return;
    const query = input?.value.trim() || '';
    const filtered = filterPlaylistsBySearch(state.playlists || {}, query);
    const hasAny = Object.keys(state.playlists || {}).length > 0;
    const options = hasAny && Object.keys(filtered).length === 0 && query ? { emptyMessage: 'No playlists match your search.' } : {};
    options.preserveOrder = !query;
    renderers.renderPlaylistList(filtered, state.library || [], container, options);
}

function renderPlaylistDetail() {
    const name = window._currentPlaylistName;
    if (!name) return;
    const state = store.state;
    const trackIds = (state.playlists || {})[name] || [];
    const library = state.library || [];
    const tracks = trackIds.map((id) => library.find((t) => t.id === id)).filter(Boolean);
    window._currentPlaylistTracks = tracks;

    const titleEl = document.getElementById('desktop-playlist-detail-title');
    const metaEl = document.getElementById('desktop-playlist-detail-meta');
    const coverEl = document.getElementById('desktop-playlist-detail-cover');
    const iconEl = document.getElementById('desktop-playlist-detail-cover-icon');
    const tracksEl = document.getElementById('desktop-playlist-detail-tracks');
    const searchInput = document.getElementById('desktop-playlist-detail-search-input');
    if (titleEl) titleEl.textContent = name;
    if (metaEl) metaEl.textContent = tracks.length === 1 ? '1 track' : `${tracks.length} tracks`;
    if (coverEl) {
        const first = tracks[0];
        if (first) {
            const url = Resolver.getCoverUrl(first);
            coverEl.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '%22')}")` : '';
            if (iconEl) iconEl.classList.add('hidden');
        } else {
            coverEl.style.backgroundImage = '';
            if (iconEl) iconEl.classList.remove('hidden');
        }
    }
    const searchQuery = searchInput?.value.trim() || '';
    renderers.renderPlaylistDetail(name, trackIds, library, tracksEl, { searchQuery });
}

function showPlaylistDetail(name) {
    window._currentPlaylistName = name;
    renderPlaylistDetail();
    DesktopUI.showView('playlist-detail');
}

window.removeFromPlaylistTrack = (playlistName, trackId) => {
    store.removeFromPlaylist(playlistName, trackId).then(() => {
        if (DesktopUI.currentView === 'playlist-detail' && window._currentPlaylistName === playlistName) renderPlaylistDetail();
    });
};

window.createPlaylistPrompt = () => {
    const name = prompt('Playlist name');
    if (name != null && name.trim()) store.createPlaylist(name.trim());
};

window.renamePlaylistPrompt = () => {
    const current = window._currentPlaylistName;
    if (!current) return;
    const newName = prompt('Rename playlist', current);
    if (newName != null && newName.trim() && newName.trim() !== current) {
        store.renamePlaylist(current, newName.trim()).then(() => {
            window._currentPlaylistName = newName.trim();
            renderPlaylistDetail();
        });
    }
};

window.duplicatePlaylistPrompt = () => {
    const current = window._currentPlaylistName;
    if (!current) return;
    const newName = prompt('Duplicate as', `${current} (copy)`);
    if (newName != null && newName.trim()) store.duplicatePlaylist(current, newName.trim());
};

window.deletePlaylistConfirm = () => {
    const current = window._currentPlaylistName;
    if (!current) return;
    if (confirm(`Delete playlist "${current}"?`)) {
        store.deletePlaylist(current).then(() => {
            window._currentPlaylistName = null;
            window._currentPlaylistTracks = null;
            DesktopUI.showView('playlists');
        });
    }
};

const PLAYLIST_HOLD_MS = 400;
const PLAYLIST_CANCEL_THRESHOLD_PX = 24;

function initPlaylistTrackDrag() {
    let holdTimer = null;
    let dragStarted = false;
    let clone = null;
    let originalItem = null;
    let fromIndex = 0;
    let startX = 0;
    let startY = 0;
    let pointerId = null;
    let hasMoved = false;

    function getPointerCoords(e) {
        if (e.clientX != null) return { x: e.clientX, y: e.clientY };
        if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: 0, y: 0 };
    }

    function cleanupDrag() {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        dragStarted = false;
        document.removeEventListener('pointermove', onDocMove, true);
        document.removeEventListener('pointerup', onDocEnd, true);
        document.removeEventListener('pointercancel', onDocEnd, true);
        if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
        clone = null;
        if (originalItem) {
            originalItem.classList.remove('playlist-drag-source');
            originalItem.style.opacity = '';
            originalItem.style.pointerEvents = '';
            originalItem.style.transition = '';
        }
        originalItem = null;
        document.querySelectorAll('.playlist-detail-row.queue-drop-target').forEach((el) => el.classList.remove('queue-drop-target'));
    }

    function getClosestSlotIndex() {
        const container = document.getElementById('desktop-playlist-detail-tracks');
        if (!container || !clone || !originalItem) return fromIndex;
        const cloneRect = clone.getBoundingClientRect();
        const cx = cloneRect.left + cloneRect.width / 2;
        const cy = cloneRect.top + cloneRect.height / 2;
        const children = Array.from(container.querySelectorAll('.playlist-detail-row')).filter((el) => el !== originalItem);
        if (children.length === 0) return fromIndex;
        const sorted = children.map((el) => ({
            idx: parseInt(el.getAttribute('data-index'), 10) || 0,
            rect: el.getBoundingClientRect()
        })).sort((a, b) => a.rect.top - b.rect.top);
        let best = sorted[0];
        let bestD = Infinity;
        sorted.forEach((s) => {
            const scx = s.rect.left + s.rect.width / 2;
            const scy = s.rect.top + s.rect.height / 2;
            const d = (cx - scx) ** 2 + (cy - scy) ** 2;
            if (d < bestD) { bestD = d; best = s; }
        });
        return best.idx;
    }

    function commitReorder(toIndex) {
        const from = fromIndex;
        const name = window._currentPlaylistName;
        cleanupDrag();
        if (from === toIndex || !name) {
            if (DesktopUI.currentView === 'playlist-detail') renderPlaylistDetail();
            return;
        }
        const trackIds = (store.state.playlists || {})[name] || [];
        const newIds = [...trackIds];
        const [moved] = newIds.splice(from, 1);
        newIds.splice(toIndex, 0, moved);
        store.reorderPlaylistTracks(name, newIds);
    }

    function onDocMove(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        const { x, y } = getPointerCoords(e);
        if (!hasMoved) {
            if (Math.hypot(x - startX, y - startY) > 8) hasMoved = true;
            else { if (clone) { clone.style.left = `${x - (clone.offsetWidth / 2)}px`; clone.style.top = `${y - (clone.offsetHeight / 2)}px`; } return; }
        }
        if (clone) {
            clone.style.left = `${x - (clone.offsetWidth / 2)}px`;
            clone.style.top = `${y - (clone.offsetHeight / 2)}px`;
        }
        requestAnimationFrame(() => {
            const next = getClosestSlotIndex();
            document.querySelectorAll('.playlist-detail-row.queue-drop-target').forEach((el) => el.classList.remove('queue-drop-target'));
            const container = document.getElementById('desktop-playlist-detail-tracks');
            if (container) {
                const rows = container.querySelectorAll('.playlist-detail-row');
                const target = Array.from(rows).find((r) => parseInt(r.getAttribute('data-index'), 10) === next);
                if (target && next !== fromIndex) target.classList.add('queue-drop-target');
            }
        });
    }

    function onDocEnd(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        if (!dragStarted || !clone) { cleanupDrag(); return; }
        if (!hasMoved) { cleanupDrag(); return; }
        const toIndex = getClosestSlotIndex();
        if (clone) {
            clone.style.transition = 'opacity 0.2s ease-out';
            clone.style.opacity = '0';
            const capturedTo = toIndex;
            clone.addEventListener('transitionend', () => { commitReorder(capturedTo); }, { once: true });
        } else commitReorder(toIndex);
    }

    document.addEventListener('pointerdown', (e) => {
        if (DesktopUI.currentView !== 'playlist-detail') return;
        const item = e.target.closest('.playlist-detail-row');
        const container = document.getElementById('desktop-playlist-detail-tracks');
        if (!item || !container || !container.contains(item)) return;
        e.preventDefault();
        const idx = parseInt(item.getAttribute('data-index'), 10);
        if (Number.isNaN(idx)) return;
        const rect = item.getBoundingClientRect();
        const { x, y } = getPointerCoords(e);
        startX = x;
        startY = y;
        fromIndex = idx;
        pointerId = e.pointerId;
        hasMoved = false;

        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTimer = null;
            dragStarted = true;
            originalItem = item;
            item.style.transition = 'opacity 0.2s';
            item.style.opacity = '0.2';
            item.style.pointerEvents = 'none';
            item.classList.add('playlist-drag-source');

            const cloneNode = item.cloneNode(true);
            cloneNode.classList.add('playlist-drag-clone');
            cloneNode.classList.remove('playlist-detail-row');
            cloneNode.querySelectorAll('button').forEach((b) => b.remove());
            cloneNode.style.width = `${rect.width}px`;
            cloneNode.style.left = `${rect.left}px`;
            cloneNode.style.top = `${rect.top}px`;
            cloneNode.style.position = 'fixed';
            cloneNode.style.margin = '0';
            cloneNode.style.opacity = '0';
            cloneNode.style.background = 'var(--bg-card)';
            document.body.appendChild(cloneNode);
            clone = cloneNode;
            requestAnimationFrame(() => {
                if (clone) {
                    clone.style.transition = 'opacity 0.2s';
                    clone.style.opacity = '1';
                }
            });
            document.addEventListener('pointermove', onDocMove, { passive: false, capture: true });
            document.addEventListener('pointerup', onDocEnd, { passive: false, capture: true });
            document.addEventListener('pointercancel', onDocEnd, { passive: false, capture: true });
        }, PLAYLIST_HOLD_MS);
    });

    document.addEventListener('pointerup', () => { if (!dragStarted && holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
    document.addEventListener('pointercancel', () => { if (!dragStarted && holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
}

const PLAYLIST_LIST_HOLD_MS = 400;

function initPlaylistListDrag() {
    let holdTimer = null;
    let dragStarted = false;
    let clone = null;
    let originalItem = null;
    let fromIndex = 0;
    let startX = 0;
    let startY = 0;
    let pointerId = null;
    let hasMoved = false;

    function getPointerCoords(e) {
        if (e.clientX != null) return { x: e.clientX, y: e.clientY };
        if (e.touches?.[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: 0, y: 0 };
    }

    function cleanupDrag() {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        dragStarted = false;
        document.removeEventListener('pointermove', onDocMove, true);
        document.removeEventListener('pointerup', onDocEnd, true);
        document.removeEventListener('pointercancel', onDocEnd, true);
        if (clone?.parentNode) clone.parentNode.removeChild(clone);
        clone = null;
        if (originalItem) {
            originalItem.classList.remove('playlist-drag-source');
            originalItem.style.opacity = '';
            originalItem.style.pointerEvents = '';
            originalItem.style.transition = '';
        }
        originalItem = null;
        document.querySelectorAll('.playlist-card.queue-drop-target').forEach((el) => el.classList.remove('queue-drop-target'));
    }

    function getClosestSlotIndex() {
        const container = document.getElementById('desktop-playlist-list-container');
        if (!container || !clone || !originalItem) return fromIndex;
        const cloneRect = clone.getBoundingClientRect();
        const cx = cloneRect.left + cloneRect.width / 2;
        const cy = cloneRect.top + cloneRect.height / 2;
        const children = Array.from(container.querySelectorAll('.playlist-card')).filter((el) => el !== originalItem);
        if (children.length === 0) return fromIndex;
        const sorted = children.map((el) => ({
            idx: parseInt(el.getAttribute('data-index'), 10) || 0,
            rect: el.getBoundingClientRect()
        })).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        let best = sorted[0];
        let bestD = Infinity;
        sorted.forEach((s) => {
            const scx = s.rect.left + s.rect.width / 2;
            const scy = s.rect.top + s.rect.height / 2;
            const d = (cx - scx) ** 2 + (cy - scy) ** 2;
            if (d < bestD) { bestD = d; best = s; }
        });
        return best.idx;
    }

    function commitReorder(toIndex) {
        const from = fromIndex;
        cleanupDrag();
        if (from === toIndex) {
            if (DesktopUI.currentView === 'playlists') renderPlaylists();
            return;
        }
        const playlists = store.state.playlists || {};
        const orderedNames = Object.keys(playlists);
        const newOrder = [...orderedNames];
        const [moved] = newOrder.splice(from, 1);
        newOrder.splice(toIndex, 0, moved);
        store.reorderPlaylists(newOrder);
    }

    function onDocMove(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        const { x, y } = getPointerCoords(e);
        if (!hasMoved) {
            if (Math.hypot(x - startX, y - startY) > 8) hasMoved = true;
            else { if (clone) { clone.style.left = `${x - (clone.offsetWidth / 2)}px`; clone.style.top = `${y - (clone.offsetHeight / 2)}px`; } return; }
        }
        if (clone) {
            clone.style.left = `${x - (clone.offsetWidth / 2)}px`;
            clone.style.top = `${y - (clone.offsetHeight / 2)}px`;
        }
        requestAnimationFrame(() => {
            const next = getClosestSlotIndex();
            document.querySelectorAll('.playlist-card.queue-drop-target').forEach((el) => el.classList.remove('queue-drop-target'));
            const container = document.getElementById('desktop-playlist-list-container');
            if (container) {
                const target = Array.from(container.querySelectorAll('.playlist-card')).find((r) => parseInt(r.getAttribute('data-index'), 10) === next);
                if (target && next !== fromIndex) target.classList.add('queue-drop-target');
            }
        });
    }

    function onDocEnd(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        if (!dragStarted || !clone) { cleanupDrag(); return; }
        if (!hasMoved) { cleanupDrag(); return; }
        const capturedTo = getClosestSlotIndex();
        if (clone) {
            clone.style.transition = 'opacity 0.2s ease-out';
            clone.style.opacity = '0';
            clone.addEventListener('transitionend', () => { commitReorder(capturedTo); }, { once: true });
        } else commitReorder(capturedTo);
    }

    document.addEventListener('pointerdown', (e) => {
        if (DesktopUI.currentView !== 'playlists') return;
        const searchInput = document.getElementById('desktop-playlist-search-input');
        if (searchInput?.value.trim()) return;
        const item = e.target.closest('.playlist-card');
        const container = document.getElementById('desktop-playlist-list-container');
        if (!item || !container || !container.contains(item)) return;
        e.preventDefault();
        const idx = parseInt(item.getAttribute('data-index'), 10);
        if (Number.isNaN(idx)) return;
        const rect = item.getBoundingClientRect();
        const { x, y } = getPointerCoords(e);
        startX = x; startY = y; fromIndex = idx; pointerId = e.pointerId; hasMoved = false;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(() => {
            holdTimer = null;
            dragStarted = true;
            originalItem = item;
            item.style.transition = 'opacity 0.2s';
            item.style.opacity = '0.2';
            item.style.pointerEvents = 'none';
            item.classList.add('playlist-drag-source');
            const cloneNode = item.cloneNode(true);
            cloneNode.classList.add('playlist-drag-clone');
            cloneNode.classList.remove('playlist-card');
            cloneNode.style.width = `${rect.width}px`;
            cloneNode.style.left = `${rect.left}px`;
            cloneNode.style.top = `${rect.top}px`;
            cloneNode.style.position = 'fixed';
            cloneNode.style.margin = '0';
            cloneNode.style.opacity = '0';
            cloneNode.style.background = 'var(--bg-card)';
            document.body.appendChild(cloneNode);
            clone = cloneNode;
            requestAnimationFrame(() => { if (clone) { clone.style.transition = 'opacity 0.2s'; clone.style.opacity = '1'; } });
            document.addEventListener('pointermove', onDocMove, { passive: false, capture: true });
            document.addEventListener('pointerup', onDocEnd, { passive: false, capture: true });
            document.addEventListener('pointercancel', onDocEnd, { passive: false, capture: true });
        }, PLAYLIST_LIST_HOLD_MS);
    });
    document.addEventListener('pointerup', () => { if (!dragStarted && holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
    document.addEventListener('pointercancel', () => { if (!dragStarted && holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
}

window.playTrack = playTrack;
window.showArtistDetail = showArtistDetail;
window.showPlaylistDetail = showPlaylistDetail;

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

window.showAddToPlaylistPicker = (trackId) => {
    const picker = document.getElementById('add-to-playlist-picker');
    const listEl = document.getElementById('add-to-playlist-picker-list');
    const backdrop = document.getElementById('add-to-playlist-picker-backdrop');
    const closeBtn = document.getElementById('add-to-playlist-picker-close');
    if (!picker || !listEl) return;
    window._addToPlaylistTrackId = trackId;
    const playlists = store.state.playlists || {};
    const names = Object.keys(playlists).sort((a, b) => a.localeCompare(b));
    listEl.innerHTML = names.map((name) => `<button type="button" class="add-to-playlist-picker-item w-full flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--surface-overlay)] text-left font-bold text-sm text-[var(--text-main)] transition-colors" data-playlist-name="${esc(name)}"><i class="fas fa-layer-group text-[var(--text-dim)] w-4"></i><span>${esc(name)}</span></button>`).join('') + `<button type="button" class="add-to-playlist-picker-item w-full flex items-center gap-3 p-3 rounded-xl hover:bg-[var(--accent)]/15 text-left font-bold text-sm text-[var(--accent)] transition-colors" data-new-playlist><i class="fas fa-plus w-4"></i><span>New playlist…</span></button>`;
    function hide() {
        picker.classList.add('hidden');
        window._addToPlaylistTrackId = null;
    }
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
                    store.createPlaylist(newName.trim()).then(() => store.addToPlaylist(newName.trim(), tid)).then(() => DesktopUI.showToast(`Added to ${newName.trim()}`));
                }
            } else if (name) {
                store.addToPlaylist(name, tid).then(() => DesktopUI.showToast(`Added to ${name}`));
            }
        });
    });
    if (backdrop) backdrop.addEventListener('click', hide, { once: true });
    if (closeBtn) closeBtn.addEventListener('click', hide, { once: true });
    picker.classList.remove('hidden');
};

window.store = store;
window.audioEngine = audioEngine;
window.UI = DesktopUI;

window.toggleArtistAlbum = (ev) => {
    const card = ev?.currentTarget?.closest?.('.artist-album-card');
    if (card) card.classList.toggle('artist-album-expanded');
};

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const base = document.querySelector('base')?.href || new URL('.', location.href).href;
    const scope = base.replace(/\/[^/]*$/, '/');
    const swUrl = scope + 'sw.js';
    navigator.serviceWorker.register(swUrl, { scope }).catch((err) =>
        console.warn('Desktop SW registration failed:', err)
    );
}

async function init() {
    try {
        registerServiceWorker();
        DesktopUI.init();

        Downloader.init({
            searchInput: 'desktop-dl-search-input',
            searchBtn: 'desktop-dl-search-btn',
            searchResults: 'desktop-dl-search-results',
            queueContainer: 'desktop-dl-queue-container',
            dlQueueFab: 'desktop-dl-queue-fab',
            dlQueueBadge: 'desktop-dl-queue-badge',
            downloadQueuePopover: 'desktop-dl-download-queue-popover',
            downloadQueueList: 'desktop-dl-download-queue-list',
            clearQueueBtn: 'desktop-dl-clear-queue-btn',
            submitDownloadBtn: 'desktop-dl-submit-download-btn',
            searchSourceMusicBtn: 'desktop-dl-search-source-music',
            searchSourceYoutubeBtn: 'desktop-dl-search-source-youtube',
            refetchMetadataBtn: 'desktop-refetch-metadata-btn',
            refetchMetadataStatus: 'desktop-refetch-metadata-status'
        });

        window.addEventListener('click', (e) => {
            if (DesktopUI.currentView !== 'search') return;
            const dlq = document.getElementById('desktop-dl-queue-container');
            if (dlq && !dlq.contains(e.target)) Downloader.hideDownloadQueue?.();
        });

        wireSettings({
            tokenInput: 'desktop-sync-token-input',
            importBtn: 'desktop-import-token-btn',
            libraryOrderSelect: 'desktop-settings-library-order',
            themeSelect: 'desktop-settings-theme-select',
            appIconSelect: 'desktop-settings-app-icon-select',
            hapticsIndicator: null,
            refetchBtn: 'desktop-refetch-metadata-btn',
            refetchStatus: 'desktop-refetch-metadata-status',
            statusLed: null,
            statusPulse: null,
            serverStatus: 'desktop-server-status',
            hostDisplay: 'desktop-active-host-display'
        }, { store, showToast: (m) => DesktopUI.showToast(m), onLibraryOrderChange: () => renderHomeSongs() });

        const themeSelect = document.getElementById('desktop-settings-theme-select');
        if (themeSelect) {
            themeSelect.value = store.state.theme;
            themeSelect.addEventListener('change', () => {
                const value = themeSelect.value;
                if (value && ['dark', 'light', 'odst'].includes(value)) {
                    store.setTheme(value);
                    DesktopUI.applyTheme(value);
                }
            });
        }

        wireActionMenu({
            overlay: 'desktop-action-menu-overlay',
            queueBtn: 'desktop-action-queue',
            editBtn: 'desktop-action-edit-metadata',
            favBtn: 'desktop-action-fav',
            addToPlaylistBtn: 'desktop-action-add-to-playlist',
            deleteBtn: 'desktop-action-delete',
            removeFromPlaylistBtn: 'desktop-action-remove-from-playlist',
            closeBtn: 'desktop-action-close'
        }, {
            store,
            getCurrentActionTrack: () => DesktopUI.currentActionTrack,
            onClose: () => DesktopUI.hideActionMenu(),
            onShowMetadataEditor: (id) => DesktopUI.showMetadataEditor(id),
            onAddToPlaylist: (trackId) => window.showAddToPlaylistPicker(trackId),
            onRemoveFromPlaylist: (track) => {
                const name = window._currentPlaylistName;
                if (track && name) store.removeFromPlaylist(name, track.id);
                DesktopUI.hideActionMenu();
            }
        });

        const endpoints = [...store.state.priorityList, window.location.hostname];
        await connectionManager.findActiveHost([...new Set(endpoints)].filter(Boolean));
        store.syncLibrary();

        const songsViewModeToContainerClass = {
            list: 'songs-container-list space-y-2 transition-all duration-300',
            grid: 'songs-container-grid grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 transition-all duration-300',
            gridCompact: 'songs-container-grid grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 transition-all duration-300',
            gridLarge: 'songs-container-grid grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 transition-all duration-300'
        };
        const artistViewModeToContainerClass = {
            gridCompact: 'grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 transition-all duration-300',
            grid: 'grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4 transition-all duration-300',
            gridLarge: 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 transition-all duration-300'
        };

        function renderSongsInto(containerEl, tracks, viewMode) {
            if (!containerEl) return;
            const mode = viewMode || store.state.songsViewMode || 'list';
            containerEl.className = songsViewModeToContainerClass[mode] || songsViewModeToContainerClass.list;

            if (tracks.length === 0) {
                containerEl.innerHTML = '<div class="col-span-full text-gray-500 text-center py-10 italic">No songs found.</div>';
                return;
            }
            if (mode === 'list') {
                renderers.renderSongList(tracks, containerEl);
            } else {
                containerEl.innerHTML = renderers.buildSongGridHtml(tracks, {}, mode);
                renderers.enableMarqueeIfNeeded(containerEl);
            }
        }

        function renderHomeSongs() {
            const input = document.getElementById('desktop-home-search-input');
            const container = document.getElementById('desktop-all-songs');
            const q = input?.value.trim() || '';
            const library = store.state.library || [];
            if (!q) {
                const sorted = renderers.sortLibraryTracks(library, store.state.libraryOrder || 'date_added', store.state.favorites);
                window._currentHomeTracks = sorted;
                renderSongsInto(container, sorted, store.state.songsViewMode);
                return;
            }
            const artistsWithTrack = renderers.getArtistsWithRepresentativeTrack(library).filter(({ name }) => name.toLowerCase().includes(q.toLowerCase()));
            const artistItems = artistsWithTrack.map(({ name, track }) => ({
                type: 'artist',
                name,
                track,
                score: scoreArtist(name, q),
                sortTitle: name.toLowerCase()
            }));
            const trackResults = renderers.filterLibraryByQuery(library, q);
            const trackItems = trackResults.map(track => ({
                type: 'track',
                track,
                score: scoreLibrary(track, q),
                sortTitle: (track.title || '').toLowerCase()
            }));
            const merged = mergeAndSortByScore([...artistItems, ...trackItems]);
            window._currentHomeTracks = merged.filter(m => m.type === 'track').map(m => m.track);
            if (!container) return;
            if (merged.length === 0) {
                container.className = 'space-y-2';
                container.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">No results</div>';
                return;
            }
            container.className = 'space-y-2';
            const options = { favIds: store.state.favorites, activeTrackId: store.state.currentTrack?.id };
            const html = merged.map(item =>
                item.type === 'artist'
                    ? renderers.buildHomeArtistRowHtml(item.name, item.track, options)
                    : renderers.buildSongRowsHtml([item.track], options)
            ).join('');
            container.innerHTML = html;
        }

        function renderFavourites() {
            const input = document.getElementById('desktop-fav-search-input');
            const container = document.getElementById('desktop-fav-tracks');
            const full = (store.state.favorites || []).map((id) => store.state.library.find((t) => t.id === id)).filter(Boolean);
            const q = input?.value.trim().toLowerCase() || '';
            const favTracks = !q ? full : full.filter((t) => [t.title, t.artist, t.album].some((s) => String(s).toLowerCase().includes(q)));
            window._currentFavTracks = favTracks;
            renderSongsInto(container, favTracks, store.state.songsViewMode);
        }

        store.subscribe((state) => {
            renderers.renderQueue(state, [document.getElementById('desktop-queue-tracks')].filter(Boolean));
            if (DesktopUI.currentView === 'home') renderHomeSongs();
            if (DesktopUI.currentView === 'favourites') renderFavourites();
            if (DesktopUI.currentView === 'artists') {
                const artistsContainer = document.getElementById('desktop-all-artists');
                if (artistsContainer) {
                    const mode = state.artistViewMode || 'gridCompact';
                    artistsContainer.className = artistViewModeToContainerClass[mode] || artistViewModeToContainerClass.gridCompact;
                    renderers.renderArtistList(state.library, artistsContainer);
                }
            }
            if (DesktopUI.currentView === 'artist-detail' && window._currentArtistName) {
                const titleEl = document.getElementById('desktop-artist-detail-title');
                const coverEl = document.getElementById('desktop-artist-detail-cover');
                const tracksEl = document.getElementById('desktop-artist-tracks');
                const albumsEl = document.getElementById('desktop-artist-albums');
                renderers.renderArtistDetail(window._currentArtistName, state.library, { titleEl, coverEl }, tracksEl, albumsEl);
            }
            if (DesktopUI.currentView === 'playlists') renderPlaylists();
            if (DesktopUI.currentView === 'playlist-detail' && window._currentPlaylistName) renderPlaylistDetail();
            DesktopUI.updatePlayer(state);
        });

        document.getElementById('desktop-home-search-input')?.addEventListener('input', renderHomeSongs);
        document.getElementById('desktop-fav-search-input')?.addEventListener('input', renderFavourites);
        document.getElementById('desktop-playlist-search-input')?.addEventListener('input', renderPlaylists);
        document.getElementById('desktop-playlist-detail-search-input')?.addEventListener('input', renderPlaylistDetail);

        document.getElementById('desktop-artist-back')?.addEventListener('click', () => DesktopUI.navigateBack());
        document.getElementById('desktop-playlist-detail-back')?.addEventListener('click', () => DesktopUI.navigateBack());

        const origShowView = DesktopUI.showView.bind(DesktopUI);
        DesktopUI.showView = (viewId) => {
            origShowView(viewId);
            if (viewId === 'playlists') renderPlaylists();
            if (viewId === 'playlist-detail' && window._currentPlaylistName) renderPlaylistDetail();
            if (viewId === 'search') {
                import('./search.js').then((m) => {
                    window.unifiedSearch = m.unifiedSearch;
                    m.unifiedSearch.init({ mobile: false });
                });
            }
        };

        initPlaylistTrackDrag();
        initPlaylistListDrag();

        (function bindSongViewWheel() {
            const STEP_THRESHOLD = 90;
            const COOLDOWN_MS = 500;
            let ctrlAccumDown = 0;
            let ctrlAccumUp = 0;
            let cooldown = null;

            function resetAccum() {
                ctrlAccumDown = 0;
                ctrlAccumUp = 0;
            }

            const MODES_ORDER = ['list', 'gridCompact', 'grid', 'gridLarge'];
            const ARTIST_MODES_ORDER = ['gridCompact', 'grid', 'gridLarge'];

            function advanceMode() {
                const i = MODES_ORDER.indexOf(store.state.songsViewMode);
                if (i < MODES_ORDER.length - 1) store.update({ songsViewMode: MODES_ORDER[i + 1] });
            }

            function previousMode() {
                const i = MODES_ORDER.indexOf(store.state.songsViewMode);
                if (i > 0) store.update({ songsViewMode: MODES_ORDER[i - 1] });
            }

            function advanceArtistMode() {
                const i = ARTIST_MODES_ORDER.indexOf(store.state.artistViewMode);
                if (i < ARTIST_MODES_ORDER.length - 1) store.update({ artistViewMode: ARTIST_MODES_ORDER[i + 1] });
            }

            function previousArtistMode() {
                const i = ARTIST_MODES_ORDER.indexOf(store.state.artistViewMode);
                if (i > 0) store.update({ artistViewMode: ARTIST_MODES_ORDER[i - 1] });
            }

            document.addEventListener('wheel', (e) => {
                if (e.ctrlKey) e.preventDefault();

                const view = DesktopUI.currentView;
                if (!e.ctrlKey) return;
                if (view !== 'home' && view !== 'favourites' && view !== 'artists') return;

                if (view === 'artists') {
                    if (e.deltaY > 0) {
                        ctrlAccumDown += e.deltaY;
                        if (ctrlAccumDown >= STEP_THRESHOLD) {
                            previousArtistMode();
                            resetAccum();
                            ctrlAccumDown = 0;
                            if (cooldown) clearTimeout(cooldown);
                            cooldown = setTimeout(resetAccum, COOLDOWN_MS);
                        }
                    } else if (e.deltaY < 0) {
                        ctrlAccumUp -= e.deltaY;
                        if (ctrlAccumUp >= STEP_THRESHOLD) {
                            advanceArtistMode();
                            resetAccum();
                            ctrlAccumUp = 0;
                            if (cooldown) clearTimeout(cooldown);
                            cooldown = setTimeout(resetAccum, COOLDOWN_MS);
                        }
                    }
                    return;
                }

                if (e.deltaY > 0) {
                    ctrlAccumDown += e.deltaY;
                    if (ctrlAccumDown >= STEP_THRESHOLD) {
                        previousMode();
                        resetAccum();
                        ctrlAccumDown = 0;
                        if (cooldown) clearTimeout(cooldown);
                        cooldown = setTimeout(resetAccum, COOLDOWN_MS);
                    }
                } else if (e.deltaY < 0) {
                    ctrlAccumUp -= e.deltaY;
                    if (ctrlAccumUp >= STEP_THRESHOLD) {
                        advanceMode();
                        resetAccum();
                        ctrlAccumUp = 0;
                        if (cooldown) clearTimeout(cooldown);
                        cooldown = setTimeout(resetAccum, COOLDOWN_MS);
                    }
                }
            }, { passive: false });

            document.addEventListener('keyup', (e) => {
                if (e.key === 'Control') resetAccum();
            });
        })();

        if (store.state.library.length > 0) {
            renderHomeSongs();
            renderers.renderArtistList(store.state.library, document.getElementById('desktop-all-artists'));
            renderFavourites();
            renderers.renderQueue(store.state, [document.getElementById('desktop-queue-tracks')].filter(Boolean));
        }

        document.getElementById('desktop-app')?.classList.remove('hidden');
    } catch (err) {
        console.error('Desktop init failed:', err);
    } finally {
        const loader = document.getElementById('initial-loader');
        if (loader) {
            loader.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => loader.remove(), 500);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
