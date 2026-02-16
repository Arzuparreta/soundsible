/**
 * Soundsible Web Player Entry Point
 */

import { store } from './store.js';
import { Resolver } from './resolver.js';
import { UI } from './ui.js';
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

window.showAlbumDetail = (albumName, artistName) => {
    const state = store.state;
    const tracks = state.library.filter(t => t.album === albumName && (t.album_artist || t.artist) === artistName);
    if (tracks.length === 0) return;

    window._currentAlbumTracks = tracks;

    // 1. Populate Header
    document.getElementById('album-detail-title').textContent = albumName;
    document.getElementById('album-detail-artist').textContent = artistName;
    document.getElementById('album-detail-cover').src = Resolver.getCoverUrl(tracks[0]);

    // 2. Render Tracks
    renderSongList(tracks, 'album-tracks');

    // 3. Switch View
    UI.showView('album-detail');
    
    // Store current view context for periodic sync
    window._currentAlbum = { name: albumName, artist: artistName };
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
        
        // 2. Perform Connection Race
        const endpoints = [...store.state.priorityList, window.location.hostname];
        const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
        console.log("NET: Probing endpoints:", uniqueEndpoints);
        await connectionManager.findActiveHost(uniqueEndpoints);
        
        // 3. Load Library Data
        console.log("DATA: Syncing library...");
        await store.syncLibrary();
        
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
                renderAlbumGrid(state.library);
                renderFavourites(state);
                renderQueue(state);
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

            // Sync current album detail if open (Always refresh this if open)
            if (window._currentAlbum && UI.currentView === 'album-detail') {
                const tracks = state.library.filter(t => 
                    t.album === window._currentAlbum.name && 
                    (t.album_artist || t.artist) === window._currentAlbum.artist
                );
                renderSongList(tracks, 'album-tracks');
            }
            
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
            renderAlbumGrid(store.state.library);
            renderFavourites(store.state);
            renderQueue(store.state);
        }

        // 5. Global Control Handlers
        const playBtn = document.getElementById('mini-play-btn');
        if (playBtn) {
            playBtn.onclick = (e) => {
                e.stopPropagation();
                audioEngine.toggle();
            };
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
    }, 30000);
}

function renderSongList(tracks, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (tracks.length === 0) {
        container.innerHTML = '<div class="text-gray-500 text-center py-10 italic">No songs found.</div>';
        return;
    }

    const activeId = store.state.currentTrack ? store.state.currentTrack.id : null;
    const favIds = store.state.favorites || [];

    const html = tracks.map(t => {
        const isActive = t.id === activeId;
        const isFav = favIds.includes(t.id);
        
        return `
            <div class="relative overflow-hidden rounded-2xl mb-2 group bg-[var(--bg-card)]">
                <!-- Swipe Hints (Subtle) -->
                <div class="absolute inset-0 flex items-center justify-between px-6 opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--accent)]/10">
                    <div class="text-[var(--secondary)] font-black text-[9px] uppercase tracking-[0.2em]">Queue</div>
                    <div class="text-[var(--accent)] font-black text-[9px] uppercase tracking-[0.2em]">Favourite</div>
                </div>

                <!-- Main Row -->
                <div class="song-row relative z-10 flex items-center p-3 ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer" data-id="${t.id}" onclick="playTrack('${t.id}')">
                    <div class="relative w-12 h-12 flex-shrink-0">
                        <img src="${Resolver.getCoverUrl(t)}" class="w-full h-full object-cover rounded-xl shadow-lg border border-white/5" alt="Cover">
                        
                        <!-- Active Indicator -->
                        <div class="active-indicator-container absolute inset-0 flex items-center justify-center bg-black/20 rounded-xl backdrop-blur-[2px] ${isActive ? '' : 'hidden'}">
                            <i class="fas fa-volume-up text-[var(--accent)] text-xs animate-pulse"></i>
                        </div>

                        <!-- Favourite Dot -->
                        <div class="fav-indicator absolute -top-1 -right-1 w-3.5 h-3.5 bg-[var(--accent)] rounded-full border-2 border-[var(--bg-card)] shadow-lg ${isFav ? '' : 'hidden'}"></div>
                    </div>
                    <div class="ml-4 flex-1 truncate">
                        <div class="song-title font-bold text-sm truncate ${isActive ? 'text-white' : 'text-[var(--text-main)]'}">${esc(t.title)}</div>
                        <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5">${esc(t.artist)}</div>
                    </div>
                    <div class="flex items-center space-x-3 ml-4">
                        <div class="text-[9px] font-black font-mono text-[var(--text-dim)] opacity-50 tracking-tighter">${formatTime(t.duration)}</div>
                        <button onclick="event.stopPropagation(); UI.showActionMenu('${t.id}')" class="w-10 h-10 flex items-center justify-center text-[var(--text-dim)] active:text-[var(--text-main)] transition-colors rounded-full active:bg-white/5 focus:outline-none">
                            <i class="fas fa-ellipsis-v text-xs"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function renderHomeSongs(tracks) {
    renderSongList(tracks, 'all-songs');
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

function renderAlbumGrid(tracks) {
    const container = document.getElementById('all-albums');
    if (!container) return;
    
    // Group strictly by album name to prevent split albums
    const albums = {};
    tracks.forEach(t => {
        const key = t.album;
        if (!albums[key]) {
            // First track found for this album name defines the display artist
            const displayArtist = t.album_artist || t.artist;
            albums[key] = { ...t, artist: displayArtist };
        } else {
            // If we found a track with a better 'album_artist', update the display artist
            if (t.album_artist && !albums[key].album_artist) {
                albums[key].artist = t.album_artist;
                albums[key].album_artist = t.album_artist;
            }
            // Keep the track with the "minimum" ID for the cover image
            if (t.id < albums[key].id) {
                const currentArtist = albums[key].artist;
                const currentAlbumArtist = albums[key].album_artist;
                Object.assign(albums[key], t);
                albums[key].artist = currentArtist;
                albums[key].album_artist = currentAlbumArtist;
            }
        }
    });

    const albumHtml = Object.values(albums).sort((a, b) => a.album.localeCompare(b.album)).map(t => `
        <div class="album-card group cursor-pointer" onclick="showAlbumDetail('${t.album.replace(/'/g, "\\'")}', '${t.artist.replace(/'/g, "\\'")}')">
            <div class="relative overflow-hidden rounded-[32px] shadow-2xl transition-all duration-500 group-hover:scale-105 active:scale-95 border border-white/5 bg-[var(--bg-card)]">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full aspect-square object-cover bg-gray-900" alt="${t.album}">
                <div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
            </div>
            <div class="mt-4 px-2">
                <div class="font-bold text-sm truncate text-[var(--text-main)] group-hover:text-[var(--accent)] transition-colors">${t.album}</div>
                <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5">${t.artist}</div>
            </div>
        </div>
    `).join('');

    container.innerHTML = albumHtml;
}

function formatTime(seconds) {
    if (!seconds) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

window.playTrack = (trackId) => {
    console.log("Playing track ID:", trackId);
    UI.vibrate(10);
    
    let context = store.state.library;
    if (UI.currentView === 'album-detail') context = window._currentAlbumTracks || context;
    else if (UI.currentView === 'favourites') context = window._currentFavTracks || context;
    else if (UI.currentView === 'search') context = window._currentSearchTracks || context;

    const track = context.find(t => t.id === trackId);
    if (track) {
        audioEngine.setContext(context);
        store.update({ currentTrack: track });
        audioEngine.playTrack(track);
    }
};

window.playAlbum = (albumName) => {
    console.log("Playing album:", albumName);
    const tracks = store.state.library.filter(t => t.album === albumName);
    if (tracks.length > 0) {
        audioEngine.playTrack(tracks[0]);
    }
};

// RELIABLE INIT: Run immediately if DOM is already ready
if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
