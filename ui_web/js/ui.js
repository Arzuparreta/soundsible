/**
 * UI Component Manager
 */
import { store } from './store.js';

export class UI {
    static init() {
        this.playerBar = document.getElementById('player-bar');
        this.playerTitle = document.getElementById('player-title');
        this.playerArtist = document.getElementById('player-artist');
        this.playBtn = document.getElementById('play-btn');
        this.progressBar = document.getElementById('player-progress');
        this.navButtons = document.querySelectorAll('#mobile-nav button');

        this.initNav();
        store.subscribe((state) => this.updatePlayer(state));
        
        // Touch Gestures
        this.initGestures();
    }

    static initNav() {
        const views = ['home', 'search', 'albums', 'favourites', 'settings'];
        console.log("Initializing Nav with buttons:", this.navButtons.length);
        
        this.navButtons.forEach((btn, idx) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                const viewId = views[idx];
                console.log("Switching to view:", viewId);

                // Update active state icons/text
                this.navButtons.forEach(b => {
                    b.classList.remove('text-blue-500');
                    b.classList.add('text-gray-500');
                });
                btn.classList.add('text-blue-500');
                btn.classList.remove('text-gray-500');

                // Hide all views and show target
                document.querySelectorAll('.view').forEach(v => {
                    v.classList.add('hidden');
                });
                
                const targetView = document.getElementById(`view-${viewId}`);
                if (targetView) {
                    targetView.classList.remove('hidden');
                }
            });
        });

        // Token Import Handler
        const importBtn = document.getElementById('import-token-btn');
        const tokenInput = document.getElementById('sync-token-input');
        if (importBtn && tokenInput) {
            importBtn.onclick = () => {
                const token = tokenInput.value.trim();
                if (store.importToken(token)) {
                    alert("✓ Library Linked! Syncing tracks...");
                    store.syncLibrary();
                } else {
                    alert("❌ Invalid Token");
                }
            };
        }
    }

    static updatePlayer(state) {
        if (!state.currentTrack) return;

        this.playerBar.classList.remove('translate-y-[200%]');
        this.playerTitle.textContent = state.currentTrack.title;
        this.playerArtist.textContent = state.currentTrack.artist;
        
        const icon = this.playBtn.querySelector('i');
        if (state.isPlaying) {
            icon.className = 'fas fa-pause';
        } else {
            icon.className = 'fas fa-play';
        }
    }

    static initGestures() {
        let touchStartX = 0;
        let touchStartY = 0;

        document.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, false);

        document.addEventListener('touchend', e => {
            const touchEndX = e.changedTouches[0].screenX;
            const touchEndY = e.changedTouches[0].screenY;
            this.handleGesture(touchStartX, touchEndX, touchStartY, touchEndY, e.target);
        }, false);
    }

    static handleGesture(startX, endX, startY, endY, target) {
        const diffX = endX - startX;
        const diffY = endY - startY;

        // Thresholds
        if (Math.abs(diffX) > 100) {
            if (diffX > 0) {
                console.log("Swipe Right (Queue)");
                this.vibrate(50);
            } else {
                console.log("Swipe Left (Favorite)");
                this.vibrate(50);
            }
        }
    }

    static vibrate(ms) {
        if (navigator.vibrate) navigator.vibrate(ms);
    }
}
