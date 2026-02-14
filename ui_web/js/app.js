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
    renderSongList(favTracks, 'fav-tracks');
}

window.showAlbumDetail = (albumName, artistName) => {
    const state = store.state;
    const tracks = state.library.filter(t => t.album === albumName && t.artist === artistName);
    if (tracks.length === 0) return;

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

async function init() {
    console.log("App Ready");
    
    // 1. Initialize UI First (Navigation, Player Bar)
    UI.init();
    initSearch();
    
    // 2. Perform Connection Race
    const endpoints = [...store.state.priorityList, window.location.hostname];
    const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
    await connectionManager.findActiveHost(uniqueEndpoints);
    
    // 3. Load Library Data
    await store.syncLibrary();
    
    // 3. Subscribe to state changes for re-rendering (Optimized)
    let lastLibraryJson = JSON.stringify(store.state.library);
    let lastFavsJson = JSON.stringify(store.state.favorites);
    let lastTrackId = store.state.currentTrack ? store.state.currentTrack.id : null;

    store.subscribe((state) => {
        const currentLibJson = JSON.stringify(state.library);
        const currentFavsJson = JSON.stringify(state.favorites);
        const currentTrackId = state.currentTrack ? state.currentTrack.id : null;

        // Re-render if library, favourites, OR the active track changes
        if (currentLibJson !== lastLibraryJson || 
            currentFavsJson !== lastFavsJson || 
            currentTrackId !== lastTrackId) {
            
            console.log("Data changed, refreshing all views...");
            renderHomeSongs(state.library);
            renderAlbumGrid(state.library);
            renderFavourites(state);
            
            // Sync current album detail if open
            if (window._currentAlbum) {
                const tracks = state.library.filter(t => 
                    t.album === window._currentAlbum.name && 
                    t.artist === window._currentAlbum.artist
                );
                renderSongList(tracks, 'album-tracks');
            }
            
            // Persist Search results if user is currently searching
            const searchInput = document.getElementById('search-input');
            if (searchInput && searchInput.value.trim()) {
                const query = searchInput.value.toLowerCase();
                const results = state.library.filter(t => 
                    t.title.toLowerCase().includes(query) || 
                    t.artist.toLowerCase().includes(query) || 
                    t.album.toLowerCase().includes(query)
                );
                renderSongList(results, 'search-results');
            }
            
            lastLibraryJson = currentLibJson;
            lastFavsJson = currentFavsJson;
            lastTrackId = currentTrackId;
        }
    });

    // 4. Initial Render
    renderHomeSongs(store.state.library);
    renderAlbumGrid(store.state.library);
    renderFavourites(store.state);

    // 5. Global Control Handlers
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.onclick = (e) => {
            e.stopPropagation();
            audioEngine.toggle();
        };
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

    const favIds = store.state.favorites || [];
    const activeId = store.state.currentTrack ? store.state.currentTrack.id : null;

    const html = tracks.map(t => {
        const isFav = favIds.includes(t.id);
        const isActive = t.id === activeId;
        
        return `
            <div class="relative overflow-hidden rounded-xl bg-gray-800/50 group">
                <!-- Swipe Backgrounds (Hidden behind row) -->
                <div class="absolute inset-0 flex items-center justify-between px-6">
                    <div class="text-yellow-500 font-bold text-xs">FAVOURITE</div>
                    <div class="text-red-500 font-bold text-xs">DELETE</div>
                </div>
                
                <!-- Main Song Row -->
                <div class="song-row flex items-center p-3 ${isActive ? 'bg-black' : 'bg-gray-900'} cursor-pointer relative z-10 border border-transparent touch-pan-y" data-id="${t.id}" onclick="playTrack('${t.id}')">
                    <div class="relative w-12 h-12 flex-shrink-0">
                        <img src="${Resolver.getCoverUrl(t)}" class="w-full h-full object-cover rounded-lg shadow-md" alt="Cover">
                        <!-- Active Indicator Overlay (No more play icon on hover) -->
                        <div class="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-lg ${isActive ? 'opacity-100' : 'opacity-0'} transition-opacity">
                            ${isActive ? '<i class="fas fa-volume-up text-white text-xs"></i>' : ''}
                        </div>
                        <!-- Favourite Indicator -->
                        ${isFav ? `<div class="absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full border-2 border-gray-900 shadow-sm"></div>` : ''}
                    </div>
                    <div class="ml-4 flex-1 truncate">
                        <div class="song-title font-semibold text-sm truncate ${isActive ? 'text-blue-400' : ''} transition-colors">${esc(t.title)}</div>
                        <div class="text-xs text-gray-400 truncate uppercase tracking-tighter mt-0.5">${esc(t.artist)} • ${esc(t.album)}</div>
                    </div>
                    <div class="text-xs text-gray-500 font-mono ml-4 tabular-nums">${formatTime(t.duration)}</div>
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
        renderSongList(results, 'search-results');
    };
}

function renderAlbumGrid(tracks) {
    const container = document.getElementById('all-albums');
    if (!container) return;
    
    // Group by album + artist (to match GTK logic)
    const albums = {};
    tracks.forEach(t => {
        const key = `${t.album} - ${t.artist}`;
        if (!albums[key]) {
            albums[key] = t;
        } else {
            // Keep the track with the "minimum" ID to match GTK's SQL MIN(id) logic
            if (t.id < albums[key].id) {
                albums[key] = t;
            }
        }
    });

    const albumHtml = Object.values(albums).sort((a, b) => a.album.localeCompare(b.album)).map(t => `
        <div class="album-card group cursor-pointer" onclick="showAlbumDetail('${t.album.replace(/'/g, "\\'")}', '${t.artist.replace(/'/g, "\\'")}')">
            <div class="relative overflow-hidden rounded-xl shadow-lg transition-transform duration-300 group-hover:scale-105">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full aspect-square object-cover bg-gray-800" alt="${t.album}">
            </div>
            <div class="mt-3">
                <div class="font-semibold text-sm truncate">${t.album}</div>
                <div class="text-xs text-gray-400 truncate">${t.artist}</div>
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
    const track = store.state.library.find(t => t.id === trackId);
    if (track) {
        // Immediate State Update (Triggers reactive highlight via bg-black)
        store.update({ currentTrack: track });
        // Then start audio engine
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

window.addEventListener('DOMContentLoaded', init);
