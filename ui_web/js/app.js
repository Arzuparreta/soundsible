/**
 * Soundsible Web Player Entry Point
 */

import { store } from './store.js';
import { Resolver } from './resolver.js';
import { UI } from './ui.js';
import { audioEngine } from './audio.js';

console.log("🚀 Soundsible Web Player Initializing...");

async function init() {
    console.log("App Ready");
    
    // 1. Initialize UI First (Navigation, Player Bar)
    UI.init();
    
    // 2. Load Library Data
    await store.syncLibrary();
    
    // 3. Subscribe to state changes for re-rendering
    store.subscribe((state) => {
        renderLibrary(state.library);
    });

    // 4. Initial Render
    renderLibrary(store.state.library);

    // 5. Global Control Handlers
    const playBtn = document.getElementById('play-btn');
    if (playBtn) {
        playBtn.onclick = (e) => {
            e.stopPropagation();
            audioEngine.toggle();
        };
    }
}

function renderLibrary(tracks) {
    const homeContainer = document.getElementById('recent-albums');
    const albumContainer = document.getElementById('all-albums');
    if (!homeContainer || !albumContainer) return;
    
    // Group by album
    const albums = {};
    tracks.forEach(t => {
        if (!albums[t.album]) albums[t.album] = t;
    });

    const albumHtml = Object.values(albums).map(t => `
        <div class="album-card group cursor-pointer" onclick="playAlbum('${t.album}')">
            <div class="relative overflow-hidden rounded-xl shadow-lg transition-transform duration-300 group-hover:scale-105">
                <img src="assets/icons/icon-192.png" class="w-full aspect-square object-cover bg-gray-800" alt="${t.album}">
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

    homeContainer.innerHTML = albumHtml;
    albumContainer.innerHTML = albumHtml;
}

window.playAlbum = (albumName) => {
    console.log("Playing album:", albumName);
    const tracks = store.state.library.filter(t => t.album === albumName);
    if (tracks.length > 0) {
        audioEngine.playTrack(tracks[0]);
    }
};

window.addEventListener('DOMContentLoaded', init);
