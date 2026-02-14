/**
 * UI Component Manager
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';

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

    static updatePlayer(state) {
        if (state.currentTrack) {
            this.playerBar.classList.remove('translate-y-[200%]');
            this.playerTitle.textContent = state.currentTrack.title;
            this.playerArtist.textContent = state.currentTrack.artist;
            
            // Update Cover Art
            const playerArt = document.getElementById('player-art');
            if (playerArt) {
                playerArt.src = Resolver.getCoverUrl(state.currentTrack);
            }
            
            const icon = this.playBtn.querySelector('i');
            if (state.isPlaying) {
                icon.className = 'fas fa-pause';
            } else {
                icon.className = 'fas fa-play';
            }
        }

        this.updateStatus(state);
    }

    static updateStatus(state) {
        const hostDisplay = document.getElementById('active-host-display');
        const statusLed = document.getElementById('status-led');
        const statusText = document.getElementById('server-status');
        const overlay = document.getElementById('connection-overlay');

        if (hostDisplay) hostDisplay.textContent = state.activeHost;
        
        if (statusLed && statusText) {
            if (state.isOnline) {
                statusLed.className = 'w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]';
                statusText.textContent = 'Connected';
                statusText.className = 'text-green-500 font-medium';
                if (overlay) overlay.classList.add('hidden');
            } else {
                statusLed.className = 'w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]';
                statusText.textContent = 'Offline';
                statusText.className = 'text-red-500 font-medium';
                // Only show overlay if we have a config but it's offline
                if (overlay && state.config.syncToken) overlay.classList.remove('hidden');
            }
        }
    }

    static initNav() {
        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
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
                    
                    // Background Sync: Proactively fetch latest data without blocking UI transition
                    if (['home', 'search', 'albums', 'favourites'].includes(viewId)) {
                        setTimeout(() => store.syncLibrary(), 50);
                    }

                    // Lazy init downloader if switching to downloader view
                    if (viewId === 'downloader') {
                        import('./downloader.js').then(({ Downloader }) => {
                            Downloader.init();
                        });
                    }
                }
            });
        });

        // Add overscroll-behavior-x: none to the body to prevent Safari bounce
        document.body.style.overscrollBehaviorX = 'none';
        document.getElementById('content').style.overscrollBehaviorX = 'none';

        // Global functions for overlay
        window.showConnectionRefiner = () => {
            document.getElementById('connection-overlay').classList.remove('hidden');
        };
        window.hideConnectionRefiner = () => {
            document.getElementById('connection-overlay').classList.add('hidden');
        };

        const reconnectBtn = document.getElementById('reconnect-btn');
        const manualInput = document.getElementById('manual-ip-input');
        if (reconnectBtn && manualInput) {
            reconnectBtn.onclick = async () => {
                const ip = manualInput.value.trim();
                if (!ip) return;
                
                reconnectBtn.textContent = "Probing...";
                reconnectBtn.disabled = true;
                
                const { connectionManager } = await import('./connection.js');
                const success = await connectionManager.findActiveHost([ip]);
                if (success) {
                    store.update({ priorityList: [ip, ...store.state.priorityList] });
                    store.save('priority_list', store.state.priorityList);
                    store.syncLibrary();
                    window.hideConnectionRefiner();
                } else {
                    alert("Station not found at that address.");
                }
                reconnectBtn.textContent = "Connect to Station";
                reconnectBtn.disabled = false;
            };
        }

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

    static initGestures() {
        let touchStartX = 0;
        let touchStartY = 0;
        let activeRow = null;

        document.addEventListener('touchstart', e => {
            const row = e.target.closest('.song-row');
            if (row) {
                activeRow = row;
                touchStartX = e.changedTouches[0].screenX;
                touchStartY = e.changedTouches[0].screenY;
                row.style.transition = 'none';
            }
        }, { passive: true });

        document.addEventListener('touchmove', e => {
            if (!activeRow) return;
            const currentX = e.changedTouches[0].screenX;
            const currentY = e.changedTouches[0].screenY;
            const diffX = currentX - touchStartX;
            const diffY = Math.abs(currentY - touchStartY);
            
            // If swiping horizontally, prevent browser from moving the page (back/forward)
            if (Math.abs(diffX) > diffY) {
                if (e.cancelable) e.preventDefault();
            } else if (diffY > 10) {
                // If moving vertically, cancel the horizontal swipe logic
                activeRow.style.transform = 'translateX(0)';
                activeRow = null;
                return;
            }
            
            // Allow swiping both ways
            const move = Math.max(Math.min(diffX, 100), -100);
            activeRow.style.transform = `translateX(${move}px)`;
            
            // Show visual hints if far enough
            if (move < -70) {
                activeRow.classList.add('border-red-500/50');
                activeRow.classList.remove('border-yellow-500/50');
            } else if (move > 70) {
                activeRow.classList.add('border-yellow-500/50');
                activeRow.classList.remove('border-red-500/50');
            } else {
                activeRow.classList.remove('border-red-500/50', 'border-yellow-500/50');
            }
        }, { passive: true });

        document.addEventListener('touchend', e => {
            if (!activeRow) return;
            const touchEndX = e.changedTouches[0].screenX;
            const diffX = touchEndX - touchStartX;
            
            activeRow.style.transition = 'transform 0.3s ease';
            
            if (diffX < -70) {
                // DELETE (Left Swipe)
                const trackId = activeRow.getAttribute('data-id');
                const title = activeRow.querySelector('.song-title').textContent;
                
                if (confirm(`Delete "${title}" permanently from Station?`)) {
                    this.vibrate(100);
                    store.deleteTrack(trackId).then(success => {
                        if (!success) {
                            activeRow.style.transform = 'translateX(0)';
                            alert("Deletion failed.");
                        }
                    });
                } else {
                    activeRow.style.transform = 'translateX(0)';
                }
            } else if (diffX > 70) {
                // FAVOURITE (Right Swipe)
                const trackId = activeRow.getAttribute('data-id');
                this.vibrate(50);
                store.toggleFavourite(trackId).then(success => {
                    activeRow.style.transform = 'translateX(0)';
                    if (!success) alert("Favourite toggle failed.");
                });
            } else {
                activeRow.style.transform = 'translateX(0)';
            }
            
            activeRow.classList.remove('border-red-500/50', 'border-yellow-500/50');
            activeRow = null;
        }, { passive: true });
    }

    static vibrate(ms) {
        if (navigator.vibrate) navigator.vibrate(ms);
    }
}
