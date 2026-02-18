/**
 * UI Component Manager
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { audioEngine } from './audio.js';
import { Haptics } from './haptics.js';

// Global availability for inline onclick handlers
window.audioEngine = audioEngine;

export class UI {
    static VIEW_LABELS = {
        'home': 'ALL SONGS',
        'favourites': 'FAVORITES',
        'artists': 'ARTISTS',
        'artist-detail': 'ARTIST',
        'search': 'SEARCH',
        'downloader': 'ODST',
        'settings': 'CONFIG'
    };

    static init() {
        console.log("UI: Initializing Omni-Island Core...");
        this.content = document.getElementById('content');
        
        // Platform Detection: Notch Safety
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad Pro
        if (isIOS) document.body.classList.add('is-ios');

        // Navigation State
        this.viewStack = [];
        this.currentView = 'home';
        this._npGesturesBound = false;
        this.isIslandActive = false;
        this.isBlooming = false;

        this.initGlobalListeners();
        this.initOmniIsland();
        this.updateLabel(this.currentView);
        store.subscribe((state) => this.updatePlayer(state));

        // INTERRUPTION RECOVERY: If app backgrounds or loses focus during a gesture, reset the island.
        // This prevents the island from being stuck in "nav mode" if an iOS system gesture interrupts.
        const resetEvents = ['visibilitychange', 'blur', 'contextmenu'];
        resetEvents.forEach(evt => {
            window.addEventListener(evt, () => {
                this.resetOmniIsland();
            });
        });

        // Gestures Engine
        this.initGestures();
    }

    static updateLabel(viewId) {
        const label = document.getElementById('omni-label');
        if (label) {
            label.textContent = this.VIEW_LABELS[viewId] || '';
            label.classList.remove('hovered');
            label.classList.add('docked');
            label.style.removeProperty('transform');
            label.style.setProperty('--tx', '0px');
            label.style.opacity = '1';
        }
    }

    static updatePlayer(state) {
        // Omni-Island State Sync
        this.syncIsland(state);

        if (state.currentTrack) {
            if (document.getElementById('now-playing-view')?.classList.contains('active')) {
                this.updateNowPlaying(state.currentTrack, state.isPlaying);
            }
            this.updateTransportControls(state.isPlaying);
        }

        // Floating Queue
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

        this.updateStatus(state);
        this.updateThemeUI(state.theme);
        this.updateHapticsUI(state.hapticsEnabled);
    }

    static syncIsland(state) {
        if (!this.island) return;
        
        if (state.currentTrack && !this.isIslandActive) {
            this.morphToActive();
        } else if (!state.currentTrack && this.isIslandActive) {
            this.collapseToSeed();
        }

        // Real-time UI Sync
        const anchorIcon = document.getElementById('omni-anchor-icon');
        if (this.isIslandActive && anchorIcon) {
            anchorIcon.className = state.isPlaying ? 'fas fa-pause text-lg text-white' : 'fas fa-play text-lg text-white ml-1';
            this.updateMetadataScroller(state.currentTrack);
        }
    }

    static updateMetadataScroller(track) {
        if (!track) return;
        const container = document.getElementById('omni-metadata-container');
        const scroller = document.getElementById('omni-metadata');
        const text1 = document.getElementById('omni-text-1');
        const text2 = document.getElementById('omni-text-2');
        if (!container || !scroller || !text1 || !text2) return;

        // Escape function for safety since we're using innerHTML
        const esc = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

        const titleHtml = `<span class="text-white/40">${esc(track.title)}</span>`;
        const restHtml = ` • ${esc(track.artist)} • ${esc(track.album)} • `;
        const contentHtml = titleHtml + restHtml;
        
        // Simple comparison to avoid DOM thrashing
        if (text1.innerHTML === contentHtml) return;

        text1.innerHTML = contentHtml;
        text2.innerHTML = contentHtml;
        container.style.opacity = '1';

        // Marquee Logic
        const textWidth = text1.offsetWidth;

        if (textWidth > 150) { // If it's more than a small stub
            scroller.style.animation = `omni-marquee ${textWidth * 0.05}s linear infinite`;
        } else {
            scroller.style.animation = 'none';
        }
    }

    static morphToActive() {
        this.isIslandActive = true;
        Haptics.heavy();
        
        this.island.style.width = '250px';
        
        const prev = document.getElementById('omni-prev');
        const next = document.getElementById('omni-next');
        const anchorIcon = document.getElementById('omni-anchor-icon');

        if (prev) { prev.classList.remove('hidden'); setTimeout(() => { prev.classList.replace('opacity-0', 'opacity-100'); prev.classList.replace('scale-75', 'scale-100'); }, 100); }
        if (next) { next.classList.remove('hidden'); setTimeout(() => { next.classList.replace('opacity-0', 'opacity-100'); next.classList.replace('scale-75', 'scale-100'); }, 100); }
        
        if (anchorIcon) anchorIcon.className = store.state.isPlaying ? 'fas fa-pause text-lg text-white' : 'fas fa-play text-lg text-white ml-1';
    }

    static collapseToSeed() {
        this.isIslandActive = false;
        this.island.style.width = '56px';
        
        const prev = document.getElementById('omni-prev');
        const next = document.getElementById('omni-next');
        const anchorIcon = document.getElementById('omni-anchor-icon');

        if (prev) { prev.classList.replace('opacity-100', 'opacity-0'); prev.classList.replace('scale-100', 'scale-75'); setTimeout(() => prev.classList.add('hidden'), 300); }
        if (next) { next.classList.replace('opacity-100', 'opacity-0'); next.classList.replace('scale-100', 'scale-75'); setTimeout(() => next.classList.add('hidden'), 300); }
        
        if (anchorIcon) anchorIcon.className = 'fas fa-command text-lg text-white';
    }

    static updateThemeUI(theme) {
        const indicator = document.getElementById('theme-indicator');
        if (indicator) {
            indicator.style.transform = theme === 'dark' ? 'translateX(24px)' : 'translateX(0px)';
        }
    }

    static updateHapticsUI(enabled) {
        const indicator = document.getElementById('haptics-indicator');
        if (indicator) {
            indicator.style.transform = enabled ? 'translateX(24px)' : 'translateX(0px)';
        }
    }

    static updateStatus(state) {
        const statusLed = document.getElementById('status-led');
        const statusPulse = document.getElementById('status-led-pulse');
        const statusText = document.getElementById('server-status');
        const hostDisplay = document.getElementById('active-host-display');

        if (hostDisplay) hostDisplay.textContent = state.activeHost;
        
        if (statusLed && statusText) {
            const isOnline = state.isOnline;
            statusLed.className = `relative w-2 h-2 rounded-full bg-${isOnline ? 'green' : 'red'}-500 shadow-[0_0_12px_rgba(${isOnline ? '34,197,94' : '239,68,68'},0.8)]`;
            if (statusPulse) statusPulse.className = `absolute inset-0 w-2 h-2 rounded-full bg-${isOnline ? 'green' : 'red'}-500 status-pulse`;
            statusText.textContent = isOnline ? 'Connected' : 'Offline';
            statusText.className = `text-${isOnline ? 'green' : 'red'}-500 font-bold`;
            
            const overlay = document.getElementById('connection-overlay');
            if (overlay) {
                if (isOnline) overlay.classList.add('hidden');
                else if (state.config.syncToken) overlay.classList.remove('hidden');
            }
        }
    }

    static updateNowPlaying(track, isPlaying) {
        const el = id => document.getElementById(id);
        const art = el('np-art');
        const title = el('np-title');
        const artist = el('np-artist');
        const album = el('np-album-title');

        if (art) art.src = Resolver.getCoverUrl(track);
        if (title) title.textContent = track.title;
        if (artist) artist.textContent = track.artist;
        if (album) album.textContent = track.album;
        
        this.updateTransportControls(isPlaying);
    }

    static showNowPlaying() {
        const track = store.state.currentTrack;
        if (!track) return;
        
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;

        npView.classList.remove('hidden');
        document.body.classList.add('now-playing-open');
        this.updateNowPlaying(track, store.state.isPlaying);
        
        setTimeout(() => {
            npView.classList.add('active');
            Haptics.heavy(); // 30ms pulse for opening
        }, 10);

        // Fly-in timeline: trigger after layout so "from" state applies first
        requestAnimationFrame(() => {
            const npSeek = document.getElementById('np-seek-container');
            if (npSeek) npSeek.classList.add('np-timeline-visible');
        });

        if (!this._npGesturesBound) {
            this.initNowPlayingGestures();
            this._npGesturesBound = true;
        }
    }

    static hideNowPlaying() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;
        
        npView.classList.remove('active');
        npView.style.transform = ''; // Clear manual drag
        document.body.classList.remove('now-playing-open');
        const npSeek = document.getElementById('np-seek-container');
        if (npSeek) npSeek.classList.remove('np-timeline-visible');
        
        setTimeout(() => {
            if (!npView.classList.contains('active')) npView.classList.add('hidden');
        }, 600);
    }

    static toggleQueue() {
        const popover = document.getElementById('queue-popover');
        if (!popover) return;

        if (popover.classList.contains('hidden')) {
            popover.classList.remove('hidden');
            setTimeout(() => {
                popover.classList.remove('pointer-events-none');
                popover.style.pointerEvents = 'auto'; // Ensure interaction
                popover.classList.replace('scale-95', 'scale-100');
                popover.classList.replace('opacity-0', 'opacity-100');
            }, 10);
            if (window.renderQueue) window.renderQueue(store.state);
        } else {
            this.hideQueue();
        }
    }

    static hideQueue() {
        const popover = document.getElementById('queue-popover');
        if (!popover || popover.classList.contains('hidden')) return;
        
        popover.classList.replace('scale-100', 'scale-95');
        popover.classList.replace('opacity-100', 'opacity-0');
        popover.classList.add('pointer-events-none');
        popover.style.pointerEvents = 'none'; // Block interaction
        setTimeout(() => popover.classList.add('hidden'), 300);
    }

    static showView(viewId, saveToHistory = true, direction = 'forward') {
        // Auto-hide Now Playing if active (even if selecting the same view)
        if (document.getElementById('now-playing-view')?.classList.contains('active')) {
            this.hideNowPlaying();
        }

        if (viewId === this.currentView) return;
        
        this.updateLabel(viewId);

        const oldView = document.getElementById(`view-${this.currentView}`);
        const targetView = document.getElementById(`view-${viewId}`);
        // #region agent log
        if (!targetView) {
            fetch('http://127.0.0.1:7390/ingest/5e87ad09-2e12-436a-ac69-c14c6b45cb46', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'ed9dd2' }, body: JSON.stringify({ sessionId: 'ed9dd2', runId: 'click', hypothesisId: 'H2', location: 'ui.js:showView', message: 'showView: target view not found', data: { viewId }, timestamp: Date.now() }) }).catch(() => {});
            return;
        }
        // #endregion

        if (saveToHistory) {
            const roots = ['home', 'search', 'artists', 'downloader', 'favourites', 'settings'];
            if (roots.includes(this.currentView) && roots.includes(viewId)) this.viewStack = [];
            else this.viewStack.push(this.currentView);
        }

        // --- PERFORM STACKING TRANSITION ---
        
        // 1. Prepare Outgoing (Stays in background)
        if (oldView) {
            oldView.classList.add('view-outgoing');
        }

        // 2. Prepare Incoming (Slides OVER)
        targetView.classList.remove('hidden');
        targetView.classList.add('view-incoming');
        targetView.classList.add(direction === 'forward' ? 'view-from-right' : 'view-from-left');
        
        // Returning to artists from artist-detail: clear sticky :active from back button and suppress card feedback briefly
        const fromArtistDetail = viewId === 'artists' && this.currentView === 'artist-detail';
        if (fromArtistDetail) {
            document.activeElement?.blur?.();
            targetView.classList.add('artist-just-returned');
            setTimeout(() => targetView.classList.remove('artist-just-returned'), 320);
        }
        
        // 3. Trigger Animation (Force Reflow)
        void targetView.offsetWidth;

        setTimeout(() => {
            targetView.classList.remove('view-from-right', 'view-from-left');
            
            // Background Tasks
            const content = document.getElementById('content');
            if (content) content.scrollTop = 0;
            if (viewId === 'favourites' && window.renderFavourites) window.renderFavourites(store.state);
            if (viewId === 'downloader') import('./downloader.js').then(m => m.Downloader.init());
        }, 10);

        // 4. Cleanup after transition
        setTimeout(() => {
            if (oldView && oldView.id !== `view-${viewId}`) {
                oldView.classList.add('hidden');
                oldView.classList.remove('view-outgoing');
            }
            targetView.classList.remove('view-incoming');
        }, 500);

        this.currentView = viewId;
    }

    static navigateBack() {
        if (this.viewStack.length === 0) {
            this.showView('home', false, 'backward'); // Home fallback
            return;
        }
        
        const previousView = this.viewStack.pop();
        this.showView(previousView, false, 'backward');
    }

    static initGlobalListeners() {
        // Global: Prevent context menu everywhere for a native app feel
        window.addEventListener('contextmenu', (e) => e.preventDefault());

        // Global Clicks
        window.addEventListener('click', (e) => {
            const q = document.getElementById('queue-container');
            if (q && !q.contains(e.target)) this.hideQueue();
        });

        // Transport Handlers
        const bindTransport = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = (e) => { 
                e.stopPropagation(); 
                Haptics.tick(); // 15ms tactile feedback
                fn(); 
            };
        };

        bindTransport('mini-play-btn', () => audioEngine.toggle());
        bindTransport('mini-next-btn', () => audioEngine.next());
        bindTransport('mini-prev-btn', () => audioEngine.prev());
        
        bindTransport('mini-shuffle-btn', () => store.toggleShuffle());
        bindTransport('mini-repeat-btn', () => store.toggleRepeat());
        bindTransport('omni-shuffle-btn', () => store.toggleShuffle());
        bindTransport('omni-repeat-btn', () => store.toggleRepeat());

        // Seek
        const handleSeek = (e, container) => {
            const rect = container.getBoundingClientRect();
            const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX;
            if (clientX == null) return;
            const x = clientX - rect.left;
            const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
            audioEngine.seek(pct);
        };

        const mini = document.getElementById('player-progress-container');
        const full = document.getElementById('np-seek-container');
        if (mini) mini.onclick = (e) => handleSeek(e, mini);
        if (full) {
            full.onclick = (e) => handleSeek(e, full);
            full.ontouchend = (e) => { if (e.cancelable) e.preventDefault(); handleSeek(e, full); };
        }

        window.addEventListener('audio:timeupdate', (e) => {
            const { progress, currentTime, duration } = e.detail;
            
            const omniBar = document.getElementById('omni-progress');
            if (omniBar) omniBar.style.width = `${progress}%`;
            if (document.getElementById('now-playing-view')?.classList.contains('active')) {
                const npBar = document.getElementById('np-seek-progress');
                if (npBar) npBar.style.width = `${progress}%`;
            }
        });
    }

    static initGestures() {
        // Block multi-touch zoom
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1 && e.cancelable) e.preventDefault();
        }, { passive: false });

        let startX = 0;
        let startY = 0;
        let activeRow = null;
        let isHorizontal = false;
        let isEdgeSwipe = false;

        document.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            const row = e.target.closest('.song-row');
            
            startX = touch.clientX;
            startY = touch.clientY;
            isHorizontal = false;
            isEdgeSwipe = false;

            // 1. Edge Swipe Detection
            if (startX < 40) {
                isEdgeSwipe = true;
                this.content.style.transition = 'none';
                return;
            }

            // 2. Song Row Gestures
            if (row) {
                activeRow = row;
                row.style.transition = 'none';
            }
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const diffX = touch.clientX - startX;
            const diffY = Math.abs(touch.clientY - startY);

            // Edge Swipe Handling
            if (isEdgeSwipe) {
                if (e.cancelable) e.preventDefault();
                const move = Math.max(0, diffX);
                this.content.style.transform = `translateX(${move}px)`;
                return;
            }

            if (!activeRow) return;
            
            if (!isHorizontal && Math.abs(diffX) > diffY && Math.abs(diffX) > 10) {
                isHorizontal = true;
            }
            
            if (isHorizontal) {
                if (e.cancelable) e.preventDefault();
                const move = Math.max(Math.min(diffX, 100), -100);
                activeRow.style.transform = `translateX(${move}px)`;
                
                // Show hints only when swiping horizontally
                if (activeRow.parentElement) {
                    activeRow.parentElement.classList.add('is-swiping');
                }
            }
        }, { passive: false });

        document.addEventListener('touchend', (e) => {
            // 1. End Edge Swipe
            if (isEdgeSwipe) {
                const diffX = e.changedTouches[0].clientX - startX;
                const threshold = window.innerWidth * 0.12;
                
                this.content.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                this.content.style.transform = 'translateX(0)';
                
                if (diffX > threshold) {
                    this.vibrate(20);
                    this.navigateBack();
                }
                isEdgeSwipe = false;
                return;
            }

            // 2. End Row Swipe
            if (activeRow) {
                const diff = e.changedTouches[0].clientX - startX;
                
                // Standardized 'Premium Slime' Physics for return
                activeRow.style.transition = 'transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)';
                activeRow.style.transform = 'translateX(0)';
                
                if (isHorizontal) {
                    const trackId = activeRow.getAttribute('data-id');
                    if (diff > 70) {
                        const inQueue = store.state.queue.some(t => t.id === trackId);
                        store.toggleQueue(trackId);
                        Haptics.tick(); // 15ms pulse
                        this.showToast(inQueue ? 'Removed from Queue' : 'Added to Queue');
                    } else if (diff < -70) {
                        const isFav = store.state.favorites.includes(trackId);
                        store.toggleFavourite(trackId);
                        Haptics.tick(); // 15ms pulse
                        this.showToast(isFav ? 'Removed from Favourites' : 'Added to Favourites');
                    }
                }

                // Hide hints after a delay to ensure the return animation finishes
                const rowToCleanup = activeRow;
                setTimeout(() => {
                    if (rowToCleanup && rowToCleanup.parentElement) {
                        rowToCleanup.parentElement.classList.remove('is-swiping');
                    }
                }, 400);

                activeRow = null;
            }
        }, { passive: true });

        // Action Menu Swipe-to-Dismiss logic
        this.initBottomSheetGestures();
    }

    static initNowPlayingGestures() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;
        
        let startY = 0;
        let isDragging = false;

        npView.addEventListener('touchstart', (e) => {
            if (e.target.closest('button') || e.target.closest('#np-seek-container')) return;
            startY = e.touches[0].clientY;
            isDragging = true;
            npView.style.transition = 'none';
        }, { passive: true });

        npView.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;
            if (deltaY > 0) {
                npView.style.transform = `translateY(${deltaY}px)`;
            }
        }, { passive: true });

        npView.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;
            const deltaY = e.changedTouches[0].clientY - startY;
            const threshold = window.innerHeight * 0.08; 

            // Standardized 'Premium Slime' Physics
            npView.style.transition = 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.4s ease';

            if (deltaY > threshold) {
                Haptics.lock(); // 15ms pulse for dismissal
                this.hideNowPlaying();
            } else {
                npView.style.transform = '';
            }
        }, { passive: true });
    }

    static initOmniIsland() {
        this.island = document.getElementById('omni-island');
        this.anchor = document.getElementById('omni-anchor');
        this.omniPrev = document.getElementById('omni-prev');
        this.omniNext = document.getElementById('omni-next');
        this.omniProgress = document.getElementById('omni-progress');
        
        if (!this.island || !this.anchor) return;

        this.initOmniGestures();
    }

    static initOmniGestures() {
        const island = document.getElementById('omni-island');
        const touchArea = document.getElementById('omni-touch-area');
        const ribbon = document.getElementById('omni-nav-ribbon');
        const label = document.getElementById('omni-label');
        const items = document.querySelectorAll('.omni-nav-item');
        if (!island || !touchArea || !ribbon || !label) return;

        this._isHolding = false;
        this._startedInside = false;
        this._activeNavView = null;
        this._startY = 0;
        this._currentY = 0;

        const startBloom = (e) => {
            const touch = e.touches[0];
            const rect = island.getBoundingClientRect();
            this._startedInside = touch.clientX >= rect.left && touch.clientX <= rect.right && 
                                 touch.clientY >= rect.top && touch.clientY <= rect.bottom;

            this._isHolding = true;
            this._startY = touch.clientY;
            this._currentY = this._startY;
            Haptics.tick();
            
            this._labelAnimTimer = setTimeout(() => {
                if (this._isHolding && this._startedInside) {
                    label.classList.remove('docked');
                    label.classList.add('hovered');
                    label.style.opacity = '1';
                }
            }, 120);

            this._omniHoldTimer = setTimeout(() => {
                // Only bloom if we haven't swiped up significantly
                if (this._startedInside && Math.abs(this._currentY - this._startY) < 30) {
                    Haptics.heavy();
                    this.isBlooming = true;

                    island.style.width = '380px';
                    
                    const transport = document.getElementById('omni-transport');
                    const metadata = document.getElementById('omni-metadata-container');

                    if (transport) {
                        transport.style.filter = 'blur(12px)';
                        transport.style.opacity = '0';
                        transport.style.transform = 'scale(0.9)';
                        transport.style.pointerEvents = 'none';
                    }
                    if (metadata) {
                        metadata.style.opacity = '0';
                    }

                    ribbon.classList.remove('pointer-events-none');
                    ribbon.style.opacity = '1';
                    ribbon.style.transform = 'scale(1)';
                    ribbon.style.filter = 'blur(0px)';
                }
            }, 324);
        };

        const endHold = (e) => {
            const touch = e.changedTouches[0];
            const rect = island.getBoundingClientRect();
            const hitboxRect = touchArea.getBoundingClientRect();
            const deltaY = touch.clientY - this._startY;
            
            // Dynamic Horizontal Check: Must be within the current width of the island
            const isHorizontalValid = touch.clientX >= rect.left - 20 && touch.clientX <= rect.right + 20;
            const isInside = touch.clientX >= hitboxRect.left && touch.clientX <= hitboxRect.right && 
                             touch.clientY >= hitboxRect.top && touch.clientY <= hitboxRect.bottom;
            
            if (this._omniHoldTimer) clearTimeout(this._omniHoldTimer);
            if (this._labelAnimTimer) clearTimeout(this._labelAnimTimer);

            // 0. SWIPE GESTURES FOR NOW PLAYING (Instant Toggle with 15px deadzone)
            if (this._isHolding && !this.isBlooming && this._startedInside && isHorizontalValid) {
                const isNPActive = document.getElementById('now-playing-view')?.classList.contains('active');
                const deadzone = 15;
                
                if (deltaY < -deadzone && !isNPActive) {
                    this.showNowPlaying();
                    this.resetOmniIsland();
                    return;
                } else if (deltaY > deadzone && isNPActive) {
                    this.hideNowPlaying();
                    this.resetOmniIsland();
                    return;
                }
            }
            
            // 1. COORDINATE-BASED TRANSPORT
            if (this._isHolding && !this.isBlooming && isInside) {
                const relX = (touch.clientX - rect.left) / rect.width;
                let zone = 'anchor'; // Default
                
                if (this.isIslandActive) {
                    if (relX < 0.35) zone = 'prev';
                    else if (relX > 0.65) zone = 'next';
                }

                Haptics.tick();
                
                // Subtle Inflation Feedback
                const targetId = zone === 'prev' ? 'omni-prev' : zone === 'next' ? 'omni-next' : 'omni-anchor';
                const visualEl = document.getElementById(targetId);
                if (visualEl) {
                    visualEl.classList.add('omni-tap-inflate');
                    setTimeout(() => visualEl.classList.remove('omni-tap-inflate'), 300);
                }

                if (zone === 'prev') audioEngine.prev();
                else if (zone === 'next') audioEngine.next();
                else {
                    if (store.state.currentTrack) audioEngine.toggle();
                    else if (store.state.library.length > 0) window.playTrack(store.state.library[0].id);
                }
            }

            // 2. NAV COMMIT (Uses elementFromPoint but hides touchArea first)
            if (this.isBlooming && this._activeNavView) {
                Haptics.lock();
                this.showView(this._activeNavView);
                
                // Dock the Label
                label.classList.remove('hovered');
                label.classList.add('docked');
                label.style.removeProperty('transform');
                label.style.setProperty('--tx', '0px');
            }

            this.resetOmniIsland();
        };

        // Bind events to the Hitbox Layer
        touchArea.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startBloom(e);
        });

        document.addEventListener('touchmove', (e) => {
            if (!this._isHolding) return;
            const touch = e.touches[0];
            this._currentY = touch.clientY;
            const rect = island.getBoundingClientRect();
            
            if (this.isBlooming) {
                const islandRect = island.getBoundingClientRect();
                const isVerticalValid = touch.clientY >= islandRect.top - 40;
                let item = null;

                if (isVerticalValid) {
                    const ribbon = document.getElementById('omni-nav-ribbon');
                    const ribbonRect = ribbon.getBoundingClientRect();
                    const itemsArr = Array.from(items);
                    
                    // Technical X-Calibration: Account for px-4 (16px) padding
                    const padding = 16;
                    const innerWidth = ribbonRect.width - (padding * 2);
                    const touchX = touch.clientX - ribbonRect.left - padding;
                    
                    // Map to 7 slots
                    const slotWidth = innerWidth / 7;
                    const index = Math.floor(touchX / slotWidth);
                    
                    if (index >= 0 && index < 7) {
                        // Correct for the blank center spacer (index 3)
                        if (index < 3) item = itemsArr[index];
                        else if (index > 3) item = itemsArr[index - 1]; // Skip the blank div in the DOM
                    }
                }

                if (item) {
                    const view = item.getAttribute('data-view');
                    if (view !== this._activeNavView) {
                        Haptics.tick();
                        this._activeNavView = view;

                        // Reset siblings and set active state
                        items.forEach(i => {
                            i.classList.remove('active');
                            i.style.transform = 'scale(1)';
                            i.querySelector('i').style.color = '';
                        });

                        item.classList.add('active');
                        item.style.transform = 'scale(1.3)';
                        item.querySelector('i').style.color = 'var(--accent)';

                        // Update Label
                        label.textContent = this.VIEW_LABELS[view] || '';
                        label.classList.add('hovered');
                        
                        // Centering logic: translateX(itemCenter - islandCenter)
                        const itemRect = item.getBoundingClientRect();
                        const offset = (itemRect.left + itemRect.width / 2) - (rect.left + rect.width / 2);
                        label.style.setProperty('--tx', `${offset}px`);
                        label.style.removeProperty('transform');
                    }
                } else if (this._activeNavView !== null) {
                    // RESET: Finger is over a blank area
                    this._activeNavView = null;
                    
                    // Maintain 'hovered' (grey) state during active bloom
                    label.classList.add('hovered');
                    label.classList.remove('docked');
                    
                    // Update text without clearing the transform logic
                    label.textContent = this.VIEW_LABELS[this.currentView] || '';
                    label.style.setProperty('--tx', '0px');

                    items.forEach(i => {
                        i.classList.remove('active');
                        i.style.transform = 'scale(1)';
                        i.querySelector('i').style.color = '';
                    });
                }
            } else {
                // SWIPE FEEDBACK: Subtle movement when swiping
                // Only move if we started inside the island
                if (!this._startedInside) return;

                const deltaY = this._currentY - this._startY;
                const isHorizontalValid = touch.clientX >= rect.left - 20 && touch.clientX <= rect.right + 20;

                if (!isHorizontalValid) {
                    island.style.transform = '';
                    return;
                }

                if (deltaY < 0) {
                    const move = Math.max(deltaY, -80);
                    island.style.transform = `translateY(${move * 0.328}px)`;
                } else if (deltaY > 0) {
                    const move = Math.min(deltaY, 80);
                    island.style.transform = `translateY(${move * 0.328}px)`;
                }
            }
        });

        document.addEventListener('touchend', endHold);
        
        // Critical: Handle system gestures (swiping home) that cancel the touch event
        touchArea.addEventListener('touchcancel', () => this.resetOmniIsland());
    }

    static vibrate(ms) {
        Haptics.trigger(ms);
    }

    /**
     * Resets the Omni-Island to its stable state (playback mode).
     * Used for touch cancellation, interruption, or committing navigation.
     */
    static resetOmniIsland() {
        const ribbon = document.getElementById('omni-nav-ribbon');
        const transport = document.getElementById('omni-transport');
        const items = document.querySelectorAll('.omni-nav-item');
        const label = document.getElementById('omni-label');

        if (this._omniHoldTimer) {
            clearTimeout(this._omniHoldTimer);
            this._omniHoldTimer = null;
        }
        if (this._labelAnimTimer) {
            clearTimeout(this._labelAnimTimer);
            this._labelAnimTimer = null;
        }

        // Restore Playback UI
        if (this.isIslandActive) this.island.style.width = '250px';
        else this.island.style.width = '56px';

        this.island.style.transform = ''; // Clear swipe displacement

        if (transport) {
            transport.style.filter = 'blur(0px)';
            transport.style.opacity = '1';
            transport.style.transform = 'scale(1)';
            transport.style.pointerEvents = 'auto';
        }

        const metadata = document.getElementById('omni-metadata-container');
        if (metadata) {
            metadata.style.opacity = '1';
        }

        if (ribbon) {
            ribbon.classList.add('pointer-events-none');
            ribbon.style.opacity = '0';
            ribbon.style.transform = 'scale(0.95)';
            ribbon.style.filter = 'blur(8px)';
        }
        
        items.forEach(i => {
            i.classList.remove('active');
            i.style.transform = 'scale(1)';
            i.querySelector('i').style.color = '';
        });

        // Always reset label to the current view's docked state
        if (label) {
            this.updateLabel(this.currentView);
        }

        this.isBlooming = false;
        this._isHolding = false;
        this._activeNavView = null;
    }

    static showActionMenu(trackId) {
        // CRITICAL: Blur any active element to prevent auto-focus/highlight on mobile
        if (document.activeElement) document.activeElement.blur();

        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.currentActionTrack = track;
        const el = id => document.getElementById(id);
        
        if (el('action-track-title')) el('action-track-title').textContent = track.title;
        if (el('action-track-artist')) {
            el('action-track-artist').textContent = track.artist;
            el('action-track-artist').classList.add('font-mono');
        }
        if (el('action-track-art')) el('action-track-art').src = Resolver.getCoverUrl(track);

        const isFav = store.state.favorites.includes(trackId);
        if (el('action-fav-text')) el('action-fav-text').textContent = isFav ? 'Remove from Favourites' : 'Add to Favourites';
        
        const isInQueue = store.state.queue.some(t => t.id === trackId);
        if (el('action-queue-text')) el('action-queue-text').textContent = isInQueue ? 'Remove from Queue' : 'Add to Queue';

        const menu = el('action-menu');
        const sheet = el('action-menu-sheet');
        if (menu) menu.classList.remove('hidden');
        setTimeout(() => {
            if (menu) {
                menu.classList.add('active');
                menu.querySelector('#action-menu-overlay').classList.replace('opacity-0', 'opacity-100');
            }
            if (sheet) {
                sheet.style.transform = ''; // Clear manual drag
                sheet.classList.remove('translate-y-full');
            }
        }, 10);

        if (!this._menuBound) {
            el('action-menu-overlay').onclick = () => this.hideActionMenu();
            el('action-queue').onclick = () => { store.toggleQueue(this.currentActionTrack.id); this.hideActionMenu(); };
            el('action-fav').onclick = () => { store.toggleFavourite(this.currentActionTrack.id); this.hideActionMenu(); };
            el('action-delete').onclick = () => { if(confirm('Delete?')) store.deleteTrack(this.currentActionTrack.id); this.hideActionMenu(); };
            el('action-edit-metadata').onclick = () => { this.hideActionMenu(); this.showMetadataEditor(this.currentActionTrack.id); };
            this._menuBound = true;
        }
    }

    static hideActionMenu() {
        if (document.activeElement) document.activeElement.blur();
        
        const menu = document.getElementById('action-menu');
        const sheet = document.getElementById('action-menu-sheet');
        if (sheet) {
            sheet.style.transform = ''; // Clear manual drag
            sheet.classList.add('translate-y-full');
        }
        if (menu) {
            menu.classList.remove('active');
            menu.querySelector('#action-menu-overlay').classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => {
            if (menu) menu.classList.add('hidden');
        }, 400);
    }

    static initBottomSheetGestures() {
        const sheet = document.getElementById('action-menu-sheet');
        if (!sheet) return;
        
        let startY = 0;
        let isDragging = false;

        sheet.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            isDragging = true;
            sheet.style.transition = 'none';
        }, { passive: true });

        sheet.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            const currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;
            if (deltaY > 0) sheet.style.transform = `translateY(${deltaY}px)`;
        }, { passive: true });

        sheet.addEventListener('touchend', (e) => {
            if (!isDragging) return;
            isDragging = false;
            const deltaY = e.changedTouches[0].clientY - startY;
            const threshold = sheet.offsetHeight * 0.14; 
            
            // Standardized 'Premium Slime' Physics
            sheet.style.transition = 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1)';
            
            if (deltaY > threshold) {
                Haptics.lock(); // 15ms pulse for dismissal
                this.hideActionMenu();
            } else {
                sheet.style.transform = 'translateY(0)';
            }
        }, { passive: true });
    }

    static updateTransportControls(isPlaying) {
        const mini = document.querySelector('#mini-play-btn i');
        if (mini) {
            mini.className = isPlaying ? 'fas fa-pause' : 'fas fa-play ml-0.5';
        }

        const mode = store.state.repeatMode;
        const shuffleOn = store.state.shuffleEnabled;
        const repeatBtns = [document.getElementById('mini-repeat-btn'), document.getElementById('omni-repeat-btn')].filter(b => b);
        repeatBtns.forEach(b => {
            b.classList.toggle('text-[var(--accent)]', mode !== 'off');
            b.classList.toggle('text-[var(--text-dim)]', mode === 'off');
        });
        const omniRepeatOne = document.getElementById('omni-repeat-one-indicator');
        if (omniRepeatOne) omniRepeatOne.classList.toggle('hidden', mode !== 'one');
        
        const indMini = document.getElementById('mini-repeat-one-indicator');
        if (indMini) indMini.classList.toggle('hidden', mode !== 'one');

        const shuffleBtns = [document.getElementById('mini-shuffle-btn'), document.getElementById('omni-shuffle-btn')].filter(b => b);
        shuffleBtns.forEach(b => {
            b.classList.toggle('text-[var(--accent)]', shuffleOn);
            b.classList.toggle('text-[var(--text-dim)]', !shuffleOn);
        });
    }

    static showMetadataEditor(id) {
        const t = store.state.library.find(x => x.id === id);
        if (!t) return;
        this.editingTrack = t;
        
        const modal = document.getElementById('metadata-editor');
        const content = document.getElementById('metadata-editor-content');
        
        document.getElementById('edit-title').value = t.title;
        document.getElementById('edit-artist').value = t.artist;
        document.getElementById('edit-album').value = t.album;
        document.getElementById('edit-cover-preview').src = Resolver.getCoverUrl(t);

        if (modal) modal.classList.remove('hidden');
        setTimeout(() => {
            if (content) {
                content.classList.replace('scale-95', 'scale-100');
                content.classList.replace('opacity-0', 'opacity-100');
            }
        }, 10);

        if (!this._edBound) {
            document.getElementById('edit-save-btn').onclick = () => this.saveMetadata();
            document.getElementById('edit-auto-fetch-btn').onclick = () => this.autoFetch();
            
            const uploadBtn = document.getElementById('edit-upload-btn');
            const fileInput = document.getElementById('edit-file-input');
            if (uploadBtn && fileInput) {
                uploadBtn.onclick = () => { this.vibrate(10); fileInput.click(); };
                fileInput.onchange = (e) => this.handleCoverUpload(e);
            }
            this._edBound = true;
        }
    }

    static hideMetadataEditor() {
        const modal = document.getElementById('metadata-editor');
        const content = document.getElementById('metadata-editor-content');
        if (content) {
            content.classList.replace('scale-100', 'scale-95');
            content.classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => modal && modal.classList.add('hidden'), 300);
    }

    static async saveMetadata() {
        if (!this.editingTrack) return;
        this.vibrate(30);
        const status = document.getElementById('edit-status');
        status.textContent = 'Saving Changes...';

        const metadata = {
            title: document.getElementById('edit-title').value,
            artist: document.getElementById('edit-artist').value,
            album: document.getElementById('edit-album').value
        };

        const success = await store.updateMetadata(this.editingTrack.id, metadata);
        if (success) {
            this.showToast('Metadata Updated');
            this.hideMetadataEditor();
        } else {
            status.textContent = 'Save Failed';
        }
    }

    static async autoFetch() {
        if (!this.editingTrack) return;
        this.vibrate(20);
        const status = document.getElementById('edit-status');
        const resultsContainer = document.getElementById('auto-fetch-results');
        
        status.textContent = 'Searching technical data...';
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('hidden');

        const query = `${document.getElementById('edit-title').value} ${document.getElementById('edit-artist').value}`;
        const results = await store.searchMetadata(query);

        if (!results || results.length === 0) {
            status.textContent = 'No matches found';
            return;
        }

        status.textContent = 'Matches found';
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = results.slice(0, 5).map(r => `
            <div class="flex items-center p-3 hover:bg-white/5 rounded-xl cursor-pointer transition-colors border border-transparent active:border-[var(--accent)]/30 active:bg-[var(--accent)]/5" onclick="UI.applyFetchedMetadata('${r.title.replace(/'/g, "\\'")}', '${r.artist.replace(/'/g, "\\'")}', '${r.album.replace(/'/g, "\\'")}', '${r.cover}')">
                <img src="${r.cover}" class="w-10 h-10 rounded-lg object-cover shadow-md">
                <div class="ml-3 truncate">
                    <div class="text-xs font-bold truncate text-white/90">${r.title}</div>
                    <div class="text-[9px] font-bold text-white/40 truncate uppercase tracking-widest font-mono">${r.artist}</div>
                </div>
            </div>
        `).join('');
    }

    static applyFetchedMetadata(title, artist, album, cover) {
        this.vibrate(10);
        document.getElementById('edit-title').value = title;
        document.getElementById('edit-artist').value = artist;
        document.getElementById('edit-album').value = album;
        document.getElementById('edit-cover-preview').src = cover;
        document.getElementById('auto-fetch-results').classList.add('hidden');
        document.getElementById('edit-status').textContent = 'Metadata applied locally';
    }

    static async handleCoverUpload(e) {
        const file = e.target.files[0];
        if (!file || !this.editingTrack) return;
        
        this.vibrate(20);
        const status = document.getElementById('edit-status');
        status.textContent = 'Uploading Cover Art...';

        const success = await store.uploadCover(this.editingTrack.id, file);
        if (success) {
            this.showToast('Cover Art Updated');
            document.getElementById('edit-cover-preview').src = URL.createObjectURL(file);
            status.textContent = 'Cover applied';
        } else {
            status.textContent = 'Upload Failed';
        }
    }

    static formatTime(s) {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sc = Math.floor(s % 60);
        return `${m}:${sc.toString().padStart(2, '0')}`;
    }

    static showToast(m) {
        const c = document.getElementById('toast-container');
        if (!c) return;
        const t = document.createElement('div');
        // Omni-Island Styled Toast
        t.className = 'glass-view px-6 py-3 rounded-full shadow-2xl text-[10px] font-black uppercase tracking-[0.2em] font-mono text-white/80 transition-all duration-500 ease-[cubic-bezier(0.19,1,0.22,1)] transform translate-y-10 opacity-0 border border-white/10';
        t.style.backdropFilter = 'blur(40px)';
        t.style.webkitBackdropFilter = 'blur(40px)';
        t.style.backgroundColor = 'rgba(30, 31, 34, 0.85)';
        t.textContent = m;
        c.appendChild(t);
        setTimeout(() => { t.classList.replace('translate-y-10', 'translate-y-0'); t.classList.replace('opacity-0', 'opacity-100'); }, 10);
        setTimeout(() => { t.classList.replace('translate-y-0', 'translate-y-10'); t.classList.replace('opacity-100', 'opacity-0'); setTimeout(() => t.remove(), 500); }, 2500);
    }
}
window.UI = UI;
