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

console.log("🚀 Soundsible Web Player Initializing...");

/**
 * Security: Escape HTML characters to prevent XSS.
 * This ensures that strings like "<script>" are rendered as text 
 * and never executed as code by the browser.
 */
function esc(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderFavourites(state) {
    const favTracks = state.favorites.map(id => state.library.find(t => t.id === id)).filter(t => t);
    window._currentFavTracks = favTracks;
    renderSongList(favTracks, 'fav-tracks');
}

function updateQueueScrollCuePosition() {
    const floatingQueue = document.getElementById('floating-queue-tracks');
    if (!floatingQueue) return;
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
    const containers = [
        document.getElementById('queue-tracks'),
        document.getElementById('floating-queue-tracks')
    ].filter(c => c);

    if (containers.length === 0) return;

    if (!state.queue || state.queue.length === 0) {
        containers.forEach(c => c.innerHTML = '<div class="text-gray-500 text-center py-10 italic text-xs">Queue is empty.</div>');
        const floatingQueue = document.getElementById('floating-queue-tracks');
        if (floatingQueue) {
            floatingQueue.classList.remove('has-scroll-cue');
            const cue = floatingQueue.querySelector('.queue-scroll-cue');
            if (cue && cue.parentNode) cue.parentNode.removeChild(cue);
        }
        return;
    }

    const html = state.queue.map((t, idx) => `
        <div class="queue-item flex items-center p-2 hover:bg-white/5 rounded-[var(--radius-omni-sm)] transition-colors group" data-index="${idx}">
            <div class="queue-item-cover w-10 h-10 flex-shrink-0 rounded-[var(--radius-omni-sm-inset)] overflow-hidden">
                <img src="${Resolver.getCoverUrl(t)}" class="queue-item-cover-img w-full h-full rounded-[var(--radius-omni-sm-inset)] shadow-lg object-cover" alt="Queue cover">
            </div>
            <div class="ml-3 flex-1 truncate pointer-events-none">
                <div class="font-bold text-[13px] truncate text-white/90">${esc(t.title)}</div>
                <div class="text-[10px] text-gray-500 truncate uppercase tracking-widest">${esc(t.artist)}</div>
            </div>
            <div class="flex items-center space-x-2">
                <button onclick="playTrack('${t.id}')" class="w-10 h-10 flex items-center justify-center bg-blue-500/10 text-blue-400 rounded-full hover:bg-blue-500/20 active:scale-90 transition-all">
                    <i class="fas fa-play text-xs"></i>
                </button>
                <button onclick="store.removeFromQueue(${idx})" class="w-10 h-10 flex items-center justify-center bg-white/5 text-gray-500 rounded-full hover:bg-red-500/10 hover:text-red-400 active:scale-90 transition-all">
                    <i class="fas fa-times text-xs"></i>
                </button>
            </div>
        </div>
    `).join('');

    containers.forEach(c => {
        c.innerHTML = html;
        const floatingQueue = document.getElementById('floating-queue-tracks');
        if (floatingQueue && c === floatingQueue) {
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
                floatingQueue.addEventListener('scroll', () => {
                    requestAnimationFrame(updateQueueScrollCuePosition);
                }, { passive: true });
                window.addEventListener('resize', () => {
                    requestAnimationFrame(updateQueueScrollCuePosition);
                });
            }
        }
    });
}

const QUEUE_HOLD_MS = 280;
const QUEUE_MOVE_THRESHOLD_PX = 14;
const QUEUE_CANCEL_THRESHOLD_PX = 30;
const QUEUE_DROP_FADE_MS = 170;
const QUEUE_AUTO_SCROLL_THRESHOLD_PX = 60;
const QUEUE_AUTO_SCROLL_STEP_PX = 4;
const QUEUE_AUTO_SCROLL_INTERVAL_MS = 16;

function initQueueDrag() {
    const container = document.getElementById('floating-queue-tracks');
    if (!container) return;

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
        const cont = document.getElementById('floating-queue-tracks');
        if (!cont) return;
        cont.querySelectorAll('.queue-item.queue-drop-target').forEach(el => el.classList.remove('queue-drop-target'));
    }

    function setDropTarget(index) {
        if (index == null) return;
        const cont = document.getElementById('floating-queue-tracks');
        if (!cont) return;
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
        const cont = document.getElementById('floating-queue-tracks');
        if (!cont || !clone || !originalItem) return fromIndex;
        
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
            title.classList.toggle('text-white', isActive);
            title.classList.toggle('text-[var(--text-main)]', !isActive);
        }
    });
}

/** Normalize artist name for comparison (trim + lower). */
function normalizeArtistName(name) {
    return (name || '').trim().toLowerCase();
}

/**
 * Surgical Artist Grid Sync: Updates playing indicators on artist cards without full re-render.
 */
function syncArtistGridIndicators(state) {
    // Only update if artists view is visible
    if (UI.currentView !== 'artists') return;

    const currentTrack = state.currentTrack;
    const isPlaying = state.isPlaying;
    const raw = currentTrack && isPlaying ? (currentTrack.album_artist || currentTrack.artist) : '';
    const currentTrackArtistsSet = new Set(
        parseArtistNames(raw).map(n => normalizeArtistName(n))
    );

    const artistCards = document.querySelectorAll('.artist-card');
    artistCards.forEach(card => {
        const artistName = card.getAttribute('data-artist-name');
        const isCurrentlyPlaying = currentTrackArtistsSet.has(normalizeArtistName(artistName));
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
window.store = store;
window.audioEngine = audioEngine;

window.showArtistDetail = (artistName) => {
    window._currentArtistName = artistName;
    renderArtistDetail(artistName);
    UI.showView('artist-detail');
};

// INITIALIZATION ERROR HANDLER
window.addEventListener('error', (e) => {
    console.error("GLOBAL ERROR:", e.error);
    const loader = document.getElementById('initial-loader');
    if (loader) {
        loader.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => loader.remove(), 1000);
    }
});

async function init() {
    console.log("🚀 Soundsible App Init Sequence Started...");
    
    try {
        // 1. Initialize UI First (Navigation, Player Bar)
        console.log("UI: Initializing...");
        UI.init();
        initSearch();
        initArtistScrollSuppress();
        initQueueDrag();
        // #region agent log
        fetch('http://127.0.0.1:7390/ingest/5e87ad09-2e12-436a-ac69-c14c6b45cb46', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ed9dd2' }, body: JSON.stringify({ sessionId: 'ed9dd2', runId: 'init', hypothesisId: 'H_media', location: 'app.js:init', message: 'hover:none media', data: { hoverNone: typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches }, timestamp: Date.now() }) }).catch(() => {});
        // #endregion
        // 2. Perform Connection Race
        const endpoints = [...store.state.priorityList, window.location.hostname];
        const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
        console.log("NET: Probing endpoints:", uniqueEndpoints);
        await connectionManager.findActiveHost(uniqueEndpoints);
        
        // 3. Load Library Data (Non-blocking)
        console.log("DATA: Starting background library sync...");
        store.syncLibrary();
        
        // 3. Subscribe to state changes for re-rendering (Optimized)
        let lastLibraryJson = null; // Force first render in subscription
        let lastFavsJson = JSON.stringify(store.state.favorites);
        let lastQueueJson = JSON.stringify(store.state.queue);
        let lastTrackId = store.state.currentTrack ? store.state.currentTrack.id : null;
        let lastIsPlaying = store.state.isPlaying;

        store.subscribe((state) => {
            const currentLibJson = JSON.stringify(state.library);
            const currentFavsJson = JSON.stringify(state.favorites);
            const currentQueueJson = JSON.stringify(state.queue);
            const currentTrackId = state.currentTrack ? state.currentTrack.id : null;
            const currentIsPlaying = state.isPlaying;

            // --- SMART RE-RENDERING LOGIC ---
            
            // 1. If the entire Library changed (e.g. metadata sync), we must re-render all
            if (currentLibJson !== lastLibraryJson) {
                console.log("Library synced, full re-render.");
                renderHomeSongs(state.library);
                renderArtistList(state.library);
                renderFavourites(state);
                renderQueue(state);
                if (UI.currentView === 'artist-detail' && window._currentArtistName) {
                    renderArtistDetail(window._currentArtistName);
                }
                lastLibraryJson = currentLibJson;
            } else {
                // 2. If ONLY favorites changed, we update the indicators surgically
                if (currentFavsJson !== lastFavsJson) {
                    syncUIState(state);
                    // If the user is looking at the Favourites view, we still need a full render there
                    if (UI.currentView === 'favourites') renderFavourites(state);
                }

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

            // Persist Search results if user is currently searching
            const searchInput = document.getElementById('search-input');
            if (searchInput && searchInput.value.trim() && UI.currentView === 'search') {
                const query = searchInput.value.toLowerCase();
                const results = state.library.filter(t => 
                    t.title.toLowerCase().includes(query) || 
                    t.artist.toLowerCase().includes(query) || 
                    t.album.toLowerCase().includes(query)
                );
                renderSongList(results, 'search-results');
            }
            
            lastFavsJson = currentFavsJson;
            lastQueueJson = currentQueueJson;
            lastTrackId = currentTrackId;
            lastIsPlaying = currentIsPlaying;
        });

        // 4. Initial Render (Safety check)
        if (store.state.library.length > 0) {
            console.log("DATA: Performing initial render...");
            renderHomeSongs(store.state.library);
            renderArtistList(store.state.library);
            renderFavourites(store.state);
            renderQueue(store.state);
        }
    } catch (err) {
        console.error("CRITICAL: App initialization failed:", err);
    } finally {
        // 6. Dismiss Loader (Always try to dismiss so user isn't stuck)
        console.log("UI: Sequence finished, dismissing loader.");
        const loader = document.getElementById('initial-loader');
        if (loader) {
            loader.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => loader.remove(), 1000);
        }
    }

    // 6. Periodic 'Truth' Sync (every 30 seconds)
    // Mirrored logic from GTK app to ensure mobile stays in sync even without tab switching
    setInterval(() => {
        if (store.state.isOnline) {
            console.log("Periodic Sync: Verifying library truth...");
            store.syncLibrary();
        }
    }, 300000);
}

function renderSongList(tracks, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (tracks.length === 0) {
        container.innerHTML = '<div class="text-gray-500 text-center py-10 italic">No songs found.</div>';
        return;
    }

    container.innerHTML = buildSongRowsHtml(tracks);
}

function renderHomeSongs(tracks) {
    renderSongList(tracks, 'all-songs');
}

/** Split "A, B", "A feat. B", "A + B" etc. into trimmed unique names. Single artist -> [artist]. */
function parseArtistNames(artistString) {
    if (!artistString || typeof artistString !== 'string') return [];
    const raw = artistString.trim();
    if (!raw) return [];
    const parts = raw.split(/\s*,\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+and\s+|\s+&\s+|\s+\+\s+|\s+x\s+/i)
        .map(s => s.trim())
        .filter(Boolean);
    return [...new Set(parts)];
}

function getArtistTracks(artistName) {
    return store.state.library.filter(t => {
        const names = parseArtistNames(t.album_artist || t.artist);
        return names.includes(artistName);
    });
}

function getArtistAlbums(artistName) {
    const tracks = getArtistTracks(artistName);
    const byAlbum = {};
    tracks.forEach(t => {
        const album = t.album || 'Unknown Album';
        if (!byAlbum[album]) byAlbum[album] = { tracks: [], coverTrack: t };
        byAlbum[album].tracks.push(t);
        if (t.track_number != null && (byAlbum[album].coverTrack.track_number == null || t.track_number < byAlbum[album].coverTrack.track_number)) {
            byAlbum[album].coverTrack = t;
        }
    });
    return Object.entries(byAlbum)
        .map(([album, { tracks: albumTracks, coverTrack }]) => ({
            album,
            tracks: albumTracks.sort((a, b) => (a.track_number ?? 999) - (b.track_number ?? 999)),
            coverTrack
        }))
        .sort((a, b) => a.album.localeCompare(b.album));
}

function buildSongRowsHtml(tracks) {
    const activeId = store.state.currentTrack ? store.state.currentTrack.id : null;
    const favIds = store.state.favorites || [];
    return tracks.map(t => {
        const isActive = t.id === activeId;
        const isFav = favIds.includes(t.id);
        return `
            <div class="relative overflow-hidden rounded-[var(--radius-omni-sm)] mb-2 group bg-[var(--bg-card)]">
                <div class="swipe-hints absolute inset-0 flex items-center justify-between px-8 z-0 pointer-events-none">
                    <div class="text-[var(--secondary)] font-black text-[9px] uppercase tracking-[0.2em]">Queue</div>
                    <div class="text-[var(--accent)] font-black text-[9px] uppercase tracking-[0.2em]">Favourite</div>
                </div>
                <div class="song-row relative z-10 flex items-center p-3 ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-[var(--radius-omni-sm)] border active:scale-[0.98] transition-all cursor-pointer" data-id="${t.id}" onclick="playTrack('${t.id}')">
                    <div class="relative w-12 h-12 flex-shrink-0">
                        <img src="${Resolver.getCoverUrl(t)}" class="w-full h-full object-cover rounded-xl shadow-lg border border-white/5" alt="Cover">
                        <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-xl backdrop-blur-[1.6px] transition-all duration-150 ease-out ${isActive ? 'opacity-100 is-playing' : 'opacity-0 pointer-events-none'}">
                            <i class="playing-icon fas fa-volume-high text-[var(--accent)] text-[14.4px]"></i>
                        </div>
                        <div class="fav-indicator absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--accent)] rounded-full border-2 border-[var(--bg-card)] shadow-lg ${isFav ? '' : 'hidden'}"></div>
                    </div>
                    <div class="ml-4 flex-1 truncate">
                        <div class="song-title font-bold text-sm truncate ${isActive ? 'text-white' : 'text-[var(--text-main)]'}">${esc(t.title)}</div>
                        <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5 font-mono">${esc(t.artist)}</div>
                    </div>
                    <div class="flex items-center space-x-3 ml-4">
                        <div class="text-[9px] font-bold font-mono text-[var(--text-dim)] opacity-50 tracking-tighter">${formatTime(t.duration)}</div>
                        <button onclick="event.stopPropagation(); UI.showActionMenu('${t.id}')" class="w-10 h-10 flex items-center justify-center text-[var(--text-dim)] active:text-[var(--text-main)] transition-colors rounded-full active:bg-white/5 focus:outline-none">
                            <i class="fas fa-ellipsis-v text-xs"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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

function renderArtistDetail(artistName) {
    const tracks = getArtistTracks(artistName);
    window._currentArtistTracks = tracks;
    window._currentArtistName = artistName;

    const titleEl = document.getElementById('artist-detail-title');
    const coverEl = document.getElementById('artist-detail-cover');
    if (titleEl) titleEl.textContent = artistName;
    if (coverEl) {
        const firstTrack = tracks[0];
        if (firstTrack) {
            coverEl.src = Resolver.getCoverUrl(firstTrack);
            coverEl.alt = artistName;
            coverEl.classList.remove('hidden');
        } else {
            coverEl.classList.add('hidden');
        }
    }

    const albumsContainer = document.getElementById('artist-albums');
    if (albumsContainer) {
        const albums = getArtistAlbums(artistName);
        if (albums.length === 0) {
            albumsContainer.innerHTML = '<div class="col-span-full text-[var(--text-dim)] text-center py-8 text-sm">No albums</div>';
        } else {
            albumsContainer.innerHTML = albums.map(({ album, tracks: albumTracks, coverTrack }) => {
                const trackLabel = albumTracks.length === 1 ? '1 track' : `${albumTracks.length} tracks`;
                return `
                    <div class="artist-album-card flex flex-col" data-album="${esc(album)}">
                        <div class="artist-album-header cursor-pointer group rounded-[var(--radius-omni-sm)] border border-[var(--glass-border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/30 transition-colors active:scale-[0.98]" onclick="toggleArtistAlbum(event)">
                            <div class="relative">
                                <img src="${Resolver.getCoverUrl(coverTrack)}" class="w-full aspect-square object-cover rounded-t-2xl border-b border-white/5" alt="${esc(album)}">
                                <div class="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-black/60 flex items-center justify-center">
                                    <i class="fas fa-chevron-down text-[10px] text-white transition-transform artist-album-chevron"></i>
                                </div>
                            </div>
                            <div class="p-3">
                                <div class="font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(album)}</div>
                                <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(trackLabel)}</div>
                            </div>
                        </div>
                        <div class="artist-album-tracks mt-2 hidden overflow-hidden">
                            ${buildSongRowsHtml(albumTracks)}
                        </div>
                    </div>
                `;
            }).join('');
        }
    }

    const tracksContainer = document.getElementById('artist-tracks');
    if (tracksContainer) {
        if (tracks.length === 0) {
            tracksContainer.innerHTML = '<div class="text-[var(--text-dim)] text-center py-10 italic text-sm">No tracks</div>';
        } else {
            const sorted = [...tracks].sort((a, b) => {
                const albumCmp = (a.album || '').localeCompare(b.album || '');
                if (albumCmp !== 0) return albumCmp;
                return (a.track_number ?? 999) - (b.track_number ?? 999);
            });
            tracksContainer.innerHTML = buildSongRowsHtml(sorted);
        }
    }
}

function _artistElDesc(el) {
    if (!el) return null;
    const card = el.closest && el.closest('.artist-card');
    const name = card ? (card.dataset?.artistName || card.querySelector('.artist-card-name')?.textContent?.trim() || '') : '';
    return { tag: el.tagName, class: (el.className || '').slice(0, 80), artist: name || null };
}

function initArtistScrollSuppress() {
    const viewArtists = document.getElementById('view-artists');
    if (!viewArtists) return;
    let scrollActive = false;
    let touchMoveCount = 0;
    const endpoint = 'http://127.0.0.1:7390/ingest/5e87ad09-2e12-436a-ac69-c14c6b45cb46';
    const logBuffer = [];
    const MAX_LOG = 50;
    const send = (phase, hypothesisId, data) => {
        const payload = { sessionId: 'ed9dd2', runId: 'touch', hypothesisId, location: 'app.js:initArtistScrollSuppress', message: 'artist touch ' + phase, data, timestamp: Date.now() };
        logBuffer.push(payload);
        if (logBuffer.length > MAX_LOG) logBuffer.shift();
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ed9dd2' }, body: JSON.stringify(payload) }).catch(() => {});
    };
    window.__getArtistTouchLog = () => JSON.stringify(logBuffer, null, 2);
    viewArtists.addEventListener('touchstart', (e) => {
        scrollActive = false;
        touchMoveCount = 0;
        if (!e.touches.length) return;
        const t = e.touches[0];
        const under = document.elementFromPoint(t.clientX, t.clientY);
        send('start', 'H_target', { x: t.clientX, y: t.clientY, target: _artistElDesc(e.target), fromPoint: _artistElDesc(under), same: e.target === under });
    }, { passive: true });
    viewArtists.addEventListener('touchmove', (e) => {
        touchMoveCount++;
        if (!scrollActive) {
            scrollActive = true;
            viewArtists.classList.add('artist-scroll-active');
        }
        if (e.touches.length && touchMoveCount <= 3) {
            const t = e.touches[0];
            const under = document.elementFromPoint(t.clientX, t.clientY);
            send('move', 'H_fromPoint', { x: t.clientX, y: t.clientY, target: _artistElDesc(e.target), fromPoint: _artistElDesc(under), moveIndex: touchMoveCount });
        }
    }, { passive: true });
    viewArtists.addEventListener('touchend', (e) => {
        if (scrollActive) setTimeout(() => { viewArtists.classList.remove('artist-scroll-active'); scrollActive = false; }, 180);
        if (!e.changedTouches.length) return;
        const t = e.changedTouches[0];
        const under = document.elementFromPoint(t.clientX, t.clientY);
        send('end', 'H_active', { x: t.clientX, y: t.clientY, target: _artistElDesc(e.target), fromPoint: _artistElDesc(under), scrollActive, same: e.target === under });
    }, { passive: true });
}

async function initSearch() {
    const input = document.getElementById('omni-search-input');
    if (!input) {
        // Retry if input not yet available (DOM might not be ready)
        setTimeout(initSearch, 100);
        return;
    }

    input.oninput = () => {
        const query = input.value.toLowerCase();
        const results = store.state.library.filter(t => 
            t.title.toLowerCase().includes(query) || 
            t.artist.toLowerCase().includes(query) || 
            t.album.toLowerCase().includes(query)
        );
        window._currentSearchTracks = results;
        renderSongList(results, 'search-results');
    };

    // Keyboard dismissal handling
    input.addEventListener('blur', () => {
        // Don't transform away if user is still on search view
        // The transform will happen when navigating away
    });

    input.addEventListener('keydown', (e) => {
        // ESC key: dismiss keyboard and exit search form
        if (e.key === 'Escape') {
            input.blur();
            if (window.UI && window.UI.currentView === 'search') {
                window.UI.transformFromSearchForm();
                window.UI.showView('home', false);
            }
        }
    });
}

function renderArtistList(tracks) {
    const container = document.getElementById('all-artists');
    if (!container) return;

    // One card per parsed artist; multi-artist strings (e.g. "A, B", "A feat. B") become separate artists; count = tracks where this artist appears
    const byArtist = {};
    tracks.forEach(t => {
        const raw = t.album_artist || t.artist;
        const names = parseArtistNames(raw);
        names.forEach(name => {
            if (!byArtist[name]) byArtist[name] = { track: t, count: 0 };
            byArtist[name].count += 1;
            if (t.id < byArtist[name].track.id) byArtist[name].track = t;
        });
    });
    const artistNames = Object.keys(byArtist).sort((a, b) => byArtist[b].count - byArtist[a].count || a.localeCompare(b));

    if (artistNames.length === 0) {
        container.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-16 text-center">
                <i class="fas fa-user-music text-4xl text-[var(--text-dim)]/50 mb-4"></i>
                <p class="text-[var(--text-dim)] font-bold text-sm uppercase tracking-widest">No artists in library</p>
            </div>
        `;
        return;
    }

    // Get current playing track's artists (normalized for comparison)
    const currentTrack = store.state.currentTrack;
    const isPlaying = store.state.isPlaying;
    const currentTrackArtistsSet = new Set(
        (currentTrack && isPlaying ? parseArtistNames(currentTrack.album_artist || currentTrack.artist) : []).map(n => normalizeArtistName(n))
    );

    const artistHtml = artistNames.map(name => {
        const { track: t, count } = byArtist[name];
        const trackLabel = count === 1 ? '1 track' : `${count} tracks`;
        const safeName = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const isCurrentlyPlaying = currentTrackArtistsSet.has(normalizeArtistName(name));
        return `
        <div class="artist-card group cursor-pointer" data-artist-name="${esc(name)}" onclick="(function(ev){ try { var card = ev && ev.currentTarget; if (card) { card.classList.add('artist-card-tapped'); setTimeout(function(){ card.classList.remove('artist-card-tapped'); }, 220); } window.showArtistDetail && window.showArtistDetail('${safeName}'); } catch(e) {} })(event)">
            <div class="artist-card-cover relative overflow-hidden rounded-[var(--radius-omni-sm)] shadow-2xl transition-all ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:scale-105 active:scale-95 border border-[var(--glass-border)] bg-[var(--bg-card)]" style="transition-duration: 500ms;">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full aspect-square object-cover bg-gray-900" alt="${esc(name)}">
                <div class="artist-card-overlay absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-[32px] backdrop-blur-[1.6px] transition-all duration-150 ease-out ${isCurrentlyPlaying ? 'opacity-100 is-playing' : 'opacity-0 pointer-events-none'}">
                    <i class="playing-icon fas fa-volume-high text-[var(--accent)] text-[14.4px]"></i>
                </div>
            </div>
            <div class="mt-4 px-2">
                <div class="artist-card-name font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${esc(name)}</div>
                <div class="text-[10px] font-mono text-[var(--text-dim)] truncate mt-0.5">${esc(trackLabel)}</div>
            </div>
        </div>
    `;
    }).join('');

    container.innerHTML = artistHtml;
}

function formatTime(seconds) {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

window.getTrackFromCurrentContext = (trackId) => {
    let context = store.state.library;
    if (UI.currentView === 'favourites') context = window._currentFavTracks || context;
    else if (UI.currentView === 'search') context = window._currentSearchTracks || context;
    else if (UI.currentView === 'artist-detail') context = window._currentArtistTracks || context;
    return context?.find(t => t.id === trackId);
};

window.playTrack = (trackId) => {
    console.log("Playing track ID:", trackId);
    Haptics.tick();

    const track = window.getTrackFromCurrentContext(trackId);
    if (track) {
        let context = store.state.library;
        if (UI.currentView === 'favourites') context = window._currentFavTracks || context;
        else if (UI.currentView === 'search') context = window._currentSearchTracks || context;
        else if (UI.currentView === 'artist-detail') context = window._currentArtistTracks || context;
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
