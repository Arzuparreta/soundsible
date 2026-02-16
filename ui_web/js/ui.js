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
        console.log("UI: Initializing Premium Core...");
        this.playerBar = document.getElementById('player-bar');
        this.playerTitle = document.getElementById('player-title');
        this.playerArtist = document.getElementById('player-artist');
        this.progressBar = document.getElementById('player-progress');
        this.content = document.getElementById('content');
        
        // Navigation State
        this.viewStack = [];
        this.currentView = 'home';
        this._npGesturesBound = false;

        this.initGlobalListeners();
        this.initOmniButton();
        store.subscribe((state) => this.updatePlayer(state));

        // Global Transport Handlers
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = (e) => { e.stopPropagation(); fn(); };
        };

        bind('mini-play-btn', () => audioEngine.toggle());
        bind('np-play-btn', () => audioEngine.toggle());
        bind('mini-next-btn', () => audioEngine.next());
        bind('mini-prev-btn', () => audioEngine.prev());
        bind('np-next-btn', () => audioEngine.next());
        bind('np-prev-btn', () => audioEngine.prev());
        
        bind('mini-shuffle-btn', () => { store.toggleShuffle(); this.showToast('Queue Shuffled'); });
        bind('np-shuffle-btn', () => { store.toggleShuffle(); this.showToast('Queue Shuffled'); });
        bind('mini-repeat-btn', () => store.toggleRepeat());
        bind('np-repeat-btn', () => store.toggleRepeat());

        // Gestures Engine
        this.initGestures();
    }

    static updatePlayer(state) {
        if (state.currentTrack) {
            if (this.playerBar && this.playerBar.classList.contains('hidden')) {
                this.playerBar.classList.remove('hidden');
                setTimeout(() => this.playerBar.classList.replace('translate-y-full', 'translate-y-0'), 10);
            }
            
            if (this.playerTitle) this.playerTitle.textContent = state.currentTrack.title;
            if (this.playerArtist) this.playerArtist.textContent = state.currentTrack.artist;
            
            const playerArt = document.getElementById('player-art');
            if (playerArt) playerArt.src = Resolver.getCoverUrl(state.currentTrack);

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
    }

    static updateThemeUI(theme) {
        const indicator = document.getElementById('theme-indicator');
        if (indicator) {
            indicator.style.transform = theme === 'dark' ? 'translateX(24px)' : 'translateX(0px)';
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
        this.updateNowPlaying(track, store.state.isPlaying);
        
        setTimeout(() => npView.classList.add('active'), 10);

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
        setTimeout(() => {
            if (!npView.classList.contains('active')) npView.classList.add('hidden');
        }, 800);
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
        if (viewId === this.currentView) return;
        
        const oldView = document.getElementById(`view-${this.currentView}`);
        const targetView = document.getElementById(`view-${viewId}`);
        if (!targetView) return;

        if (saveToHistory) {
            const roots = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
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
        // Global Clicks
        window.addEventListener('click', (e) => {
            const q = document.getElementById('queue-container');
            if (q && !q.contains(e.target)) this.hideQueue();
        });

        // Seek
        const handleSeek = (e, container) => {
            const rect = container.getBoundingClientRect();
            const x = (e.clientX || e.touches?.[0].clientX) - rect.left;
            const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
            audioEngine.seek(pct);
        };

        const mini = document.getElementById('player-progress-container');
        const full = document.getElementById('np-seek-container');
        if (mini) mini.onclick = (e) => handleSeek(e, mini);
        if (full) full.onclick = (e) => handleSeek(e, full);

        window.addEventListener('audio:timeupdate', (e) => {
            const { progress, currentTime, duration } = e.detail;
            const bar = document.getElementById('np-seek-bar');
            if (bar) bar.style.width = `${progress}%`;
            const curr = document.getElementById('np-time-curr');
            const total = document.getElementById('np-time-total');
            if (curr) curr.textContent = this.formatTime(currentTime);
            if (total) total.textContent = this.formatTime(duration);
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
        let longPressTimer = null;

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
                
                longPressTimer = setTimeout(() => {
                    if (!isHorizontal) {
                        this.vibrate(50);
                        this.showActionMenu(row.getAttribute('data-id'));
                    }
                }, 600);
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
                clearTimeout(longPressTimer);
            }
            
            if (isHorizontal) {
                if (e.cancelable) e.preventDefault();
                const move = Math.max(Math.min(diffX, 100), -100);
                activeRow.style.transform = `translateX(${move}px)`;
            }
        }, { passive: false });

        document.addEventListener('touchend', (e) => {
            clearTimeout(longPressTimer);

            // 1. End Edge Swipe
            if (isEdgeSwipe) {
                const diffX = e.changedTouches[0].clientX - startX;
                const threshold = window.innerWidth * 0.3;
                
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
                activeRow.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                activeRow.style.transform = 'translateX(0)';
                
                if (isHorizontal) {
                    if (diff > 70) {
                        store.toggleQueue(activeRow.getAttribute('data-id'));
                        this.vibrate(30);
                        this.showToast('Updated Queue');
                    } else if (diff < -70) {
                        store.toggleFavourite(activeRow.getAttribute('data-id'));
                        this.vibrate(30);
                        this.showToast('Updated Favourites');
                    }
                }
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
            const threshold = window.innerHeight * 0.14; // Reduced by 30% from 0.2

            npView.style.transition = 'transform 0.6s cubic-bezier(0.19, 1, 0.22, 1)';

            if (deltaY > threshold) {
                this.vibrate(20);
                this.hideNowPlaying();
            } else {
                npView.style.transform = '';
            }
        }, { passive: true });
    }

    static showActionMenu(trackId) {
        // CRITICAL: Blur any active element to prevent auto-focus/highlight on mobile
        if (document.activeElement) document.activeElement.blur();

        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.currentActionTrack = track;
        const el = id => document.getElementById(id);
        
        if (el('action-track-title')) el('action-track-title').textContent = track.title;
        if (el('action-track-artist')) el('action-track-artist').textContent = track.artist;
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
            const threshold = sheet.offsetHeight * 0.14; // Reduced to 14% for consistency
            
            sheet.style.transition = 'transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)';
            
            if (deltaY > threshold) {
                this.hideActionMenu();
            } else {
                sheet.style.transform = 'translateY(0)';
            }
        }, { passive: true });
    }

    static initScrubNav() {
        const pill = document.getElementById('scrub-pill');
        const label = document.getElementById('scrub-label');
        if (!pill || !label) return;

        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        const labels = ['Home', 'Search', 'Library', 'Station', 'Likes', 'Settings'];
        
        let startX = 0;
        let activeIndex = views.indexOf(this.currentView);

        pill.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            activeIndex = views.indexOf(this.currentView);
            pill.classList.add('active');
            label.textContent = labels[activeIndex];
            this.vibrate(20);
        }, { passive: true });

        pill.addEventListener('touchmove', (e) => {
            const currentX = e.touches[0].clientX;
            const diffX = currentX - startX;
            
            const step = 40;
            const indexDiff = Math.round(diffX / step);
            let newIndex = views.indexOf(this.currentView) + indexDiff;
            
            newIndex = Math.max(0, Math.min(views.length - 1, newIndex));
            
            if (newIndex !== activeIndex) {
                activeIndex = newIndex;
                label.textContent = labels[activeIndex];
                this.vibrate(10);
            }
        }, { passive: true });

        pill.addEventListener('touchend', () => {
            pill.classList.remove('active');
            if (activeIndex !== views.indexOf(this.currentView)) {
                this.showView(views[activeIndex]);
            }
        }, { passive: true });
    }

    static initQuickJump() {
        const bar = document.getElementById('player-bar');
        if (!bar) return;

        let timer;
        bar.addEventListener('touchstart', (e) => {
            if (e.target.closest('button')) return;
            timer = setTimeout(() => {
                this.vibrate(50);
                this.showQuickJump();
            }, 600);
        }, { passive: true });

        bar.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
        bar.addEventListener('touchend', () => clearTimeout(timer), { passive: true });
    }

    static showQuickJump() {
        const hud = document.getElementById('quick-jump-hud');
        const content = document.getElementById('quick-jump-content');
        const overlay = document.getElementById('quick-jump-overlay');
        if (!hud) return;

        hud.classList.remove('hidden');
        setTimeout(() => {
            overlay.classList.replace('opacity-0', 'opacity-100');
            content.classList.replace('scale-90', 'scale-100');
            content.classList.replace('opacity-0', 'opacity-100');
        }, 10);
    }

    static hideQuickJump() {
        const hud = document.getElementById('quick-jump-hud');
        const content = document.getElementById('quick-jump-content');
        const overlay = document.getElementById('quick-jump-overlay');
        if (!hud) return;

        overlay.classList.replace('opacity-100', 'opacity-0');
        content.classList.replace('scale-100', 'scale-90');
        content.classList.replace('opacity-100', 'opacity-0');
        setTimeout(() => hud.classList.add('hidden'), 500);
    }

    static updateTransportControls(isPlaying) {
        const mini = document.querySelector('#mini-play-btn i');
        const np = document.querySelector('#np-play-btn i');
        if (mini) {
            mini.className = isPlaying ? 'fas fa-pause' : 'fas fa-play ml-0.5';
        }
        if (np) {
            np.className = isPlaying ? 'fas fa-pause' : 'fas fa-play ml-1';
        }

        const mode = store.state.repeatMode;
        const btns = [document.getElementById('np-repeat-btn'), document.getElementById('mini-repeat-btn')].filter(b => b);
        btns.forEach(b => {
            b.classList.toggle('text-[var(--accent)]', mode !== 'off');
            b.classList.toggle('text-[var(--text-dim)]', mode === 'off');
        });
        
        const indMini = document.getElementById('mini-repeat-one-indicator');
        const indNP = document.getElementById('np-repeat-one-indicator');
        if (indMini) indMini.classList.toggle('hidden', mode !== 'one');
        if (indNP) indNP.classList.toggle('hidden', mode !== 'one');
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

    static vibrate(ms) { if (navigator.vibrate) navigator.vibrate(ms); }
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
        t.className = 'bg-gray-800 border border-white/10 px-6 py-3 rounded-2xl shadow-2xl text-sm font-bold transition-all transform translate-y-10 opacity-0';
        t.textContent = m;
        c.appendChild(t);
        setTimeout(() => { t.classList.replace('translate-y-10', 'translate-y-0'); t.classList.replace('opacity-0', 'opacity-100'); }, 10);
        setTimeout(() => { t.classList.replace('translate-y-0', 'translate-y-10'); t.classList.replace('opacity-100', 'opacity-0'); setTimeout(() => t.remove(), 500); }, 3000);
    }
}
window.UI = UI;
