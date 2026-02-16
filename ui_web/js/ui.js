/**
 * UI Component Manager
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { audioEngine } from './audio.js';

// Global availability for inline onclick handlers
window.audioEngine = audioEngine;

export class UI {
    static init() {
        this.playerBar = document.getElementById('player-bar');
        this.playerTitle = document.getElementById('player-title');
        this.playerArtist = document.getElementById('player-artist');
        this.progressBar = document.getElementById('player-progress');
        this.navButtons = document.querySelectorAll('#mobile-nav button');
        
        // Navigation Stack for 'Go Back' logic
        this.viewStack = [];
        this.currentView = 'home';

        // State for Action Menu safety
        this.isInitialTouchActive = false;
        this.isNpInitialTouchActive = false;
        this.isDraggingQueue = false;

        this.initNav();
        store.subscribe((state) => this.updatePlayer(state));

        // Transport Controls Mapping
        const bindControl = (id, action) => {
            const el = document.getElementById(id);
            if (el) el.onclick = (e) => {
                e.stopPropagation();
                action();
            };
        };

        bindControl('mini-play-btn', () => audioEngine.toggle());
        bindControl('np-play-btn', () => audioEngine.toggle());
        bindControl('mini-shuffle-btn', () => store.toggleShuffle());
        bindControl('np-shuffle-btn', () => store.toggleShuffle());
        bindControl('mini-repeat-btn', () => store.toggleRepeat());
        bindControl('np-repeat-btn', () => store.toggleRepeat());

        const playerInfo = document.getElementById('player-info');
        if (playerInfo) playerInfo.onclick = () => this.showNowPlaying();
        
        // Touch Gestures
        this.initGestures();

        // --- SAFE ZOOM LOCKOUT ---
        // 1. Block multi-touch pinch-to-zoom (Safe: scrolling is 1 finger)
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1) {
                if (e.cancelable) e.preventDefault();
            }
        }, { passive: false });

        // 2. Block Safari-specific gesture scaling
        document.addEventListener('gesturestart', (e) => {
            if (e.cancelable) e.preventDefault();
        });
    }

    static updatePlayer(state) {
        if (state.currentTrack) {
            // Restore visibility: Ensure bar slides up when a track is active
            if (this.playerBar && this.playerBar.classList.contains('hidden')) {
                this.playerBar.classList.remove('hidden');
                setTimeout(() => {
                    this.playerBar.classList.replace('translate-y-full', 'translate-y-0');
                }, 10);
            }
            
            if (this.playerTitle) this.playerTitle.textContent = state.currentTrack.title;
            if (this.playerArtist) this.playerArtist.textContent = state.currentTrack.artist;
            
            // Update Cover Art
            const coverUrl = Resolver.getCoverUrl(state.currentTrack);
            const playerArt = document.getElementById('player-art');
            if (playerArt) playerArt.src = coverUrl;

            // Sync Now Playing View
            const npView = document.getElementById('now-playing-view');
            if (npView && npView.classList.contains('active')) {
                this.updateNowPlaying(state.currentTrack, state.isPlaying);
            }
            
            // Sync ALL Play Buttons
            this.updateTransportControls(state.isPlaying);
        }

        // --- Floating Queue Visibility ---
        const fab = document.getElementById('queue-fab');
        const badge = document.getElementById('queue-badge');
        const qCount = state.queue ? state.queue.length : 0;

        if (fab && badge) {
            if (qCount > 0) {
                fab.classList.replace('scale-0', 'scale-100');
                fab.classList.replace('opacity-0', 'opacity-100');
                badge.textContent = qCount;
            } else {
                fab.classList.replace('scale-100', 'scale-0');
                fab.classList.replace('opacity-100', 'opacity-0');
                this.hideQueue();
            }
        }

        // Trigger queue render if open
        const popover = document.getElementById('queue-popover');
        if (popover && !popover.classList.contains('pointer-events-none')) {
            if (window.renderQueue) window.renderQueue(state);
        }

        this.updateStatus(state);
    }

    static updateStatus(state) {
        const hostDisplay = document.getElementById('active-host-display');
        const statusLed = document.getElementById('status-led');
        const statusPulse = document.getElementById('status-led-pulse');
        const statusText = document.getElementById('server-status');
        const overlay = document.getElementById('connection-overlay');

        if (hostDisplay) hostDisplay.textContent = state.activeHost;
        
        if (statusLed && statusText) {
            if (state.isOnline) {
                statusLed.className = 'relative w-2 h-2 rounded-full bg-green-500 shadow-[0_0_12px_rgba(34,197,94,0.8)]';
                if (statusPulse) statusPulse.className = 'absolute inset-0 w-2 h-2 rounded-full bg-green-500 status-pulse';
                statusText.textContent = 'Connected';
                statusText.className = 'text-green-500 font-bold tracking-tight';
                if (overlay) overlay.classList.add('hidden');
            } else {
                statusLed.className = 'relative w-2 h-2 rounded-full bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.8)]';
                if (statusPulse) statusPulse.className = 'absolute inset-0 w-2 h-2 rounded-full bg-red-500 status-pulse';
                statusText.textContent = 'Offline';
                statusText.className = 'text-red-500 font-bold tracking-tight';
                // Only show overlay if we have a config but it's offline
                if (overlay && state.config.syncToken) overlay.classList.remove('hidden');
            }
        }
    }

    static updateNowPlaying(track, isPlaying) {
        const coverUrl = Resolver.getCoverUrl(track);
        const art = document.getElementById('np-art');
        const title = document.getElementById('np-title');
        const artist = document.getElementById('np-artist');
        const album = document.getElementById('np-album-title');

        if (art) art.src = coverUrl;
        if (title) title.textContent = track.title;
        if (artist) artist.textContent = track.artist;
        if (album) album.textContent = track.album;
        
        // Sync ALL Play Buttons & Modes
        this.updateTransportControls(isPlaying);
    }

    static showNowPlaying() {
        const track = store.state.currentTrack;
        if (!track) return;
        
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;

        // Ensure visible before animation
        npView.classList.remove('hidden');
        
        // PHYSICAL LOCKOUT (Swallow ghost clicks during transition)
        this.isNpInitialTouchActive = true;
        npView.style.pointerEvents = 'none';
        
        this.updateNowPlaying(track, store.state.isPlaying);
        
        // Use class-based animation
        setTimeout(() => {
            npView.classList.add('active');
        }, 10);

        if (!this._npGesturesBound) {
            this.initNowPlayingGestures();
            this._npGesturesBound = true;
        }
    }

    static hideNowPlaying() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;
        npView.classList.remove('active');
        setTimeout(() => {
            if (!npView.classList.contains('active')) npView.classList.add('hidden');
        }, 700); // Wait for transition
    }

    static initNowPlayingGestures() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;
        
        let startY = 0;
        let isDragging = false;
        let longPressTimer = null;

        const handleLongPress = () => {
            if (store.state.currentTrack) {
                this.vibrate([40, 20, 40]);
                this.showActionMenu(store.state.currentTrack.id);
            }
        };

        // DRAG-TO-CLOSE logic for the whole view
        npView.addEventListener('touchstart', (e) => {
            // Block bubbling to prevent underlying scroll
            e.stopPropagation();

            if (e.target.closest('button') || e.target.closest('#np-seek-container')) {
                // If touching a button, do NOT start long-press timer or dragging
                return;
            }
            
            startY = e.touches[0].clientY;
            isDragging = true;
            npView.style.transition = 'none';

            // Start Long-press timer if touching art or info
            if (e.target.closest('#np-art') || e.target.closest('#np-title') || e.target.closest('#np-artist')) {
                longPressTimer = setTimeout(handleLongPress, 500);
            }
        }, { passive: false });

        npView.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            
            // Critical: Block default browser scroll
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();

            const currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;

            // Cancel long-press if moved significantly
            if (Math.abs(deltaY) > 10) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }

            if (deltaY > 0) {
                npView.style.transform = `translateY(${deltaY}px)`;
            }
        }, { passive: false });

        npView.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;
            clearTimeout(longPressTimer);
            
            // Re-enable CSS transitions for the snap-back/dismissal
            npView.style.transition = '';

            const currentY = e.changedTouches[0].clientY;
            const deltaY = currentY - startY;
            const threshold = window.innerHeight * 0.2;

            if (deltaY > threshold) {
                this.hideNowPlaying();
            } else {
                // Remove the manual drag offset
                npView.style.transform = '';
            }
        }, { passive: false });
    }

    static toggleQueue() {
        const popover = document.getElementById('queue-popover');
        if (!popover) return;

        const isHidden = popover.classList.contains('hidden');
        if (!isHidden) {
            this.hideQueue();
        } else {
            popover.classList.remove('hidden');
            // Small delay to allow 'hidden' removal to register before animation starts
            setTimeout(() => {
                popover.classList.remove('pointer-events-none');
                popover.classList.replace('scale-90', 'scale-100');
                popover.classList.replace('opacity-0', 'opacity-100');
                popover.style.pointerEvents = 'auto';
            }, 10);
            if (window.renderQueue) window.renderQueue(store.state);
            this.initQueueDragReorder();
        }
    }

    static hideQueue() {
        const popover = document.getElementById('queue-popover');
        if (!popover || popover.classList.contains('hidden')) return;
        
        popover.classList.add('pointer-events-none');
        popover.style.pointerEvents = 'none';
        popover.classList.replace('scale-100', 'scale-90');
        popover.classList.replace('opacity-100', 'opacity-0');
        
        // Wait for animation to finish before adding 'hidden'
        setTimeout(() => {
            popover.classList.add('hidden');
        }, 400);
    }

    static showView(viewId, saveToHistory = true) {
        if (viewId === this.currentView) return;
        
        console.log("Switching to view:", viewId);

        if (saveToHistory) {
            const rootViews = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
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
            const content = document.getElementById('content');
            if (content) content.scrollTop = 0;
            
            if (viewId === 'favourites' && window.renderFavourites) window.renderFavourites(store.state);

            if (['home', 'search', 'albums', 'favourites'].includes(viewId)) {
                setTimeout(() => store.syncLibrary(), 50);
            }

            if (viewId === 'downloader') {
                import('./downloader.js').then(({ Downloader }) => {
                    Downloader.init();
                });
            }
        }

        this.currentView = viewId;

        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        const idx = views.indexOf(viewId);
        if (idx !== -1 && this.navButtons && this.navButtons[idx]) {
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
        this.showView(previousView, false);
    }

    static initNav() {
        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        
        if (this.navButtons) {
            this.navButtons.forEach((btn, idx) => {
                btn.onclick = (e) => {
                    e.preventDefault();
                    this.showView(views[idx]);
                };
            });
        }

        // --- Seek Listeners ---
        const handleSeek = (e, container) => {
            const rect = container.getBoundingClientRect();
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            if (clientX === undefined) return;
            const x = clientX - rect.left;
            const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
            import('./audio.js').then(({ audioEngine }) => audioEngine.seek(percent));
        };

        const miniBar = document.getElementById('player-progress-container');
        const fullBar = document.getElementById('np-seek-container');

        if (miniBar) {
            miniBar.onclick = (e) => handleSeek(e, miniBar);
        }
        if (fullBar) {
            fullBar.onclick = (e) => handleSeek(e, fullBar);
            fullBar.ontouchmove = (e) => handleSeek(e, fullBar);
        }

        // --- Audio Time Update Listener ---
        window.addEventListener('audio:timeupdate', (e) => {
            const { progress, currentTime, duration } = e.detail;
            
            const npBar = document.getElementById('np-seek-bar');
            if (npBar) npBar.style.width = `${progress}%`;
            
            const currTimeLabel = document.getElementById('np-time-curr');
            const totalTimeLabel = document.getElementById('np-time-total');
            if (currTimeLabel) currTimeLabel.textContent = this.formatTime(currentTime);
            if (totalTimeLabel) totalTimeLabel.textContent = this.formatTime(duration);
        });

        document.body.style.overscrollBehaviorX = 'none';
        const content = document.getElementById('content');
        if (content) content.style.overscrollBehaviorX = 'none';

        // Global functions for overlay
        window.showConnectionRefiner = () => {
            const el = document.getElementById('connection-overlay');
            if (el) el.classList.remove('hidden');
        };
        window.hideConnectionRefiner = () => {
            const el = document.getElementById('connection-overlay');
            if (el) el.classList.add('hidden');
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

        // --- GLOBAL CLICK DISMISSAL ---
        window.addEventListener('click', (e) => {
            const queueContainer = document.getElementById('queue-container');
            if (queueContainer && !queueContainer.contains(e.target)) {
                this.hideQueue();
            }
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

    static initGestures() {
        let touchStartX = 0;
        let touchStartY = 0;
        let totalMoveX = 0;
        let totalMoveY = 0;
        let activeRow = null;
        let isEdgeSwipe = false;
        let longPressTimer = null;
        let touchStartTime = 0;
        let touchCancelTimer = null;
        const content = document.getElementById('content');

        const resetGestureState = () => {
            if (longPressTimer) clearTimeout(longPressTimer);
            if (touchCancelTimer) clearTimeout(touchCancelTimer);
            longPressTimer = null;
            touchCancelTimer = null;
            if (activeRow) {
                activeRow.style.transform = 'translateX(0)';
                activeRow.classList.remove('border-blue-500/50', 'border-yellow-500/50', 'opacity-50');
            }
            activeRow = null;
        };

        document.addEventListener('touchstart', e => {
            const touch = e.changedTouches[0];
            const row = e.target.closest('.song-row');
            
            // EDGE SWIPE DETECTION
            if (touch.clientX < 40 && this.viewStack.length > 0) {
                isEdgeSwipe = true;
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                if (content) content.style.transition = 'none';
                return;
            }

            if (row) {
                activeRow = row;
                touchStartX = touch.clientX;
                touchStartY = touch.clientY;
                totalMoveX = 0;
                totalMoveY = 0;
                touchStartTime = Date.now();
                row.style.transition = 'none';

                row.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                };

                touchCancelTimer = setTimeout(() => {
                    if (activeRow) {
                        this.vibrate(10);
                        activeRow.classList.add('opacity-50');
                        setTimeout(() => resetGestureState(), 200);
                    }
                }, 2000);

                longPressTimer = setTimeout(() => {
                    if (activeRow && Math.abs(totalMoveX) < 15 && Math.abs(totalMoveY) < 15) {
                        if (touchCancelTimer) clearTimeout(touchCancelTimer);
                        const trackId = activeRow.getAttribute('data-id');
                        this.isInitialTouchActive = true;
                        this.vibrate([40, 20, 40]);
                        this.showActionMenu(trackId);
                        activeRow = null;
                    }
                }, 500);
            }
        }, { passive: true });

        window.addEventListener('touchend', () => {
            if (this.isInitialTouchActive) {
                this.isInitialTouchActive = false;
                const sheet = document.getElementById('action-menu-sheet');
                if (sheet) {
                    setTimeout(() => {
                        sheet.style.pointerEvents = 'auto';
                    }, 100);
                }
            }

            if (this.isNpInitialTouchActive) {
                this.isNpInitialTouchActive = false;
                const npView = document.getElementById('now-playing-view');
                if (npView) {
                    setTimeout(() => {
                        npView.style.pointerEvents = 'auto';
                    }, 100);
                }
            }
        }, { passive: true });

        document.addEventListener('touchmove', e => {
            const touch = e.changedTouches[0];
            const diffX = touch.clientX - touchStartX;
            const diffY = touch.clientY - touchStartY;
            
            totalMoveX = Math.max(totalMoveX, Math.abs(diffX));
            totalMoveY = Math.max(totalMoveY, Math.abs(diffY));

            if (isEdgeSwipe) {
                if (e.cancelable) e.preventDefault();
                const move = Math.max(0, diffX);
                if (content) content.style.transform = `translateX(${move}px)`;
                return;
            }

            if (!activeRow) return;
            
            if (totalMoveX > 10 || totalMoveY > 10) {
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }

            if (Math.abs(diffY) > Math.abs(diffX) && Math.abs(diffY) > 5) {
                resetGestureState();
                return;
            }

            if (Math.abs(diffX) > 10) {
                if (e.cancelable) e.preventDefault();
            } else {
                return;
            }
            
            const move = Math.max(Math.min(diffX, 100), -100);
            activeRow.style.transform = `translateX(${move}px)`;
            
            if (move < -70) {
                activeRow.classList.add('border-blue-500/50');
                activeRow.classList.remove('border-yellow-500/50');
            } else if (move > 70) {
                activeRow.classList.add('border-yellow-500/50');
                activeRow.classList.remove('border-blue-500/50');
            } else {
                activeRow.classList.remove('border-blue-500/50', 'border-yellow-500/50');
            }
        }, { passive: false });

        document.addEventListener('touchend', e => {
            if (touchCancelTimer) clearTimeout(touchCancelTimer);
            if (longPressTimer) clearTimeout(longPressTimer);

            if (isEdgeSwipe) {
                const diffX = e.changedTouches[0].clientX - touchStartX;
                const threshold = window.innerWidth * 0.3;

                if (content) {
                    content.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                    if (diffX > threshold) {
                        this.vibrate(50);
                        this.navigateBack();
                    }
                    content.style.transform = 'translateX(0)';
                }
                isEdgeSwipe = false;
                return;
            }

            if (!activeRow) return;
            const diffX = e.changedTouches[0].clientX - touchStartX;
            const touchDuration = Date.now() - touchStartTime;
            
            activeRow.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            
            if (Math.abs(diffX) > 70) {
                const trackId = activeRow.getAttribute('data-id');
                if (diffX < -70) {
                    const wasInQueue = store.state.queue.some(t => t.id === trackId);
                    this.vibrate(50);
                    store.toggleQueue(trackId).then(success => {
                        if (success) this.showToast(wasInQueue ? "Removed from Queue" : "Added to Queue");
                    });
                } else {
                    const wasFav = store.state.favorites.includes(trackId);
                    this.vibrate(50);
                    store.toggleFavourite(trackId);
                    this.showToast(wasFav ? "Removed from Favourites" : "Added to Favourites");
                }
                activeRow.style.transform = 'translateX(0)';
            } else if (totalMoveX < 10 && totalMoveY < 10 && touchDuration < 500) {
                const trackId = activeRow.getAttribute('data-id');
                window.playTrack(trackId);
                activeRow.style.transform = 'translateX(0)';
            } else {
                activeRow.style.transform = 'translateX(0)';
            }
            
            activeRow.classList.remove('border-blue-500/50', 'border-yellow-500/50', 'opacity-50');
            activeRow = null;
        }, { passive: true });
    }

    static showActionMenu(trackId) {
        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.currentActionTrack = track;

        const title = document.getElementById('action-track-title');
        const artist = document.getElementById('action-track-artist');
        const art = document.getElementById('action-track-art');

        if (title) title.textContent = track.title;
        if (artist) artist.textContent = track.artist;
        if (art) art.src = Resolver.getCoverUrl(track);

        const isFav = store.state.favorites.includes(trackId);
        const favText = document.getElementById('action-fav-text');
        if (favText) favText.textContent = isFav ? 'Remove from Favourites' : 'Add to Favourites';
        const favIcon = document.querySelector('#action-fav i');
        if (favIcon) favIcon.className = isFav ? 'fas fa-heart text-yellow-400' : 'far fa-heart text-yellow-400';

        const menu = document.getElementById('action-menu');
        const sheet = document.getElementById('action-menu-sheet');
        
        if (sheet) sheet.style.pointerEvents = 'none';
        this.isInitialTouchActive = true;
        
        if (menu) menu.classList.add('active');

        if (!this._actionMenuBound) {
            const overlay = document.getElementById('action-menu-overlay');
            if (overlay) overlay.onclick = () => this.hideActionMenu();
            this.initBottomSheetGestures();
            
            const qBtn = document.getElementById('action-queue');
            if (qBtn) qBtn.onclick = async () => {
                const wasInQueue = store.state.queue.some(t => t.id === this.currentActionTrack.id);
                const success = await store.toggleQueue(this.currentActionTrack.id);
                if (success) this.showToast(wasInQueue ? "Removed from Queue" : "Added to Queue");
                this.hideActionMenu();
            };
            const eBtn = document.getElementById('action-edit-metadata');
            if (eBtn) eBtn.onclick = () => {
                this.hideActionMenu();
                this.showMetadataEditor(this.currentActionTrack.id);
            };
            const fBtn = document.getElementById('action-fav');
            if (fBtn) fBtn.onclick = () => {
                const wasFav = store.state.favorites.includes(this.currentActionTrack.id);
                store.toggleFavourite(this.currentActionTrack.id);
                this.showToast(wasFav ? "Removed from Favourites" : "Added to Favourites");
                this.hideActionMenu();
            };
            const dBtn = document.getElementById('action-delete');
            if (dBtn) dBtn.onclick = () => {
                if (confirm(`Delete "${this.currentActionTrack.title}" permanently?`)) {
                    store.deleteTrack(this.currentActionTrack.id);
                }
                this.hideActionMenu();
            };
            this._actionMenuBound = true;
        }
    }

    static initQueueDragReorder() {
        const container = document.getElementById('floating-queue-tracks');
        if (!container) return;

        let draggingEl = null;
        let startY = 0;
        let initialIndex = -1;
        let longPressTimer = null;
        let itemHeight = 0;
        let currentIndex = -1;

        container.addEventListener('touchstart', (e) => {
            const item = e.target.closest('.queue-item');
            if (!item || e.target.closest('button')) return;

            item.oncontextmenu = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                return false;
            };

            startY = e.touches[0].clientY;
            
            longPressTimer = setTimeout(() => {
                draggingEl = item;
                const siblings = [...container.querySelectorAll('.queue-item')];
                initialIndex = siblings.indexOf(draggingEl);
                currentIndex = initialIndex;
                itemHeight = draggingEl.offsetHeight + 12;
                
                this.vibrate([40, 20, 40]);
                draggingEl.classList.add('dragging');
                UI.isDraggingQueue = true;
                document.body.style.overflow = 'hidden';
            }, 400); 
        }, { passive: true });

        container.addEventListener('touchmove', (e) => {
            if (!draggingEl) {
                const currentY = e.touches[0].clientY;
                if (Math.abs(currentY - startY) > 10) clearTimeout(longPressTimer);
                return;
            }

            if (e.cancelable) e.preventDefault();
            const currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;

            draggingEl.style.transform = `translateY(${deltaY}px) scale(1.05)`;

            const moveOffset = Math.round(deltaY / itemHeight);
            const siblings = [...container.querySelectorAll('.queue-item')];
            const newIndex = Math.max(0, Math.min(siblings.length - 1, initialIndex + moveOffset));

            if (newIndex !== currentIndex) {
                currentIndex = newIndex;
                siblings.forEach((sib, idx) => {
                    if (sib === draggingEl) return;
                    sib.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
                    if (initialIndex < currentIndex) {
                        sib.style.transform = (idx > initialIndex && idx <= currentIndex) ? `translateY(-${itemHeight}px)` : '';
                    } else if (initialIndex > currentIndex) {
                        sib.style.transform = (idx < initialIndex && idx >= currentIndex) ? `translateY(${itemHeight}px)` : '';
                    } else {
                        sib.style.transform = '';
                    }
                });
            }
        }, { passive: false });

        container.addEventListener('touchend', async (e) => {
            clearTimeout(longPressTimer);
            if (!draggingEl) return;

            document.body.style.overflow = '';
            const siblings = [...container.querySelectorAll('.queue-item')];
            siblings.forEach(sib => {
                sib.style.transform = '';
                sib.style.transition = '';
            });
            
            draggingEl.classList.remove('dragging');
            UI.isDraggingQueue = false;

            if (initialIndex !== currentIndex) {
                if (currentIndex >= siblings.length - 1) {
                    container.appendChild(draggingEl);
                } else {
                    const targetSib = siblings[currentIndex + (currentIndex > initialIndex ? 1 : 0)];
                    container.insertBefore(draggingEl, targetSib);
                }
                await store.reorderQueue(initialIndex, currentIndex);
            } else {
                if (window.renderQueue) window.renderQueue(store.state);
            }
            draggingEl = null;
        }, { passive: true });
    }

    static initBottomSheetGestures() {
        const sheet = document.getElementById('action-menu-sheet');
        if (!sheet) return;
        let startY = 0;
        let currentY = 0;
        let isDragging = false;

        sheet.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            isDragging = true;
            sheet.style.transition = 'none';
        }, { passive: true });

        sheet.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;
            if (deltaY > 0) sheet.style.transform = `translateY(${deltaY}px)`;
        }, { passive: true });

        sheet.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;
            const deltaY = currentY - startY;
            const threshold = sheet.offsetHeight * 0.2;
            sheet.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            if (deltaY > threshold) {
                this.hideActionMenu();
            } else {
                sheet.style.transform = 'translateY(0)';
            }
        }, { passive: true });
    }

    static hideActionMenu() {
        const menu = document.getElementById('action-menu');
        if (menu) menu.classList.remove('active');
    }

    static updateTransportControls(isPlaying) {
        const playBtnIcons = [
            document.querySelector('#mini-play-btn i'),
            document.querySelector('#np-play-btn i')
        ].filter(i => i);

        playBtnIcons.forEach(icon => {
            if (isPlaying) {
                icon.className = icon.closest('#np-play-btn') ? 'fas fa-pause text-4xl' : 'fas fa-pause text-lg';
            } else {
                icon.className = icon.closest('#np-play-btn') ? 'fas fa-play text-4xl ml-1' : 'fas fa-play text-lg ml-0.5';
            }
        });

        const mode = store.state.repeatMode;
        const repeatBtns = [document.getElementById('np-repeat-btn'), document.getElementById('mini-repeat-btn')].filter(b => b);
        const oneIndicators = [document.getElementById('np-repeat-one-indicator'), document.getElementById('mini-repeat-one-indicator')].filter(i => i);

        repeatBtns.forEach(btn => {
            if (mode === 'off') {
                btn.classList.remove('text-blue-500');
                btn.classList.add('text-gray-500');
            } else {
                btn.classList.add('text-blue-500');
                btn.classList.remove('text-gray-500');
            }
        });

        oneIndicators.forEach(ind => ind.classList.toggle('hidden', mode !== 'one'));
    }

    static showMetadataEditor(trackId) {
        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.editingTrack = track;
        this.selectedCoverUrl = null;

        const title = document.getElementById('edit-title');
        const artist = document.getElementById('edit-artist');
        const album = document.getElementById('edit-album');
        const preview = document.getElementById('edit-cover-preview');
        const status = document.getElementById('edit-status');

        if (title) title.value = track.title;
        if (artist) artist.value = track.artist;
        if (album) album.value = track.album;
        if (preview) preview.src = Resolver.getCoverUrl(track);
        
        const results = document.getElementById('auto-fetch-results');
        if (results) results.classList.add('hidden');
        if (status) {
            status.textContent = '';
            status.className = 'text-xs text-center min-h-[1rem]';
        }

        const modal = document.getElementById('metadata-editor');
        const overlay = document.getElementById('metadata-editor-overlay');
        const content = document.getElementById('metadata-editor-content');

        if (modal) {
            modal.classList.remove('hidden');
            setTimeout(() => {
                if (overlay) overlay.classList.replace('opacity-0', 'opacity-100');
                if (content) {
                    content.classList.replace('scale-95', 'scale-100');
                    content.classList.replace('opacity-0', 'opacity-100');
                }
            }, 10);
        }

        if (!this._editorBound) {
            const afBtn = document.getElementById('edit-auto-fetch-btn');
            const upBtn = document.getElementById('edit-upload-btn');
            const fInp = document.getElementById('edit-file-input');
            const svBtn = document.getElementById('edit-save-btn');

            if (afBtn) afBtn.onclick = () => this.performAutoFetch();
            if (upBtn) upBtn.onclick = () => fInp && fInp.click();
            if (fInp) fInp.onchange = (e) => this.handleCoverUpload(e);
            if (svBtn) svBtn.onclick = () => this.saveMetadata();
            this._editorBound = true;
        }
    }

    static hideMetadataEditor() {
        const modal = document.getElementById('metadata-editor');
        const overlay = document.getElementById('metadata-editor-overlay');
        const content = document.getElementById('metadata-editor-content');

        if (overlay) overlay.classList.replace('opacity-100', 'opacity-0');
        if (content) {
            content.classList.replace('scale-100', 'scale-95');
            content.classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => modal && modal.classList.add('hidden'), 300);
    }

    static async performAutoFetch() {
        const title = document.getElementById('edit-title')?.value;
        const artist = document.getElementById('edit-artist')?.value;
        const query = `${artist} ${title}`.trim();
        if (!query) return;

        const resultsDiv = document.getElementById('auto-fetch-results');
        const listDiv = document.getElementById('auto-fetch-list');
        const loading = document.getElementById('edit-cover-loading');

        if (loading) loading.classList.remove('hidden');
        const results = await store.searchMetadata(query);
        if (loading) loading.classList.add('hidden');

        if (results.length === 0) {
            alert("No suggestions found.");
            return;
        }

        if (listDiv) {
            listDiv.innerHTML = results.map((res, i) => `
                <div class="flex items-center space-x-3 p-2 hover:bg-gray-800 rounded-lg cursor-pointer transition-colors" onclick="UI.selectSuggestion(${i})">
                    <img src="${res.artwork_url}" class="w-10 h-10 rounded shadow object-cover">
                    <div class="flex-1 truncate">
                        <div class="text-xs font-bold truncate">${res.track_name}</div>
                        <div class="text-[10px] text-gray-500 truncate">${res.artist_name} • ${res.album_name}</div>
                    </div>
                </div>
            `).join('');
        }

        this.suggestions = results;
        if (resultsDiv) resultsDiv.classList.remove('hidden');
    }

    static selectSuggestion(index) {
        const res = this.suggestions[index];
        if (!res) return;

        const title = document.getElementById('edit-title');
        const artist = document.getElementById('edit-artist');
        const album = document.getElementById('edit-album');
        const preview = document.getElementById('edit-cover-preview');

        if (title) title.value = res.track_name;
        if (artist) artist.value = res.artist_name;
        if (album) album.value = res.album_name;
        if (preview) preview.src = res.artwork_url;
        this.selectedCoverUrl = res.artwork_url;
        
        const results = document.getElementById('auto-fetch-results');
        if (results) results.classList.add('hidden');
    }

    static handleCoverUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const preview = document.getElementById('edit-cover-preview');
            if (preview) preview.src = event.target.result;
            this.selectedFile = file;
            this.selectedCoverUrl = null;
        };
        reader.readAsDataURL(file);
    }

    static async saveMetadata() {
        const saveBtn = document.getElementById('edit-save-btn');
        const status = document.getElementById('edit-status');
        
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.classList.add('opacity-50');
        }
        if (status) {
            status.textContent = "Updating Station library... This takes a moment.";
            status.className = "text-xs text-center text-blue-400 animate-pulse";
        }

        const metadata = {
            title: document.getElementById('edit-title')?.value.trim(),
            artist: document.getElementById('edit-artist')?.value.trim(),
            album: document.getElementById('edit-album')?.value.trim()
        };

        let success = true;

        if (this.selectedFile) {
            success = await store.uploadCover(this.editingTrack.id, this.selectedFile);
            this.selectedFile = null;
        }

        if (success) {
            success = await store.updateMetadata(this.editingTrack.id, metadata, this.selectedCoverUrl);
        }

        if (success) {
            if (status) {
                status.textContent = "✓ Success! Library refreshed.";
                status.className = "text-xs text-center text-green-500 font-bold";
            }
            setTimeout(() => {
                this.hideMetadataEditor();
                if (saveBtn) {
                    saveBtn.disabled = false;
                    saveBtn.classList.remove('opacity-50');
                }
            }, 1000);
        } else {
            if (status) {
                status.textContent = "❌ Update failed. Check Station logs.";
                status.className = "text-xs text-center text-red-500 font-bold";
            }
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.classList.remove('opacity-50');
            }
        }
    }

    static vibrate(ms) {
        if (navigator.vibrate) navigator.vibrate(ms);
    }

    static formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    static showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `flex items-center space-x-3 bg-gray-800 border border-gray-700 px-6 py-4 rounded-2xl shadow-2xl transform translate-y-10 opacity-0 transition-all duration-500`;
        
        let icon = '<i class="fas fa-info-circle text-blue-400"></i>';
        if (message.toLowerCase().includes('queue')) icon = '<i class="fas fa-list-ul text-blue-400"></i>';
        if (message.toLowerCase().includes('favourite') || message.toLowerCase().includes('liked')) icon = '<i class="fas fa-heart text-yellow-400"></i>';
        
        toast.innerHTML = `
            <div class="flex-shrink-0">${icon}</div>
            <div class="text-sm font-bold text-white">${message}</div>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.replace('translate-y-10', 'translate-y-0');
            toast.classList.replace('opacity-0', 'opacity-100');
        }, 10);

        setTimeout(() => {
            toast.classList.replace('translate-y-0', 'translate-y-10');
            toast.classList.replace('opacity-100', 'opacity-0');
            setTimeout(() => toast.remove(), 500);
        }, 3000);
    }
}
window.UI = UI;
