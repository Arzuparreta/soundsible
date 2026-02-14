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
        
        // Navigation Stack for 'Go Back' logic
        this.viewStack = [];
        this.currentView = 'home';

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

    static showView(viewId, saveToHistory = true) {
        if (viewId === this.currentView) return;
        
        console.log("Switching to view:", viewId);

        if (saveToHistory) {
            // Only push to history if it's not a root view or if we're drilling deeper
            const rootViews = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
            // If current is root and target is root, we clear stack to prevent infinite back-and-forth
            if (rootViews.includes(this.currentView) && rootViews.includes(viewId)) {
                this.viewStack = [];
            } else {
                this.viewStack.push(this.currentView);
            }
        }

        // Hide all views and show target
        document.querySelectorAll('.view').forEach(v => {
            v.classList.add('hidden');
        });
        
        const targetView = document.getElementById(`view-${viewId}`);
        if (targetView) {
            targetView.classList.remove('hidden');
            // Scroll content to top
            document.getElementById('content').scrollTop = 0;
            
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

        this.currentView = viewId;

        // Update active state icons/text for main nav
        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        const idx = views.indexOf(viewId);
        if (idx !== -1 && this.navButtons[idx]) {
            this.navButtons.forEach(b => {
                b.classList.remove('text-blue-500');
                b.classList.add('text-gray-500');
            });
            this.navButtons[idx].classList.add('text-blue-500');
            this.navButtons[idx].classList.remove('text-gray-500');
        }
    }

    static navigateBack() {
        if (this.viewStack.length === 0) return;
        
        const previousView = this.viewStack.pop();
        console.log("Navigating back to:", previousView);
        // showView(id, saveToHistory=false) to prevent infinite loops
        this.showView(previousView, false);
    }

    static initNav() {
        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        console.log("Initializing Nav with buttons:", this.navButtons.length);
        
        this.navButtons.forEach((btn, idx) => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showView(views[idx]);
            });
        });

        window.UI = UI; // Expose for global onclick handlers

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
        let totalMoveX = 0;
        let totalMoveY = 0;
        let activeRow = null;
        let isEdgeSwipe = false;
        const content = document.getElementById('content');

        document.addEventListener('touchstart', e => {
            const touch = e.changedTouches[0];
            const row = e.target.closest('.song-row');
            
            // EDGE SWIPE DETECTION (0-40px from left)
            // Only active if we have somewhere to go back to (stack not empty)
            if (touch.clientX < 40 && this.viewStack.length > 0) {
                isEdgeSwipe = true;
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                content.style.transition = 'none';
                return;
            }

            if (row) {
                activeRow = row;
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                totalMoveX = 0;
                totalMoveY = 0;
                row.style.transition = 'none';
            }
        }, { passive: true });

        document.addEventListener('touchmove', e => {
            const touch = e.changedTouches[0];
            const currentX = touch.clientX;
            const currentY = touch.clientY;
            const diffX = currentX - touchStartX;
            const diffY = currentY - touchStartY;
            
            if (isEdgeSwipe) {
                if (e.cancelable) e.preventDefault();
                // Slide the entire content area
                const move = Math.max(0, diffX);
                content.style.transform = `translateX(${move}px)`;
                return;
            }

            if (!activeRow) return;
            
            totalMoveX = Math.max(totalMoveX, Math.abs(diffX));
            totalMoveY = Math.max(totalMoveY, Math.abs(diffY));

            // If swiping horizontally, prevent browser from moving the page (back/forward)
            if (Math.abs(diffX) > Math.abs(diffY)) {
                if (e.cancelable) e.preventDefault();
            } else if (Math.abs(diffY) > 30) {
                // If moving vertically significantly, cancel the horizontal swipe logic
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
        }, { passive: false });

        document.addEventListener('touchend', e => {
            if (isEdgeSwipe) {
                const diffX = e.changedTouches[0].clientX - touchStartX;
                const threshold = window.innerWidth * 0.3; // 30% Threshold

                content.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                
                if (diffX > threshold) {
                    this.vibrate(50);
                    this.navigateBack();
                }
                
                content.style.transform = 'translateX(0)';
                isEdgeSwipe = false;
                return;
            }

            // SCROLL PROTECTION: If the user moved their finger significantly, 
            // it's a scroll, not a click. Block the click event.
            if (totalMoveY > 10 || totalMoveX > 10) {
                // Temporarily disable pointer events on the row to swallow the upcoming 'click' event
                const row = e.target.closest('.song-row');
                if (row) {
                    row.style.pointerEvents = 'none';
                    setTimeout(() => row.style.pointerEvents = '', 50);
                }
            }

            if (!activeRow) return;
            const touchEndX = e.changedTouches[0].screenX;
            const diffX = touchEndX - touchStartX;
            
            activeRow.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            
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
