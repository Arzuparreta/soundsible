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
        console.log("UI: Initializing Static Core...");
        this.playerBar = document.getElementById('player-bar');
        this.playerTitle = document.getElementById('player-title');
        this.playerArtist = document.getElementById('player-artist');
        this.progressBar = document.getElementById('player-progress');
        this.navButtons = document.querySelectorAll('#mobile-nav button');
        
        this.viewStack = [];
        this.currentView = 'home';

        this.initNav();
        store.subscribe((state) => this.updatePlayer(state));

        // Global Transport Handlers (Mini & Full)
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.onclick = (e) => { e.stopPropagation(); fn(); };
        };

        // Play/Pause
        bind('mini-play-btn', () => audioEngine.toggle());
        bind('np-play-btn', () => audioEngine.toggle());
        
        // Navigation
        bind('mini-next-btn', () => audioEngine.next());
        bind('mini-prev-btn', () => audioEngine.prev());
        
        // Modes
        bind('mini-shuffle-btn', () => { store.toggleShuffle(); this.showToast('Queue Shuffled'); });
        bind('np-shuffle-btn', () => { store.toggleShuffle(); this.showToast('Queue Shuffled'); });
        bind('mini-repeat-btn', () => store.toggleRepeat());
        bind('np-repeat-btn', () => store.toggleRepeat());

        // Simple Touch Handlers
        this.initTouch();
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
    }

    static hideNowPlaying() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;
        npView.classList.remove('active');
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
        setTimeout(() => popover.classList.add('hidden'), 300);
    }

    static showView(viewId, saveToHistory = true) {
        if (viewId === this.currentView) return;
        
        if (saveToHistory) {
            const roots = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
            if (roots.includes(this.currentView) && roots.includes(viewId)) this.viewStack = [];
            else this.viewStack.push(this.currentView);
        }

        document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
        const target = document.getElementById(`view-${viewId}`);
        if (target) {
            target.classList.remove('hidden');
            document.getElementById('content').scrollTop = 0;
            if (viewId === 'favourites' && window.renderFavourites) window.renderFavourites(store.state);
            if (viewId === 'downloader') import('./downloader.js').then(m => m.Downloader.init());
        }

        this.currentView = viewId;

        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        const idx = views.indexOf(viewId);
        if (idx !== -1 && this.navButtons[idx]) {
            this.navButtons.forEach(b => b.classList.replace('text-blue-500', 'text-gray-500'));
            this.navButtons[idx].classList.replace('text-gray-500', 'text-blue-500');
        }
    }

    static initNav() {
        const views = ['home', 'search', 'albums', 'downloader', 'favourites', 'settings'];
        if (this.navButtons) {
            this.navButtons.forEach((btn, idx) => {
                btn.onclick = (e) => {
                    e.preventDefault();
                    this.vibrate(10);
                    this.showView(views[idx]);
                };
            });
        }

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

    static initTouch() {
        // Block multi-touch zoom
        document.addEventListener('touchstart', (e) => {
            if (e.touches.length > 1 && e.cancelable) e.preventDefault();
        }, { passive: false });

        let startX = 0;
        let startY = 0;
        let currentX = 0;
        let activeRow = null;
        let isHorizontal = false;
        let longPressTimer = null;

        document.addEventListener('touchstart', (e) => {
            const row = e.target.closest('.song-row');
            if (row) {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                activeRow = row;
                row.style.transition = 'none';
                isHorizontal = false;
                
                longPressTimer = setTimeout(() => {
                    if (!isHorizontal) {
                        this.vibrate(50);
                        this.showActionMenu(row.getAttribute('data-id'));
                    }
                }, 600);
            }
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!activeRow) return;
            currentX = e.touches[0].clientX;
            const diffX = currentX - startX;
            const diffY = Math.abs(e.touches[0].clientY - startY);
            
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
            if (!activeRow) return;
            
            const diff = currentX - startX;
            activeRow.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
            activeRow.style.transform = 'translateX(0)';
            
            if (isHorizontal) {
                if (diff > 70) {
                    store.toggleFavourite(activeRow.getAttribute('data-id'));
                    this.vibrate(30);
                    this.showToast('Updated Favourites');
                } else if (diff < -70) {
                    store.toggleQueue(activeRow.getAttribute('data-id'));
                    this.vibrate(30);
                    this.showToast('Updated Queue');
                }
            }
            
            activeRow = null;
            startX = 0;
            currentX = 0;
        }, { passive: true });
    }

    static showActionMenu(trackId) {
        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.currentActionTrack = track;
        const el = id => document.getElementById(id);
        
        if (el('action-track-title')) el('action-track-title').textContent = track.title;
        if (el('action-track-artist')) el('action-track-artist').textContent = track.artist;
        if (el('action-track-art')) el('action-track-art').src = Resolver.getCoverUrl(track);

        const isFav = store.state.favorites.includes(trackId);
        if (el('action-fav-text')) el('action-fav-text').textContent = isFav ? 'Remove from Favourites' : 'Add to Favourites';
        
        const menu = el('action-menu');
        const sheet = el('action-menu-sheet');
        if (menu) menu.classList.remove('hidden');
        setTimeout(() => {
            if (menu) {
                menu.classList.add('active');
                menu.querySelector('#action-menu-overlay').classList.replace('opacity-0', 'opacity-100');
            }
            if (sheet) sheet.classList.remove('translate-y-full');
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
        const menu = document.getElementById('action-menu');
        const sheet = document.getElementById('action-menu-sheet');
        if (sheet) sheet.classList.add('translate-y-full');
        if (menu) {
            menu.classList.remove('active');
            menu.querySelector('#action-menu-overlay').classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => {
            if (menu) menu.classList.add('hidden');
        }, 400);
    }

    static updateTransportControls(isPlaying) {
        const mini = document.querySelector('#mini-play-btn i');
        const np = document.querySelector('#np-play-btn i');
        if (mini) mini.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';
        if (np) np.className = isPlaying ? 'fas fa-pause' : 'fas fa-play';

        const mode = store.state.repeatMode;
        const btns = [document.getElementById('np-repeat-btn'), document.getElementById('mini-repeat-btn')].filter(b => b);
        btns.forEach(b => b.classList.toggle('text-blue-500', mode !== 'off'));
        
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
