/**
 * Soundsible Web Player Entry Point
 */

import { store } from './store.js';
import { Resolver } from './resolver.js';
import { UI } from './ui.js';
import { Haptics } from './haptics.js';
import { audioEngine } from './audio.js';
import { connectionManager } from './connection.js';
import { Downloader } from './downloader.js';
import * as renderers from './renderers.js';
import { scoreLibrary, scoreArtist, mergeAndSortByScore } from './search.js';
import { wireSettings } from './wires.js';
import { LIBRARY_TABS } from './library_tabs.js';
import { checkResumeFromOtherDevice } from './playback_resume.js';
import { isVisible, onChange as onVisibilityChange } from './visibility.js';

const LIBRARY_SYNC_INTERVAL_MS = 300000;

console.log("🚀 Soundsible Web Player Initializing...");

/** Cached DOM refs for mobile; set at init. */
let dom = null;

/** Current view list/state; avoids scattered window globals. Required on window for UI (fav-first animation). */
const viewContext = {
    homeTracks: null,
    favTracks: null,
    artistTracks: null,
    artistName: null,
    currentPlaylistName: null,
    searchTracks: null,
    pendingFavFirstEntranceId: null,
    favFirstExitId: null
};
window.viewContext = viewContext;

/** Inline handlers in HTML need: UI, store, playTrack, getTrackFromCurrentContext, showArtistDetail, toggleArtistAlbum. */
/** Mobile settings panel element IDs for wireSettings. */
const MOBILE_SETTINGS_IDS = {
    tokenInput: 'sync-token-input',
    importBtn: 'import-token-btn',
    libraryOrderSelect: 'settings-library-order',
    themeSelect: 'settings-theme-select',
    appIconSelect: 'settings-app-icon-select',
    hapticsToggle: 'haptics-indicator',
    hapticsIndicator: 'haptics-indicator',
    refetchBtn: 'refetch-metadata-btn',
    refetchStatus: 'refetch-metadata-status',
    statusLed: 'status-led',
    statusPulse: 'status-led-pulse',
    serverStatus: 'server-status',
    hostDisplay: 'active-host-display'
};

function renderFavourites(state) {
    if (!dom) return;
    renderers.renderFavourites(state, dom.favSearchInput, dom.favTracks);
    viewContext.favTracks = (state.favorites || []).map(id => state.library.find(t => t.id === id)).filter(t => t);
    if (dom.favSearchInput && dom.favSearchInput.value.trim()) {
        const q = dom.favSearchInput.value.trim().toLowerCase();
        viewContext.favTracks = viewContext.favTracks.filter(t =>
            t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q));
    }
}

function updateQueueScrollCuePosition() {
    if (!dom || !dom.floatingQueue) return;
    const floatingQueue = dom.floatingQueue;
    const cue = floatingQueue.querySelector('.queue-scroll-cue');
    const thumb = cue ? cue.querySelector('.queue-scroll-cue-thumb') : null;
    if (!cue || !thumb) return;

    const cueHeight = cue.getBoundingClientRect().height;
    const thumbHeight = 10;
    const maxY = Math.max(0, cueHeight - thumbHeight);
    const scrollRange = floatingQueue.scrollHeight - floatingQueue.clientHeight;
    const ratio = scrollRange > 0 ? (floatingQueue.scrollTop / scrollRange) : 0;
    // Keep motion subtle: informative cue, not a full-range scrollbar.
    const travelFactor = 0.28;
    const centeredOffset = (maxY * (1 - travelFactor)) / 2;
    thumb.style.top = `${Math.round(centeredOffset + (maxY * ratio * travelFactor))}px`;
}

function renderQueue(state) {
    if (!dom || !dom.floatingQueue) return;
    const floatingQueue = dom.floatingQueue;
    renderers.renderQueue(state, floatingQueue);
    if (!state.queue || state.queue.length === 0) {
        floatingQueue.classList.remove('has-scroll-cue');
        const cue = floatingQueue.querySelector('.queue-scroll-cue');
        if (cue && cue.parentNode) cue.parentNode.removeChild(cue);
        return;
    }
    const shouldShowCue = state.queue.length >= 6;
    floatingQueue.classList.toggle('has-scroll-cue', shouldShowCue);
    let cue = floatingQueue.querySelector('.queue-scroll-cue');
    if (shouldShowCue) {
        if (!cue) {
            cue = document.createElement('div');
            cue.className = 'queue-scroll-cue';
            const thumb = document.createElement('div');
            thumb.className = 'queue-scroll-cue-thumb';
            cue.appendChild(thumb);
            floatingQueue.appendChild(cue);
        }
        requestAnimationFrame(updateQueueScrollCuePosition);
    } else if (cue && cue.parentNode) {
        cue.parentNode.removeChild(cue);
    }
    if (!floatingQueue.dataset.scrollCueBound) {
        floatingQueue.dataset.scrollCueBound = '1';
        floatingQueue.addEventListener('scroll', () => requestAnimationFrame(updateQueueScrollCuePosition), { passive: true });
        window.addEventListener('resize', () => requestAnimationFrame(updateQueueScrollCuePosition));
    }
}

const QUEUE_HOLD_MS = 280;
const QUEUE_MOVE_THRESHOLD_PX = 14;
const QUEUE_CANCEL_THRESHOLD_PX = 30;
const QUEUE_DROP_FADE_MS = 170;
const QUEUE_AUTO_SCROLL_THRESHOLD_PX = 60;
const QUEUE_AUTO_SCROLL_STEP_PX = 4;
const QUEUE_AUTO_SCROLL_INTERVAL_MS = 16;

function initQueueDrag() {
    if (!dom || !dom.floatingQueue) return;
    const container = dom.floatingQueue;

    let holdTimer = null;
    let fromIndex = null;
    let clone = null;
    let originalItem = null;
    let startX = 0, startY = 0;
    let dragStarted = false;
    let pointerId = null;
    let currentDropTargetIndex = null;
    let rafDropTarget = 0;
    let hasMoved = false;
    let autoScrollInterval = null;
    let lastPointerY = 0;

    function clearHoldTimer() {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
    }

    function getPointerCoords(e) {
        if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        return { x: e.clientX, y: e.clientY };
    }

    function stopAutoScroll() {
        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }
    }

    function cleanupDrag() {
        clearHoldTimer();
        stopAutoScroll();
        if (clone && clone.parentNode) clone.parentNode.removeChild(clone);
        clone = null;
        if (originalItem && originalItem.parentNode) {
            originalItem.classList.remove('queue-drag-source');
            originalItem.style.opacity = '';
            originalItem.style.transition = '';
            originalItem.style.pointerEvents = '';
        }
        originalItem = null;
        clearDropTarget();
        UI.isDraggingQueue = false;
        dragStarted = false;
        currentDropTargetIndex = null;
        hasMoved = false;
        document.removeEventListener('pointermove', onDocMove, { capture: true });
        document.removeEventListener('pointerup', onDocEnd, { capture: true });
        document.removeEventListener('pointercancel', onDocEnd, { capture: true });
        document.removeEventListener('touchmove', onDocTouchMove, { capture: true, passive: false });
        document.removeEventListener('touchend', onDocTouchEnd, { capture: true, passive: false });
        document.removeEventListener('touchcancel', onDocTouchCancel, { capture: true, passive: false });
    }

    function updateClonePosition(x, y) {
        if (clone) {
            const w = clone.getBoundingClientRect().width;
            const h = clone.getBoundingClientRect().height;
            clone.style.transition = 'none';
            clone.style.left = `${x - w / 2}px`;
            clone.style.top = `${y - h / 2}px`;
        }
    }

    function updateAutoScroll(y) {
        lastPointerY = y;
        
        if (!dragStarted || !clone || !container) {
            stopAutoScroll();
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const distanceFromTop = y - containerRect.top;
        const distanceFromBottom = containerRect.bottom - y;
        const scrollThreshold = QUEUE_AUTO_SCROLL_THRESHOLD_PX;
        const maxScroll = container.scrollHeight - container.clientHeight;

        let shouldScroll = false;
        if (distanceFromTop < scrollThreshold && container.scrollTop > 0) {
            shouldScroll = true;
        } else if (distanceFromBottom < scrollThreshold && container.scrollTop < maxScroll) {
            shouldScroll = true;
        }

        if (shouldScroll) {
            if (!autoScrollInterval) {
                autoScrollInterval = setInterval(() => {
                    if (!dragStarted || !container || !clone) {
                        stopAutoScroll();
                        return;
                    }
                    
                    const containerRect = container.getBoundingClientRect();
                    const distanceFromTop = lastPointerY - containerRect.top;
                    const distanceFromBottom = containerRect.bottom - lastPointerY;
                    const scrollThreshold = QUEUE_AUTO_SCROLL_THRESHOLD_PX;
                    const maxScroll = container.scrollHeight - container.clientHeight;

                    let scrollSpeed = 0;
                    if (distanceFromTop < scrollThreshold && container.scrollTop > 0) {
                        const factor = 1 - (distanceFromTop / scrollThreshold);
                        scrollSpeed = -QUEUE_AUTO_SCROLL_STEP_PX * factor;
                    } else if (distanceFromBottom < scrollThreshold && container.scrollTop < maxScroll) {
                        const factor = 1 - (distanceFromBottom / scrollThreshold);
                        scrollSpeed = QUEUE_AUTO_SCROLL_STEP_PX * factor;
                    }

                    if (scrollSpeed !== 0) {
                        const newScrollTop = container.scrollTop + scrollSpeed;
                        container.scrollTop = Math.max(0, Math.min(maxScroll, newScrollTop));
                        scheduleDropTargetUpdate();
                    } else {
                        stopAutoScroll();
                    }
                }, QUEUE_AUTO_SCROLL_INTERVAL_MS);
            }
        } else {
            stopAutoScroll();
        }
    }

    function clearDropTarget() {
        if (!container) return;
        const cont = container;
        cont.querySelectorAll('.queue-item.queue-drop-target').forEach(el => el.classList.remove('queue-drop-target'));
    }

    function setDropTarget(index) {
        if (index == null || !container) return;
        const cont = container;
        const el = cont.querySelector(`.queue-item[data-index="${index}"]`);
        if (!el) return;
        el.classList.add('queue-drop-target');
    }

    function scheduleDropTargetUpdate() {
        if (!dragStarted || !clone || !hasMoved) return;
        if (rafDropTarget) return;
        rafDropTarget = requestAnimationFrame(() => {
            rafDropTarget = 0;
            const next = getClosestSlotIndex();
            if (next !== currentDropTargetIndex) {
                clearDropTarget();
                currentDropTargetIndex = next;
                if (next !== fromIndex) {
                    setDropTarget(next);
                }
            }
        });
    }

    function getClosestSlotIndex() {
        if (!container || !clone || !originalItem) return fromIndex;
        const cont = container;
        
        const cloneRect = clone.getBoundingClientRect();
        const cx = cloneRect.left + cloneRect.width / 2;
        const cy = cloneRect.top + cloneRect.height / 2;
        
        const originalRect = originalItem.getBoundingClientRect();
        const ox = originalRect.left + originalRect.width / 2;
        const oy = originalRect.top + originalRect.height / 2;
        const distanceToOriginal = Math.hypot(cx - ox, cy - oy);
        
        if (distanceToOriginal <= QUEUE_CANCEL_THRESHOLD_PX) {
            return fromIndex;
        }
        
        const children = Array.from(cont.children).filter(el => {
            return el.classList.contains('queue-item') && el !== originalItem;
        });
        if (children.length === 0) return fromIndex;
        const sorted = children.map((el) => {
            const idx = parseInt(el.getAttribute('data-index'), 10);
            return { idx: Number.isNaN(idx) ? 0 : idx, rect: el.getBoundingClientRect() };
        }).sort((a, b) => a.rect.top - b.rect.top);
        if (sorted.length === 0) return fromIndex;
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

    function flyToSlotAndCommit(toIndex) {
        // No travel/bounce: clean “drop” fade, then commit.
        if (!clone) {
            commitReorder(toIndex);
            return;
        }

        clearDropTarget();

        // Let the original stay dim until commit swaps the list.
        clone.style.transition = `opacity ${QUEUE_DROP_FADE_MS}ms ease-out, transform ${QUEUE_DROP_FADE_MS}ms cubic-bezier(0.19, 1, 0.22, 1)`;
        clone.style.opacity = '0';
        clone.style.transform = 'scale(0.985)';

        const onDropFade = () => {
            clone.removeEventListener('transitionend', onDropFade);
            commitReorder(toIndex);
        };
        clone.addEventListener('transitionend', onDropFade);
    }

    function commitReorder(toIndex) {
        const from = fromIndex;
        cleanupDrag();
        if (from !== toIndex) {
            store.reorderQueue(from, toIndex);
        } else {
            renderQueue(store.state);
        }
        Haptics.tick();
    }

    function onDocTouchMove(e) {
        if (!dragStarted || !e.touches.length) return;
        e.preventDefault();
        const t = e.touches[0];
        if (!hasMoved) {
            const distance = Math.hypot(t.clientX - startX, t.clientY - startY);
            if (distance > QUEUE_MOVE_THRESHOLD_PX) {
                hasMoved = true;
            } else {
                updateClonePosition(t.clientX, t.clientY);
                return;
            }
        }
        updateClonePosition(t.clientX, t.clientY);
        updateAutoScroll(t.clientY);
        scheduleDropTargetUpdate();
    }

    function onDocTouchEnd(e) {
        if (!dragStarted || !clone) return;
        e.preventDefault();
        if (e.changedTouches && e.changedTouches.length) {
            if (!hasMoved) {
                cleanupDrag();
                return;
            }
            const toIndex = getClosestSlotIndex();
            flyToSlotAndCommit(toIndex);
        }
    }

    function onDocTouchCancel() {
        if (dragStarted) {
            cleanupDrag();
            renderQueue(store.state);
        }
    }

    function onDocMove(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        const { x, y } = getPointerCoords(e);
        if (!hasMoved) {
            const distance = Math.hypot(x - startX, y - startY);
            if (distance > QUEUE_MOVE_THRESHOLD_PX) {
                hasMoved = true;
            } else {
                updateClonePosition(x, y);
                return;
            }
        }
        updateClonePosition(x, y);
        updateAutoScroll(y);
        scheduleDropTargetUpdate();
    }

    function onDocEnd(e) {
        if (e.pointerId !== pointerId && pointerId != null) return;
        e.preventDefault();
        if (!dragStarted || !clone) {
            cleanupDrag();
            return;
        }
        if (!hasMoved) {
            cleanupDrag();
            return;
        }
        const toIndex = getClosestSlotIndex();
        flyToSlotAndCommit(toIndex);
    }

    container.addEventListener('pointerdown', function startHold(e) {
        if (dragStarted) return;
        const item = e.target.closest('.queue-item');
        if (!item) return;
        e.preventDefault();
        const idx = parseInt(item.getAttribute('data-index'), 10);
        if (Number.isNaN(idx)) return;
        const rect = item.getBoundingClientRect();
        const { x, y } = getPointerCoords(e);
        startX = x; startY = y;
        fromIndex = idx;
        pointerId = e.pointerId;
        hasMoved = false;

        clearHoldTimer();
        holdTimer = setTimeout(() => {
            holdTimer = null;
            dragStarted = true;
            UI.isDraggingQueue = true;
            Haptics.tick();

            originalItem = item;
            const currentOpacity = window.getComputedStyle(item).opacity || '1';
            item.style.transition = 'opacity 0.2s ease-out';
            item.style.opacity = currentOpacity;
            item.style.pointerEvents = 'none';
            item.classList.add('queue-drag-source');
            requestAnimationFrame(() => {
                if (originalItem && originalItem.parentNode) {
                    // Keep a faint ghost to avoid “hard disappear” feeling.
                    originalItem.style.opacity = '0.18';
                }
            });

            const cloneNode = item.cloneNode(true);
            cloneNode.classList.add('queue-drag-clone');
            cloneNode.classList.remove('queue-item');
            cloneNode.querySelectorAll('button').forEach(b => b.remove());
            cloneNode.style.width = `${rect.width}px`;
            cloneNode.style.left = `${rect.left}px`;
            cloneNode.style.top = `${rect.top}px`;
            cloneNode.style.opacity = '0';
            cloneNode.style.transform = 'scale(0.96) translateY(6px)';
            cloneNode.style.transition = 'none';
            document.body.appendChild(cloneNode);
            clone = cloneNode;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (clone && clone.parentNode) {
                        clone.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
                        clone.style.opacity = '1';
                        clone.style.transform = 'scale(1) translateY(0px)';
                    }
                });
            });

            document.addEventListener('pointermove', onDocMove, { passive: false, capture: true });
            document.addEventListener('pointerup', onDocEnd, { passive: false, capture: true });
            document.addEventListener('pointercancel', onDocEnd, { passive: false, capture: true });
            document.addEventListener('touchmove', onDocTouchMove, { passive: false, capture: true });
            document.addEventListener('touchend', onDocTouchEnd, { passive: false, capture: true });
            document.addEventListener('touchcancel', onDocTouchCancel, { passive: false, capture: true });
        }, QUEUE_HOLD_MS);
    });

    document.addEventListener('pointermove', function cancelHoldOnMove(e) {
        if (holdTimer == null || dragStarted) return;
        const { x, y } = getPointerCoords(e);
        if (Math.hypot(x - startX, y - startY) > QUEUE_MOVE_THRESHOLD_PX) clearHoldTimer();
    });

    document.addEventListener('pointerup', function cancelHoldOnPointerUp() {
        if (!dragStarted && holdTimer) clearHoldTimer();
    });
    document.addEventListener('pointercancel', function cancelHoldOnPointerCancel() {
        if (!dragStarted && holdTimer) clearHoldTimer();
    });
}

/**
 * Surgical UI Sync: Updates indicators (favs, active) without full re-render.
 */
function syncUIState(state) {
    const activeId = state.currentTrack ? state.currentTrack.id : null;
    const favIds = state.favorites || [];

    // 1. Update all visible song rows across the entire app
    const rows = document.querySelectorAll('.song-row');
    rows.forEach(row => {
        const id = row.getAttribute('data-id');
        const isActive = id === activeId;
        const isFav = favIds.includes(id);

        // Surgical update: Active highlight classes (Theme Aware)
        if (isActive) {
            row.classList.remove('bg-[var(--bg-card)]', 'border-transparent');
            row.classList.add('bg-[var(--bg-selection)]', 'border-[var(--glass-border)]');
        } else {
            row.classList.remove('bg-[var(--bg-selection)]', 'border-[var(--glass-border)]');
            row.classList.add('bg-[var(--bg-card)]', 'border-transparent');
        }

        // Surgical update: Active indicator (Volume icon)
        const indicator = row.querySelector('.active-indicator-container');
        if (indicator) {
            indicator.classList.toggle('opacity-100', isActive);
            indicator.classList.toggle('opacity-0', !isActive);
            indicator.classList.toggle('pointer-events-none', !isActive);
            indicator.classList.toggle('is-playing', isActive);
        }

        // Surgical update: Favourite indicator (Orange dot)
        const favIndicator = row.querySelector('.fav-indicator');
        if (favIndicator) favIndicator.classList.toggle('hidden', !isFav);

        // Surgical update: Title color
        const title = row.querySelector('.song-title');
        if (title) {
            title.classList.toggle('text-[var(--text-on-selection)]', isActive);
            title.classList.toggle('text-[var(--text-main)]', !isActive);
        }
    });
}

/**
 * Surgical Artist Grid Sync: Updates playing indicators on artist cards without full re-render.
 */
function syncArtistGridIndicators(state) {
    if (UI.currentView !== 'home' || (state.libraryTab || 'songs') !== 'artists') return;

    const currentTrack = state.currentTrack;
    const isPlaying = state.isPlaying;
    const raw = currentTrack && isPlaying ? (currentTrack.album_artist || currentTrack.artist) : '';
    const currentTrackArtistsSet = new Set(
        renderers.parseArtistNames(raw).map(n => renderers.normalizeArtistName(n))
    );

    const artistCards = document.querySelectorAll('.artist-card');
    artistCards.forEach(card => {
        const artistName = card.getAttribute('data-artist-name');
        const isCurrentlyPlaying = currentTrackArtistsSet.has(renderers.normalizeArtistName(artistName));
        const indicator = card.querySelector('.active-indicator-container');
        if (indicator) {
            indicator.classList.toggle('opacity-100', isCurrentlyPlaying);
            indicator.classList.toggle('opacity-0', !isCurrentlyPlaying);
            indicator.classList.toggle('pointer-events-none', !isCurrentlyPlaying);
            indicator.classList.toggle('is-playing', isCurrentlyPlaying);
        }
    });
}

window.renderFavourites = renderFavourites;
window.renderQueue = renderQueue;
window.syncArtistGridIndicators = syncArtistGridIndicators;
window.scheduleFavFirstAnimation = scheduleFavFirstAnimation;
window.store = store;
window.audioEngine = audioEngine;

window.showArtistDetail = (artistName) => {
    viewContext.artistName = artistName;
    UI.showView('artist-detail');
};

// INITIALIZATION ERROR HANDLER
window.addEventListener('error', (e) => {
    console.error("GLOBAL ERROR:", e.error);
    const loader = (dom && dom.initialLoader) || document.getElementById('initial-loader');
    if (loader) {
        loader.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => loader.remove(), 1000);
    }
});

async function init() {
    console.log("🚀 Soundsible App Init Sequence Started...");
    dom = {
        floatingQueue: document.getElementById('floating-queue-tracks'),
        allSongs: document.getElementById('all-songs'),
        homeSearchInput: document.getElementById('home-search-input'),
        favSearchInput: document.getElementById('fav-search-input'),
        favTracks: document.getElementById('fav-tracks'),
        libraryTabBar: document.getElementById('library-tab-bar'),
        libraryTabButtons: document.getElementById('library-tab-buttons'),
        librarySongs: document.getElementById('library-songs'),
        libraryArtists: document.getElementById('library-artists'),
        allArtists: document.getElementById('all-artists'),
        artistDetailTitle: document.getElementById('artist-detail-title'),
        artistDetailCover: document.getElementById('artist-detail-cover'),
        artistTracks: document.getElementById('artist-tracks'),
        artistAlbums: document.getElementById('artist-albums'),
        playlistSearchInput: document.getElementById('playlist-search-input'),
        playlistListContainer: document.getElementById('playlist-list-container'),
        playlistDetailTitle: document.getElementById('playlist-detail-title'),
        playlistDetailCover: document.getElementById('playlist-detail-cover'),
        playlistDetailCoverIcon: document.getElementById('playlist-detail-cover-icon'),
        playlistDetailMeta: document.getElementById('playlist-detail-meta'),
        playlistDetailTracks: document.getElementById('playlist-detail-tracks'),
        playlistDetailSearchInput: document.getElementById('playlist-detail-search-input'),
        initialLoader: document.getElementById('initial-loader')
    };
    try {
        // 1. Initialize UI First (Navigation, Player Bar)
        console.log("UI: Initializing...");
        UI.init();
        initSearch();
        initFavSearch();
        initPlaylistSearch();
        initArtistScrollSuppress();
        initArtistDetailBack();
        initQueueDrag();

        wireSettings(MOBILE_SETTINGS_IDS, { store, showToast: (msg) => UI.showToast(msg), onLibraryOrderChange: () => renderLibraryContent(), subscribeIndicators: false });

        // 2. Perform Connection Race
        const endpoints = [...store.state.priorityList, window.location.hostname];
        const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
        console.log("NET: Probing endpoints:", uniqueEndpoints);
        await connectionManager.findActiveHost(uniqueEndpoints);
        
        // 3. Load Library Data (Non-blocking)
        console.log("DATA: Starting background library sync...");
        store.syncLibrary().then(() => checkResumeFromOtherDevice());

        // 3. Subscribe to state changes for re-rendering (Optimized)
        let lastLibraryJson = null; // Force first render in subscription
        let lastLibraryTab = store.state.libraryTab || 'songs';
        let lastPlaylistsJson = JSON.stringify(store.state.playlists || {});
        let lastFavsJson = JSON.stringify(store.state.favorites);
        let lastQueueJson = JSON.stringify(store.state.queue);
        let lastTrackId = store.state.currentTrack ? store.state.currentTrack.id : null;
        let lastIsPlaying = store.state.isPlaying;

        store.subscribe((state) => {
            const currentLibJson = JSON.stringify(state.library);
            const currentLibraryTab = state.libraryTab || 'songs';
            const currentPlaylistsJson = JSON.stringify(state.playlists || {});
            const currentFavsJson = JSON.stringify(state.favorites);
            const currentQueueJson = JSON.stringify(state.queue);
            const currentTrackId = state.currentTrack ? state.currentTrack.id : null;
            const currentIsPlaying = state.isPlaying;

            // --- SMART RE-RENDERING LOGIC ---

            // 0. If only libraryTab changed (e.g. user tapped tab or returned from artist-detail), update tab bar and content
            if (currentLibraryTab !== lastLibraryTab && UI.currentView === 'home') {
                lastLibraryTab = currentLibraryTab;
                syncLibraryPanels();
                renderLibraryTabBar();
                renderLibraryContent();
            }
            
            // 1. If the entire Library changed (e.g. metadata sync), re-render only the current view (Option B: no pre-render of hidden views)
            if (currentLibJson !== lastLibraryJson) {
                console.log("Library synced, re-render current view.");
                lastLibraryJson = currentLibJson;
                renderQueue(state);
                const currentView = UI.currentView;
                if (currentView === 'home') {
                    syncLibraryPanels();
                    renderLibraryTabBar();
                    renderLibraryContent();
                } else if (currentView === 'favourites') {
                    renderFavourites(state);
                } else if (currentView === 'artist-detail' && viewContext.artistName) {
                    renderArtistDetail(viewContext.artistName);
                } else if (currentView === 'playlists') {
                    renderPlaylistList(state);
                } else if (currentView === 'playlist-detail' && viewContext.currentPlaylistName) {
                    renderPlaylistDetail(viewContext.currentPlaylistName);
                }
            } else if (currentPlaylistsJson !== lastPlaylistsJson) {
                lastPlaylistsJson = currentPlaylistsJson;
                const currentView = UI.currentView;
                if (currentView === 'playlists') renderPlaylistList(state);
                if (currentView === 'playlist-detail' && viewContext.currentPlaylistName) renderPlaylistDetail(viewContext.currentPlaylistName);
            } else {
                // 2. If ONLY favorites changed, we update the indicators surgically
                if (currentFavsJson !== lastFavsJson) {
                    syncUIState(state);
                    if (UI.currentView === 'favourites') renderFavourites(state);
                    if (UI.currentView === 'home' && (state.libraryOrder || 'date_added') === 'favorites_first') {
                        renderLibraryContent();
                        setTimeout(() => applyFavFirstEntranceIfNeeded(), 0);
                    }
                }
                lastFavsJson = currentFavsJson;

                // 3. If the active track or playing state changed, we update highlights surgically
                if (currentTrackId !== lastTrackId || currentIsPlaying !== lastIsPlaying) {
                    syncUIState(state);
                    syncArtistGridIndicators(state);
                }

                // 4. If ONLY the queue changed
                if (currentQueueJson !== lastQueueJson) {
                    // If the user is dragging, do NOT re-render the queue or we'll break the interaction
                    if (!UI.isDraggingQueue) {
                        renderQueue(state);
                    }
                }
            }
            
            // --- End Smart Rendering ---

            // Dedicated search bars already own rendering for home/favourites.
            
            lastLibraryTab = currentLibraryTab;
            lastFavsJson = currentFavsJson;
            lastPlaylistsJson = currentPlaylistsJson;
            lastQueueJson = currentQueueJson;
            lastTrackId = currentTrackId;
            lastIsPlaying = currentIsPlaying;
        });

        // 4. Initial Render — only default view (home) and queue (Option B: other views render when user navigates)
        if (store.state.library.length > 0 && dom) {
            console.log("DATA: Performing initial render (home + queue)...");
            syncLibraryPanels();
            renderLibraryTabBar();
            renderLibraryContent();
            renderQueue(store.state);
        }

    } catch (err) {
        console.error("CRITICAL: App initialization failed:", err);
    } finally {
        // 6. Dismiss Loader
        const loader = dom && dom.initialLoader;
        if (loader) {
            loader.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => loader.remove(), 1000);
        }
    }

    setInterval(() => {
        if (isVisible() && store.state.isOnline) {
            console.log("Periodic Sync: Verifying library truth...");
            store.syncLibrary();
        }
    }, LIBRARY_SYNC_INTERVAL_MS);

    onVisibilityChange((visible) => {
        if (visible && store.state.isOnline) store.syncLibrary();
    });
}

function sortLibraryTracks(tracks, order, favorites) {
    return renderers.sortLibraryTracks(tracks, order, favorites);
}

function renderSongList(tracks, containerId) {
    const container = dom && containerId === 'all-songs' ? dom.allSongs : (containerId === 'fav-tracks' ? dom.favTracks : document.getElementById(containerId));
    if (container) renderers.renderSongList(tracks, container);
}

function renderHomeSongs(tracks) {
    if (!dom || !dom.allSongs) return;
    const order = store.state.libraryOrder || 'date_added';
    const sorted = renderers.sortLibraryTracks(tracks, order, store.state.favorites);
    renderers.renderSongList(sorted, dom.allSongs);
}

function renderArtistDetail(artistName) {
    viewContext.artistTracks = renderers.getArtistTracks(artistName, store.state.library);
    viewContext.artistName = artistName;
    if (!dom) return;
    renderers.renderArtistDetail(artistName, store.state.library, { titleEl: dom.artistDetailTitle, coverEl: dom.artistDetailCover }, dom.artistTracks, dom.artistAlbums);
}

function renderArtistList(library) {
    if (dom && dom.allArtists) renderers.renderArtistList(library, dom.allArtists);
}

function syncLibraryPanels() {
    const tab = store.state.libraryTab || 'songs';
    if (dom?.librarySongs) dom.librarySongs.classList.toggle('hidden', tab !== 'songs');
    if (dom?.libraryArtists) dom.libraryArtists.classList.toggle('hidden', tab !== 'artists');
}

function renderLibraryTabBar() {
    const bar = dom?.libraryTabBar;
    const buttonsEl = dom?.libraryTabButtons;
    if (!bar || !buttonsEl) return;
    const tab = store.state.libraryTab || 'songs';
    bar.setAttribute('data-active-tab', tab);
    buttonsEl.innerHTML = LIBRARY_TABS.map((t) => {
        const active = t.id === tab;
        return `<button type="button" class="library-tab-btn flex-1 min-w-0 px-3 py-1.5 rounded-full text-[10px] font-bold transition-colors bg-transparent ${active ? 'text-[var(--text-on-accent)]' : 'text-[var(--accent)] active:opacity-80'}" data-library-tab="${t.id}" aria-pressed="${active}"><i class="fas ${t.icon} mr-2"></i>${t.label}</button>`;
    }).join('');
    buttonsEl.querySelectorAll('.library-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-library-tab');
            if (id && (id === 'songs' || id === 'artists')) {
                store.update({ libraryTab: id });
                renderLibraryTabBar();
                syncLibraryPanels();
                if (id === 'songs') renderHomeContent();
                else renderLibraryArtists();
                if (id === 'artists' && typeof window.syncArtistGridIndicators === 'function') window.syncArtistGridIndicators(store.state);
            }
        });
    });
}

function renderLibraryArtists() {
    if (!dom?.allArtists) return;
    const q = (dom.homeSearchInput?.value.trim() || '').toLowerCase();
    const library = store.state.library || [];
    const filtered = !q
        ? library
        : library.filter((t) => {
            const names = renderers.parseArtistNames(t.album_artist || t.artist);
            return names.some((n) => n.toLowerCase().includes(q));
        });
    renderers.renderArtistList(filtered, dom.allArtists);
    if (typeof window.syncArtistGridIndicators === 'function') window.syncArtistGridIndicators(store.state);
}

function renderHomeContent() {
    if (!dom?.allSongs) return;
    const state = store.state;
    const library = state.library || [];
    const homeQuery = dom.homeSearchInput ? dom.homeSearchInput.value.trim() : '';
    if (!homeQuery) {
        viewContext.homeTracks = null;
        renderHomeSongs(library);
        return;
    }
    const q = homeQuery.toLowerCase();
    const artistsWithTrack = renderers.getArtistsWithRepresentativeTrack(library).filter(({ name }) => name.toLowerCase().includes(q));
    const artistItems = artistsWithTrack.map(({ name, track }) => ({ type: 'artist', name, track, score: scoreArtist(name, homeQuery), sortTitle: name.toLowerCase() }));
    const trackResults = renderers.filterLibraryByQuery(library, homeQuery);
    const trackItems = trackResults.map(track => ({ type: 'track', track, score: scoreLibrary(track, homeQuery), sortTitle: (track.title || '').toLowerCase() }));
    const merged = mergeAndSortByScore([...artistItems, ...trackItems]);
    viewContext.homeTracks = merged.filter(m => m.type === 'track').map(m => m.track);
    if (merged.length === 0) {
        dom.allSongs.innerHTML = '<div class="text-center py-8 text-[var(--text-dim)]">No results</div>';
        return;
    }
    const options = { favIds: state.favorites, activeTrackId: state.currentTrack?.id };
    dom.allSongs.innerHTML = merged.map(item =>
        item.type === 'artist'
            ? renderers.buildHomeArtistRowHtml(item.name, item.track, options)
            : renderers.buildSongRowsHtml([item.track], options)
    ).join('');
}

function renderLibraryContent() {
    const tab = store.state.libraryTab || 'songs';
    if (tab === 'songs') renderHomeContent();
    else renderLibraryArtists();
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

function renderPlaylistList(state) {
    if (!dom || !dom.playlistListContainer) return;
    const query = dom.playlistSearchInput ? dom.playlistSearchInput.value.trim() : '';
    const filtered = filterPlaylistsBySearch(state.playlists || {}, query);
    const hasAny = Object.keys(state.playlists || {}).length > 0;
    const options = hasAny && Object.keys(filtered).length === 0 && query ? { emptyMessage: 'No playlists match your search.' } : {};
    renderers.renderPlaylistList(filtered, state.library || [], dom.playlistListContainer, options);
}

function renderPlaylistDetail(playlistName) {
    if (!dom || !viewContext.currentPlaylistName) return;
    const state = store.state;
    const playlists = state.playlists || {};
    const trackIds = playlists[playlistName] || [];
    const library = state.library || [];
    const tracks = trackIds.map((id) => library.find((t) => t.id === id)).filter(Boolean);
    window._currentPlaylistTracks = tracks;

    if (dom.playlistDetailTitle) dom.playlistDetailTitle.textContent = playlistName;
    if (dom.playlistDetailMeta) dom.playlistDetailMeta.textContent = tracks.length === 1 ? '1 track' : `${tracks.length} tracks`;
    const firstTrack = tracks[0];
    const coverEl = dom.playlistDetailCover;
    const iconEl = dom.playlistDetailCoverIcon;
    if (coverEl) {
        if (firstTrack) {
            const url = Resolver.getCoverUrl(firstTrack);
            coverEl.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '%22')}")` : '';
            coverEl.classList.remove('hidden');
            if (iconEl) iconEl.classList.add('hidden');
        } else {
            coverEl.style.backgroundImage = '';
            if (iconEl) {
                iconEl.classList.remove('hidden');
                coverEl.classList.remove('hidden');
            }
        }
    }
    const searchQuery = dom.playlistDetailSearchInput ? dom.playlistDetailSearchInput.value.trim() : '';
    renderers.renderPlaylistDetail(playlistName, trackIds, library, dom.playlistDetailTracks, { searchQuery });
}

window.showPlaylistDetail = (name) => {
    viewContext.currentPlaylistName = name;
    UI.showView('playlist-detail');
};

window.removeFromPlaylistTrack = (playlistName, trackId) => {
    store.removeFromPlaylist(playlistName, trackId).then(() => {
        if (UI.currentView === 'playlist-detail' && viewContext.currentPlaylistName === playlistName) renderPlaylistDetail(playlistName);
    });
};

window.createPlaylistPrompt = () => {
    const name = prompt('Playlist name');
    if (name != null && name.trim()) store.createPlaylist(name.trim());
};

window.renamePlaylistPrompt = () => {
    const current = viewContext.currentPlaylistName;
    if (!current) return;
    const newName = prompt('Rename playlist', current);
    if (newName != null && newName.trim() && newName.trim() !== current) store.renamePlaylist(current, newName.trim()).then(() => { viewContext.currentPlaylistName = newName.trim(); renderPlaylistDetail(viewContext.currentPlaylistName); });
};

window.duplicatePlaylistPrompt = () => {
    const current = viewContext.currentPlaylistName;
    if (!current) return;
    const newName = prompt('Duplicate as', `${current} (copy)`);
    if (newName != null && newName.trim()) store.duplicatePlaylist(current, newName.trim());
};

window.deletePlaylistConfirm = () => {
    const current = viewContext.currentPlaylistName;
    if (!current) return;
    if (confirm(`Delete playlist "${current}"?`)) {
        store.deletePlaylist(current).then(() => {
            viewContext.currentPlaylistName = null;
            window._currentPlaylistTracks = null;
            UI.showView('playlists');
        });
    }
};

function initPlaylistSearch() {
    if (!dom) return;
    const listInput = dom.playlistSearchInput;
    const detailInput = dom.playlistDetailSearchInput;
    if (listInput) listInput.addEventListener('input', () => { if (UI.currentView === 'playlists') renderPlaylistList(store.state); });
    if (detailInput) detailInput.addEventListener('input', () => { if (UI.currentView === 'playlist-detail' && viewContext.currentPlaylistName) renderPlaylistDetail(viewContext.currentPlaylistName); });
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
    listEl.innerHTML = names.map((name) => `<button type="button" class="add-to-playlist-picker-item w-full flex items-center gap-3 p-4 rounded-xl active:bg-[var(--surface-overlay)] text-left font-bold text-sm text-[var(--text-main)] transition-colors" data-playlist-name="${renderers.esc(name)}"><i class="fas fa-layer-group text-[var(--text-dim)] w-4"></i><span>${renderers.esc(name)}</span></button>`).join('') + `<button type="button" class="add-to-playlist-picker-item w-full flex items-center gap-3 p-4 rounded-xl active:bg-[var(--accent)]/15 text-left font-bold text-sm text-[var(--accent)] transition-colors" data-new-playlist><i class="fas fa-plus w-4"></i><span>New playlist…</span></button>`;
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
                    store.createPlaylist(newName.trim()).then(() => store.addToPlaylist(newName.trim(), tid)).then(() => UI.showToast(`Added to ${newName.trim()}`));
                }
            } else if (name) {
                store.addToPlaylist(name, tid).then(() => UI.showToast(`Added to ${name}`));
            }
        });
    });
    if (backdrop) backdrop.addEventListener('click', hide, { once: true });
    if (closeBtn) closeBtn.addEventListener('click', hide, { once: true });
    picker.classList.remove('hidden');
};

/**
 * Clear main content of a view when leaving (Option B: no heavy DOM during transition).
 * Called from ui.js showView 500ms cleanup for the OLD view.
 */
function clearContentForView(viewId) {
    if (!dom) return;
    switch (viewId) {
        case 'home':
            if (dom.allSongs) dom.allSongs.innerHTML = '';
            if (dom.allArtists) dom.allArtists.innerHTML = '';
            break;
        case 'favourites':
            if (dom.favTracks) dom.favTracks.innerHTML = '';
            break;
        case 'artist-detail':
            if (dom.artistTracks) dom.artistTracks.innerHTML = '';
            if (dom.artistAlbums) dom.artistAlbums.innerHTML = '';
            if (dom.artistDetailTitle) dom.artistDetailTitle.textContent = '';
            if (dom.artistDetailCover) {
                if (dom.artistDetailCover.tagName === 'IMG') dom.artistDetailCover.src = '';
                else dom.artistDetailCover.style.backgroundImage = '';
            }
            break;
        case 'playlists':
            if (dom.playlistListContainer) dom.playlistListContainer.innerHTML = '';
            if (dom.playlistSearchInput) dom.playlistSearchInput.value = '';
            break;
        case 'playlist-detail':
            viewContext.currentPlaylistName = null;
            window._currentPlaylistTracks = null;
            if (dom.playlistDetailTitle) dom.playlistDetailTitle.textContent = 'Playlist';
            if (dom.playlistDetailMeta) dom.playlistDetailMeta.textContent = '0 tracks';
            if (dom.playlistDetailCover) dom.playlistDetailCover.style.backgroundImage = '';
            if (dom.playlistDetailCoverIcon) dom.playlistDetailCoverIcon.classList.add('hidden');
            if (dom.playlistDetailTracks) dom.playlistDetailTracks.innerHTML = '';
            if (dom.playlistDetailSearchInput) dom.playlistDetailSearchInput.value = '';
            break;
        case 'search':
            if (typeof window.unifiedSearch !== 'undefined' && window.unifiedSearch.clear) window.unifiedSearch.clear();
            break;
        case 'settings':
            break;
        default:
            break;
    }
}

/**
 * Render content for a view after transition (Option B: content appears after slide).
 * Called from ui.js showView 500ms cleanup for the NEW view.
 */
function renderContentForView(viewId) {
    const state = store.state;
    switch (viewId) {
        case 'home':
            syncLibraryPanels();
            renderLibraryTabBar();
            renderLibraryContent();
            break;
        case 'favourites':
            renderFavourites(state);
            break;
        case 'artist-detail':
            if (viewContext.artistName) renderArtistDetail(viewContext.artistName);
            break;
        case 'search':
            import('./downloader.js').then((dm) => { dm.Downloader.init(); });
            import('./search.js').then(m => { window.unifiedSearch = m.unifiedSearch; m.unifiedSearch.init({ mobile: true }); });
            break;
        case 'playlists':
            renderPlaylistList(state);
            viewContext.currentPlaylistName = null;
            window._currentPlaylistTracks = null;
            break;
        case 'playlist-detail':
            if (viewContext.currentPlaylistName) renderPlaylistDetail(viewContext.currentPlaylistName);
            break;
        case 'settings':
            break;
        default:
            break;
    }
}

window.clearContentForView = clearContentForView;
window.renderContentForView = renderContentForView;

/**
 * Runs exit animation, toggles favourite, then store subscriber triggers applyFavFirstEntranceIfNeeded for entrance.
 */
function scheduleFavFirstAnimation(trackId, rowEl) {
    if (!trackId || !rowEl) return;
    viewContext.favFirstExitId = trackId;
    rowEl.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
    rowEl.offsetHeight;
    rowEl.style.transform = 'translateX(-100vw)';
    rowEl.addEventListener('transitionend', function onExitEnd() {
        rowEl.removeEventListener('transitionend', onExitEnd);
        store.toggleFavourite(trackId);
        viewContext.pendingFavFirstEntranceId = trackId;
        viewContext.favFirstExitId = null;
        if (rowEl.parentElement) rowEl.parentElement.classList.remove('is-swiping');
    }, { once: true });
}

function applyFavFirstEntranceIfNeeded() {
    const trackId = viewContext.pendingFavFirstEntranceId;
    if (!trackId || !dom || !dom.allSongs) return;
    const container = dom.allSongs;
    const row = container.querySelector(`.song-row[data-id="${CSS.escape(trackId)}"]`);
    if (!row) {
        viewContext.pendingFavFirstEntranceId = null;
        return;
    }
    viewContext.pendingFavFirstEntranceId = null;
    row.style.transition = 'none';
    row.style.transform = 'translateX(-100vw)';
    row.offsetHeight; // reflow
    row.style.transition = 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1)';
    row.style.transform = 'translateX(0)';
    const onEntranceEnd = () => {
        row.removeEventListener('transitionend', onEntranceEnd);
        row.style.transition = ''; // restore default from CSS
    };
    row.addEventListener('transitionend', onEntranceEnd, { once: true });
}

window.toggleArtistAlbum = (ev) => {
    const card = ev?.currentTarget?.closest?.('.artist-album-card');
    if (!card) return;
    const wasExpanded = card.classList.contains('artist-album-expanded');
    document.querySelectorAll('.artist-album-card.artist-album-expanded').forEach(c => {
        if (c !== card) c.classList.remove('artist-album-expanded');
    });
    card.classList.toggle('artist-album-expanded', !wasExpanded);
};

function initArtistScrollSuppress() {
    const artistsPanel = dom?.libraryArtists || document.getElementById('library-artists');
    if (!artistsPanel) return;
    let scrollActive = false;
    artistsPanel.addEventListener('touchstart', () => {
        scrollActive = false;
    }, { passive: true });
    artistsPanel.addEventListener('touchmove', () => {
        if (!scrollActive) {
            scrollActive = true;
            artistsPanel.classList.add('artist-scroll-active');
        }
    }, { passive: true });
    artistsPanel.addEventListener('touchend', () => {
        if (scrollActive) setTimeout(() => { artistsPanel.classList.remove('artist-scroll-active'); scrollActive = false; }, 180);
    }, { passive: true });
}

function initArtistDetailBack() {
    const backBtn = document.getElementById('artist-detail-back');
    if (!backBtn) return;
    backBtn.addEventListener('click', () => {
        store.update({ libraryTab: 'artists' });
        UI.showView('home', false);
    });
}

async function initSearch() {
    if (!dom) { setTimeout(initSearch, 100); return; }
    const input = dom.homeSearchInput;
    if (!input) {
        setTimeout(initSearch, 100);
        return;
    }

    input.oninput = () => {
        if ((store.state.libraryTab || 'songs') === 'artists') {
            renderLibraryArtists();
            return;
        }
        renderHomeContent();
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.blur();
            input.value = '';
            viewContext.homeTracks = null;
            renderLibraryContent();
        }
    });

    input.addEventListener('blur', () => UI.handleKeyboardClose());
}

async function initFavSearch() {
    if (!dom) { setTimeout(initFavSearch, 100); return; }
    const input = dom.favSearchInput;
    if (!input) {
        setTimeout(initFavSearch, 100);
        return;
    }

    input.oninput = () => {
        const state = store.state;
        const fullFavTracks = state.favorites.map(id => state.library.find(t => t.id === id)).filter(t => t);
        const query = input.value.trim().toLowerCase();
        if (!query) {
            viewContext.favTracks = fullFavTracks;
            renderSongList(fullFavTracks, 'fav-tracks');
            return;
        }
        const results = fullFavTracks.filter(t =>
            t.title.toLowerCase().includes(query) ||
            t.artist.toLowerCase().includes(query) ||
            t.album.toLowerCase().includes(query)
        );
        viewContext.favTracks = results;
        renderSongList(results, 'fav-tracks');
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.blur();
            input.value = '';
            renderFavourites(store.state);
        }
    });

    input.addEventListener('blur', () => UI.handleKeyboardClose());
}

function getCurrentTrackList() {
    const order = store.state.libraryOrder || 'date_added';
    const sorted = () => sortLibraryTracks(store.state.library, order, store.state.favorites);
    if (UI.currentView === 'home') return viewContext.homeTracks != null ? viewContext.homeTracks : sorted();
    if (UI.currentView === 'favourites') return viewContext.favTracks || store.state.library;
    if (UI.currentView === 'playlists' || UI.currentView === 'playlist-detail') return window._currentPlaylistTracks || store.state.library;
    if (UI.currentView === 'artist-detail') return viewContext.artistTracks || store.state.library;
    if (UI.currentView === 'search' && viewContext.searchTracks) return viewContext.searchTracks;
    return store.state.library;
}

/** Same context as playTrack; used by long-press to resolve track for NP. */
window.getTrackFromCurrentContext = (trackId) => {
    const context = getCurrentTrackList();
    return context && context.find(t => t.id === trackId) || null;
};

window.playTrack = (trackId) => {
    console.log("Playing track ID:", trackId);
    Haptics.tick();

    const context = getCurrentTrackList();
    const track = context && context.find(t => t.id === trackId);
    if (track) {
        audioEngine.setContext(context);
        store.update({ currentTrack: track });
        audioEngine.playTrack(track);
    }
};

// RELIABLE INIT: Run immediately if DOM is already ready
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
