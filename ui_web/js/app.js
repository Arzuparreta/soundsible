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

function renderQueue(state) {
    const containers = [
        document.getElementById('queue-tracks'),
        document.getElementById('floating-queue-tracks')
    ].filter(c => c);

    if (containers.length === 0) return;

    if (!state.queue || state.queue.length === 0) {
        containers.forEach(c => c.innerHTML = '<div class="text-gray-500 text-center py-10 italic text-xs">Queue is empty.</div>');
        return;
    }

    const html = state.queue.map((t, idx) => `
        <div class="queue-item flex items-center p-2 hover:bg-white/5 rounded-2xl transition-colors group" data-index="${idx}">
            <img src="${Resolver.getCoverUrl(t)}" class="w-10 h-10 rounded-xl shadow-lg object-cover">
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

    containers.forEach(c => c.innerHTML = html);
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
        if (indicator) indicator.classList.toggle('hidden', !isActive);

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

window.renderFavourites = renderFavourites;
window.renderQueue = renderQueue;
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

        store.subscribe((state) => {
            const currentLibJson = JSON.stringify(state.library);
            const currentFavsJson = JSON.stringify(state.favorites);
            const currentQueueJson = JSON.stringify(state.queue);
            const currentTrackId = state.currentTrack ? state.currentTrack.id : null;

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

                // 3. If ONLY the active track changed, we update highlights surgically
                if (currentTrackId !== lastTrackId) {
                    syncUIState(state);
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
            <div class="relative overflow-hidden rounded-2xl mb-2 group bg-[var(--bg-card)]">
                <div class="swipe-hints absolute inset-0 flex items-center justify-between px-8 z-0 pointer-events-none">
                    <div class="text-[var(--secondary)] font-black text-[9px] uppercase tracking-[0.2em]">Queue</div>
                    <div class="text-[var(--accent)] font-black text-[9px] uppercase tracking-[0.2em]">Favourite</div>
                </div>
                <div class="song-row relative z-10 flex items-center p-3 ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer" data-id="${t.id}" onclick="playTrack('${t.id}')">
                    <div class="relative w-12 h-12 flex-shrink-0">
                        <img src="${Resolver.getCoverUrl(t)}" class="w-full h-full object-cover rounded-xl shadow-lg border border-white/5" alt="Cover">
                        <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-[var(--accent)]/10 rounded-xl backdrop-blur-[2px] ${isActive ? '' : 'hidden'}">
                            <i class="fas fa-volume-high text-[var(--accent)] text-xs animate-pulse"></i>
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
                        <div class="artist-album-header cursor-pointer group rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/30 transition-colors active:scale-[0.98]" onclick="toggleArtistAlbum(event)">
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
    const input = document.getElementById('search-input');
    if (!input) return;

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
    const artistNames = Object.keys(byArtist).sort((a, b) => a.localeCompare(b));

    if (artistNames.length === 0) {
        container.innerHTML = `
            <div class="col-span-full flex flex-col items-center justify-center py-16 text-center">
                <i class="fas fa-user-music text-4xl text-[var(--text-dim)]/50 mb-4"></i>
                <p class="text-[var(--text-dim)] font-bold text-sm uppercase tracking-widest">No artists in library</p>
            </div>
        `;
        return;
    }

    const artistHtml = artistNames.map(name => {
        const { track: t, count } = byArtist[name];
        const trackLabel = count === 1 ? '1 track' : `${count} tracks`;
        const safeName = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `
        <div class="artist-card group cursor-pointer" data-artist-name="${esc(name)}" onclick="(function(ev){ try { var card = ev && ev.currentTarget; if (card) { card.classList.add('artist-card-tapped'); setTimeout(function(){ card.classList.remove('artist-card-tapped'); }, 220); } window.showArtistDetail && window.showArtistDetail('${safeName}'); } catch(e) {} })(event)">
            <div class="artist-card-cover relative overflow-hidden rounded-[32px] shadow-2xl transition-all ease-[cubic-bezier(0.19,1,0.22,1)] group-hover:scale-105 active:scale-95 border border-[var(--glass-border)] bg-[var(--bg-card)]" style="transition-duration: 500ms;">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full aspect-square object-cover bg-gray-900" alt="${esc(name)}">
                <div class="artist-card-overlay absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
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

window.playTrack = (trackId) => {
    console.log("Playing track ID:", trackId);
    Haptics.tick();

    let context = store.state.library;
    if (UI.currentView === 'favourites') context = window._currentFavTracks || context;
    else if (UI.currentView === 'search') context = window._currentSearchTracks || context;
    else if (UI.currentView === 'artist-detail') context = window._currentArtistTracks || context;

    const track = context.find(t => t.id === trackId);
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
