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

async function init() {
    console.log("App Ready");
    
    // 1. Initialize UI First (Navigation, Player Bar)
    UI.init();
    
    // 2. Perform Connection Race
    const endpoints = [...store.state.priorityList, window.location.hostname];
    const uniqueEndpoints = [...new Set(endpoints)].filter(e => e);
    await connectionManager.findActiveHost(uniqueEndpoints);
    
    // 3. Load Library Data
    await store.syncLibrary();
    
    // 3. Subscribe to state changes for re-rendering
    store.subscribe((state) => {
        renderHomeSongs(state.library);
        renderAlbumGrid(state.library);
    });

    // 4. Initial Render
    renderHomeSongs(store.state.library);
    renderAlbumGrid(store.state.library);

    // 5. Global Control Handlers
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.onclick = (e) => {
            e.stopPropagation();
            audioEngine.toggle();
        };
    }
}

function renderHomeSongs(tracks) {
    const container = document.getElementById('all-songs');
    if (!container) return;

    if (tracks.length === 0) {
        container.innerHTML = '<div class="text-gray-500 text-center py-10 italic">No songs found.</div>';
        return;
    }

    const html = tracks.map(t => `
        <div class="flex items-center p-3 hover:bg-gray-800 rounded-xl cursor-pointer transition-colors group" onclick="playTrack('${t.id}')">
            <div class="relative w-12 h-12 flex-shrink-0">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full h-full object-cover rounded-lg shadow-md" alt="Cover">
                <div class="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                    <i class="fas fa-play text-white text-xs"></i>
                </div>
            </div>
            <div class="ml-4 flex-1 truncate">
                <div class="font-semibold text-sm truncate group-hover:text-blue-400 transition-colors">${t.title}</div>
                <div class="text-xs text-gray-400 truncate uppercase tracking-tighter mt-0.5">${t.artist} • ${t.album}</div>
            </div>
            <div class="text-xs text-gray-500 font-mono ml-4 tabular-nums">${formatTime(t.duration)}</div>
        </div>
    `).join('');

    container.innerHTML = html;
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
        <div class="album-card group cursor-pointer" onclick="playAlbum('${t.album}')">
            <div class="relative overflow-hidden rounded-xl shadow-lg transition-transform duration-300 group-hover:scale-105">
                <img src="${Resolver.getCoverUrl(t)}" class="w-full aspect-square object-cover bg-gray-800" alt="${t.album}">
                <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-20 flex items-center justify-center transition-all duration-300">
                    <div class="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center opacity-0 transform translate-y-4 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300 shadow-xl">
                        <i class="fas fa-play text-white ml-1"></i>
                    </div>
                </div>
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
