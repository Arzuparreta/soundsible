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
    /** When set, NP view shows this track (preview) without starting playback; cleared on hide or when user taps play. */
    static _npDisplayTrack = null;
    /** Last currentTrack.id we saw; used to detect "playing track changed" so we only clear _npDisplayTrack on skip, not on play/pause or seek. */
    static _lastCurrentTrackId = null;
    /** When set, apply this seek percent once on next timeupdate (after preview track starts). */
    static _npPendingSeekPercent = null;

    static VIEW_LABELS = {
        'home': 'ALL TRACKS',
        'favourites': 'FAVORITES',
        'artists': 'ARTISTS',
        'artist-detail': 'ARTIST',
        'playlists': 'PLAYLISTS',
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
        this.islandUserCollapsed = false; // user swiped down to collapse playback bar to seed form
        this.isBlooming = false;
        this.isDraggingQueue = false;
        this._keyboardHeight = 0;
        this._platform = this.detectPlatform();

        this.initGlobalListeners();
        this.initOmniIsland();
        this.initKeyboardSync();
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

        if (state.currentTrack || UI._npDisplayTrack) {
            if (document.getElementById('now-playing-view')?.classList.contains('active')) {
                // Clear preview only when the *playing* track actually changed (user skipped), not on play/pause or seek
                const playingTrackJustChanged = state.currentTrack && UI._lastCurrentTrackId !== state.currentTrack.id;
                if (UI._npDisplayTrack && playingTrackJustChanged && state.currentTrack.id !== UI._npDisplayTrack.id) {
                    UI._npDisplayTrack = null;
                    const npViewEl = document.getElementById('now-playing-view');
                    if (npViewEl) npViewEl.classList.remove('np-preview');
                }
                const displayTrack = UI._npDisplayTrack || state.currentTrack;
                const isPlaying = UI._npDisplayTrack
                    ? (state.currentTrack?.id === UI._npDisplayTrack.id && state.isPlaying)
                    : state.isPlaying;
                this.updateNowPlaying(displayTrack, isPlaying);
                // Timeline expands only when current track's NP (not preview)
                const npSeek = document.getElementById('np-seek-container');
                if (UI._npDisplayTrack) {
                    if (npSeek) npSeek.classList.remove('np-timeline-expanded');
                    document.body.classList.remove('np-timeline-expanded');
                } else if (state.currentTrack) {
                    if (npSeek) npSeek.classList.add('np-timeline-expanded');
                    document.body.classList.add('np-timeline-expanded');
                }
            }
            this.updateTransportControls(state.isPlaying);
            UI._lastCurrentTrackId = state.currentTrack?.id ?? null;
        } else {
            UI._lastCurrentTrackId = null;
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
        this.updateLibraryOrderUI(state.libraryOrder);
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
            anchorIcon.className = state.isPlaying ? 'fas fa-pause text-lg text-[var(--text-main)]' : 'fas fa-play text-lg text-[var(--text-main)] ml-1';
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

        const titleHtml = `<span class="text-[var(--nav-icon)]">${esc(track.title)}</span>`;
        const restHtml = ` • ${esc(track.artist)} • ${esc(track.album)} • `;
        const contentHtml = titleHtml + restHtml;
        
        // Simple comparison to avoid DOM thrashing
        if (text1.innerHTML === contentHtml) return;

        text1.innerHTML = contentHtml;
        text2.innerHTML = contentHtml;
        container.style.opacity = this.islandUserCollapsed ? '0' : '1';

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
        this.islandUserCollapsed = false;
        Haptics.heavy();
        
        this.island.style.width = '250px';
        
        const prev = document.getElementById('omni-prev');
        const next = document.getElementById('omni-next');
        const anchorIcon = document.getElementById('omni-anchor-icon');

        if (prev) { prev.classList.remove('hidden'); setTimeout(() => { prev.classList.replace('opacity-0', 'opacity-100'); prev.classList.replace('scale-75', 'scale-100'); }, 100); }
        if (next) { next.classList.remove('hidden'); setTimeout(() => { next.classList.replace('opacity-0', 'opacity-100'); next.classList.replace('scale-75', 'scale-100'); }, 100); }
        
        if (anchorIcon) anchorIcon.className = store.state.isPlaying ? 'fas fa-pause text-lg text-[var(--text-main)]' : 'fas fa-play text-lg text-[var(--text-main)] ml-1';

        const transport = document.getElementById('omni-transport');
        const metadata = document.getElementById('omni-metadata-container');
        const omniProgressTrack = document.getElementById('omni-progress-track');
        const t = '0.4s';
        if (transport) {
            transport.style.transition = `opacity ${t} ease, filter 0.3s ease, transform 0.3s ease`;
            transport.style.filter = 'blur(0px)';
            transport.style.opacity = '1';
            transport.style.transform = 'scale(1)';
            transport.style.pointerEvents = 'auto';
        }
        if (omniProgressTrack) {
            omniProgressTrack.style.transition = `opacity ${t} ease`;
            omniProgressTrack.style.opacity = '1';
        }
        if (metadata) {
            metadata.style.transition = `opacity ${t} ease`;
            metadata.style.opacity = '1';
        }
    }

    static collapseToSeed() {
        this.isIslandActive = false;
        this.islandUserCollapsed = false;
        this.island.style.width = '56px';
        
        const prev = document.getElementById('omni-prev');
        const next = document.getElementById('omni-next');
        const anchorIcon = document.getElementById('omni-anchor-icon');

        if (prev) { prev.classList.replace('opacity-100', 'opacity-0'); prev.classList.replace('scale-100', 'scale-75'); setTimeout(() => prev.classList.add('hidden'), 300); }
        if (next) { next.classList.replace('opacity-100', 'opacity-0'); next.classList.replace('scale-100', 'scale-75'); setTimeout(() => next.classList.add('hidden'), 300); }
        
        if (anchorIcon) anchorIcon.className = 'fas fa-command text-lg text-[var(--text-main)]';
    }

    static detectPlatform() {
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        return isIOS ? 'ios' : 'android';
    }

    static initKeyboardSync() {
        if (!window.visualViewport) {
            console.warn('Visual Viewport API not supported');
            return;
        }

        const container = document.getElementById('omni-island-container');
        if (!container) return;

        // Apply platform-specific class
        container.classList.add(`omni-keyboard-${this._platform}`);

        let lastHeight = window.visualViewport.height;
        let isKeyboardOpen = false;

        const handleViewportResize = () => {
            // Do NOT move the omni bar when any input/textarea is focused (keyboard overlays, bar stays at bottom)
            const active = document.activeElement;
            const isInputLike = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.getAttribute?.('contenteditable') === 'true');
            if (isInputLike) {
                return;
            }

            const currentHeight = window.visualViewport.height;
            const heightDiff = window.innerHeight - currentHeight;
            const keyboardHeight = Math.max(0, heightDiff);

            const keyboardJustOpened = !isKeyboardOpen && keyboardHeight > 50;
            const keyboardJustClosed = isKeyboardOpen && keyboardHeight <= 50;

            if (keyboardJustOpened || keyboardJustClosed) {
                isKeyboardOpen = keyboardHeight > 50;
                this._keyboardHeight = keyboardHeight;

                if (isKeyboardOpen) {
                    this.handleKeyboardOpen(keyboardHeight);
                } else {
                    this.handleKeyboardClose();
                }
            } else if (isKeyboardOpen && keyboardHeight > 0) {
                container.style.transform = `translateY(-${keyboardHeight}px)`;
                this._keyboardHeight = keyboardHeight;
            }

            lastHeight = currentHeight;
        };

        window.visualViewport.addEventListener('resize', handleViewportResize);
        window.visualViewport.addEventListener('scroll', handleViewportResize);
    }

    static handleKeyboardOpen(keyboardHeight) {
        const container = document.getElementById('omni-island-container');
        if (!container) return;

        this._keyboardHeight = keyboardHeight;
        container.style.transform = `translateY(-${keyboardHeight}px)`;
    }

    static handleKeyboardClose() {
        const container = document.getElementById('omni-island-container');
        if (!container) return;

        this._keyboardHeight = 0;
        container.style.transform = '';
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

    static updateLibraryOrderUI(libraryOrder) {
        const sel = document.getElementById('settings-library-order');
        if (sel && libraryOrder) sel.value = libraryOrder;
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
        }
    }

    static updateNowPlaying(track, isPlaying) {
        const el = id => document.getElementById(id);
        const art = el('np-art');
        const title = el('np-title');
        const artist = el('np-artist');
        const album = el('np-album-title');

        if (art) {
            const url = Resolver.getCoverUrl(track);
            art.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '%22')}")` : '';
        }
        if (title) title.textContent = track.title;
        if (artist) artist.textContent = track.artist;
        if (album) album.textContent = track.album;
        
        this.updateTransportControls(isPlaying);
    }

    static showNowPlaying(trackOrUndefined) {
        const track = trackOrUndefined ?? store.state.currentTrack;
        if (!track) return;

        // Preview only when opening NP for a different track than the one playing
        UI._npDisplayTrack = (trackOrUndefined !== undefined && store.state.currentTrack?.id !== track.id) ? track : null;

        const npView = document.getElementById('now-playing-view');
        if (!npView) return;

        const isPlaying = UI._npDisplayTrack
            ? (store.state.currentTrack?.id === UI._npDisplayTrack.id && store.state.isPlaying)
            : store.state.isPlaying;

        npView.classList.remove('hidden', 'np-closing');
        if (UI._npDisplayTrack) npView.classList.add('np-preview');
        else npView.classList.remove('np-preview');
        document.body.classList.add('now-playing-open');
        this.updateNowPlaying(track, isPlaying);

        setTimeout(() => {
            npView.classList.add('active');
            Haptics.heavy(); // 30ms pulse for opening
            if (!UI._npDisplayTrack) {
                requestAnimationFrame(() => {
                    const npSeek = document.getElementById('np-seek-container');
                    if (npSeek) npSeek.classList.add('np-timeline-expanded');
                    document.body.classList.add('np-timeline-expanded');
                });
            }
        }, 10);

        if (!this._npGesturesBound) {
            this.initNowPlayingGestures();
            this._npGesturesBound = true;
        }
    }

    static hideNowPlaying() {
        UI._npDisplayTrack = null;
        UI._npPendingSeekPercent = null;
        UI._lastCurrentTrackId = store.state.currentTrack?.id ?? null;
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;

        const npSeek = document.getElementById('np-seek-container');
        if (npSeek) npSeek.classList.remove('np-timeline-expanded');
        document.body.classList.remove('np-timeline-expanded');

        const closeDurationMs = 692; /* matches np-closing transition duration */

        npView.classList.add('np-closing');
        npView.offsetHeight; /* force reflow so close transition is applied */
        npView.classList.remove('active', 'np-preview');
        npView.style.transform = '';
        document.body.classList.remove('now-playing-open');
        setTimeout(() => {
            if (!npView.classList.contains('active')) {
                npView.classList.add('hidden');
                npView.classList.remove('np-closing');
            }
        }, closeDurationMs);
    }

    static showSoundMash() {
        const view = document.getElementById('soundmash-view');
        if (!view) return;
        view.classList.remove('hidden');
        requestAnimationFrame(() => view.classList.add('active'));
        Haptics.heavy();
    }

    static hideSoundMash() {
        const view = document.getElementById('soundmash-view');
        if (!view) return;
        view.classList.remove('active');
        view.style.transform = '';
        setTimeout(() => {
            if (!view.classList.contains('active')) view.classList.add('hidden');
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
            const roots = ['home', 'favourites', 'playlists', 'artists', 'downloader', 'settings'];
            if (roots.includes(this.currentView) && roots.includes(viewId)) this.viewStack = [];
            else this.viewStack.push(this.currentView);
        }

        // --- PERFORM STACKING TRANSITION ---
        
        // 1. Prepare Outgoing (Stays in background)
        if (oldView) {
            oldView.classList.add('view-outgoing');
        }

        // 2. Prepare Incoming (Slides OVER) — left-of-center nav pages slide from left, right-of-center from right
        const navLeft = ['home', 'favourites', 'playlists'];
        const navRight = ['artists', 'downloader', 'settings'];
        const slideFromLeft = navLeft.includes(viewId);
        const slideFromRight = navRight.includes(viewId);
        const slideClass = slideFromLeft ? 'view-from-left' : slideFromRight ? 'view-from-right' : (direction === 'forward' ? 'view-from-right' : 'view-from-left');
        targetView.classList.remove('hidden');
        targetView.classList.add('view-incoming');
        targetView.classList.add(slideClass);
        
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

        const dlSearchSourceWrap = document.getElementById('dl-search-source-wrap');
        if (dlSearchSourceWrap) {
            if (viewId === 'downloader') {
                dlSearchSourceWrap.classList.remove('hidden');
                dlSearchSourceWrap.setAttribute('aria-hidden', 'false');
            } else {
                dlSearchSourceWrap.classList.add('hidden');
                dlSearchSourceWrap.setAttribute('aria-hidden', 'true');
            }
        }

        const queueContainer = document.getElementById('queue-container');
        if (queueContainer) {
            if (viewId === 'downloader') queueContainer.classList.add('hidden');
            else queueContainer.classList.remove('hidden');
        }

        if (viewId === 'artists' && typeof window.syncArtistGridIndicators === 'function') {
            window.syncArtistGridIndicators(store.state);
        }
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
            if (this.currentView === 'downloader') {
                const dlq = document.getElementById('dl-queue-container');
                if (dlq && !dlq.contains(e.target)) Downloader.hideDownloadQueue?.();
            } else {
                const q = document.getElementById('queue-container');
                if (q && !q.contains(e.target)) this.hideQueue();
            }
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

        // Seek helpers
        const calculateSeekPercent = (e, container) => {
            const rect = container.getBoundingClientRect();
            const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? e.touches?.[0]?.clientX;
            if (clientX == null) return null;
            const x = clientX - rect.left;
            return Math.max(0, Math.min(100, (x / rect.width) * 100));
        };

        const handleSeek = (e, container) => {
            const pct = calculateSeekPercent(e, container);
            if (pct == null) return;
            audioEngine.seek(pct);
        };

        let lastDuration = 0;
        /** Min % for omnibar current-time label so it stays visible (not behind island rounded corner). Once bar passes this, label follows bar. */
        const OMNI_CURRENT_LABEL_MIN_PCT = 8;
        const updateTimeLabels = (progress, currentTime, duration) => {
            const dur = duration ?? lastDuration;
            const cur = currentTime ?? (dur * (progress / 100));
            lastDuration = dur;
            const omniCurrent = document.getElementById('omni-time-current');
            const omniDuration = document.getElementById('omni-time-duration');
            if (omniCurrent) {
                omniCurrent.textContent = UI.formatTime(cur);
                omniCurrent.style.left = `${Math.max(progress, OMNI_CURRENT_LABEL_MIN_PCT)}%`;
            }
            if (omniDuration) omniDuration.textContent = UI.formatTime(dur);
            const npCurrent = document.getElementById('np-time-current');
            const npDuration = document.getElementById('np-time-duration');
            if (npCurrent) {
                npCurrent.textContent = UI.formatTime(cur);
                npCurrent.style.left = `${progress}%`;
            }
            if (npDuration) npDuration.textContent = UI.formatTime(dur);
        };

        // Drag state for omnibar (single timebar)
        let isDraggingOmni = false;
        let omniDragPointerId = null;
        let omniHasDragged = false;

        // Omnibar timeline drag handler (only timebar)
        const omniTrack = document.getElementById('omni-progress-track');
        if (omniTrack) {
            const omniProgressBar = document.getElementById('omni-progress');
            
            const onOmniStart = (e) => {
                if (isDraggingOmni) return;
                e.preventDefault();
                e.stopPropagation();
                isDraggingOmni = true;
                omniHasDragged = false;
                omniDragPointerId = e.pointerId;
                omniTrack.setPointerCapture(e.pointerId);
                omniTrack.classList.add('seeking');
                
                const pct = calculateSeekPercent(e, omniTrack);
                if (pct != null && omniProgressBar) {
                    omniProgressBar.style.transition = 'none';
                    omniProgressBar.style.width = `${pct}%`;
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };

            const onOmniMove = (e) => {
                if (!isDraggingOmni || e.pointerId !== omniDragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                omniHasDragged = true;
                const pct = calculateSeekPercent(e, omniTrack);
                if (pct != null && omniProgressBar) {
                    omniProgressBar.style.width = `${pct}%`;
                    // Throttled seek during drag for responsiveness
                    if (!omniTrack._lastSeekTime || Date.now() - omniTrack._lastSeekTime > 50) {
                        audioEngine.seek(pct);
                        omniTrack._lastSeekTime = Date.now();
                    }
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };

            const onOmniEnd = (e) => {
                if (!isDraggingOmni || e.pointerId !== omniDragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                const wasDragging = omniHasDragged;
                isDraggingOmni = false;
                omniDragPointerId = null;
                omniTrack.releasePointerCapture(e.pointerId);
                omniTrack.classList.remove('seeking');
                
                const pct = calculateSeekPercent(e, omniTrack);
                if (pct != null) {
                    audioEngine.seek(pct);
                    if (omniProgressBar) {
                        omniProgressBar.style.transition = '';
                    }
                }
                
                // Prevent click if we dragged
                if (wasDragging) {
                    setTimeout(() => { omniHasDragged = false; }, 100);
                }
            };

            omniTrack.addEventListener('pointerdown', onOmniStart);
            omniTrack.addEventListener('pointermove', onOmniMove);
            omniTrack.addEventListener('pointerup', onOmniEnd);
            omniTrack.addEventListener('pointercancel', onOmniEnd);
            
            // Fallback click handler for tap (non-drag)
            omniTrack.addEventListener('click', (e) => {
                if (!omniHasDragged) {
                    const pct = calculateSeekPercent(e, omniTrack);
                    if (pct != null) handleSeek(e, omniTrack);
                }
            });
        }

        // NP timeline seek bar (expanded in current track's NP only)
        let isDraggingNp = false;
        let npDragPointerId = null;
        let npHasDragged = false;
        const npSeekContainer = document.getElementById('np-seek-container');
        const npSeekProgress = document.getElementById('np-seek-progress');
        if (npSeekContainer && npSeekProgress) {
            const onNpStart = (e) => {
                if (isDraggingNp) return;
                if (!document.body.classList.contains('np-timeline-expanded')) return;
                e.preventDefault();
                e.stopPropagation();
                isDraggingNp = true;
                npHasDragged = false;
                npDragPointerId = e.pointerId;
                npSeekContainer.setPointerCapture(e.pointerId);
                npSeekContainer.classList.add('seeking');
                const pct = calculateSeekPercent(e, npSeekContainer);
                if (pct != null) {
                    npSeekProgress.style.transition = 'none';
                    npSeekProgress.style.width = `${pct}%`;
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };
            const onNpMove = (e) => {
                if (!isDraggingNp || e.pointerId !== npDragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                npHasDragged = true;
                const pct = calculateSeekPercent(e, npSeekContainer);
                if (pct != null) {
                    npSeekProgress.style.width = `${pct}%`;
                    if (!npSeekContainer._lastSeekTime || Date.now() - npSeekContainer._lastSeekTime > 50) {
                        audioEngine.seek(pct);
                        npSeekContainer._lastSeekTime = Date.now();
                    }
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };
            const onNpEnd = (e) => {
                if (!isDraggingNp || e.pointerId !== npDragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                const wasDragging = npHasDragged;
                isDraggingNp = false;
                npDragPointerId = null;
                npSeekContainer.releasePointerCapture(e.pointerId);
                npSeekContainer.classList.remove('seeking');
                const pct = calculateSeekPercent(e, npSeekContainer);
                if (pct != null) {
                    audioEngine.seek(pct);
                    npSeekProgress.style.transition = '';
                }
                if (wasDragging) setTimeout(() => { npHasDragged = false; }, 100);
            };
            npSeekContainer.addEventListener('pointerdown', onNpStart);
            npSeekContainer.addEventListener('pointermove', onNpMove);
            npSeekContainer.addEventListener('pointerup', onNpEnd);
            npSeekContainer.addEventListener('pointercancel', onNpEnd);
            npSeekContainer.addEventListener('click', (e) => {
                if (!npHasDragged) {
                    const pct = calculateSeekPercent(e, npSeekContainer);
                    if (pct != null) handleSeek(e, npSeekContainer);
                }
            });
        }

        // Block page scroll while dragging omnibar or NP timeline
        document.addEventListener('touchmove', (e) => {
            if ((isDraggingOmni || isDraggingNp) && e.cancelable) {
                e.preventDefault();
            }
        }, { passive: false });
        document.addEventListener('wheel', (e) => {
            if (isDraggingOmni || isDraggingNp) {
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('audio:timeupdate', (e) => {
            const { progress, currentTime, duration } = e.detail;

            if (isDraggingOmni) return;

            const omniBar = document.getElementById('omni-progress');
            if (omniBar) omniBar.style.width = `${progress}%`;

            if (!isDraggingNp && document.body.classList.contains('np-timeline-expanded')) {
                const npBar = document.getElementById('np-seek-progress');
                if (npBar) npBar.style.width = `${progress}%`;
            }

            updateTimeLabels(progress, currentTime, duration);
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
        let isEdgeSwipeFromSoundMash = false;
        let longPressTimer = null;
        let longPressTriggered = false;

        document.addEventListener('touchstart', (e) => {
            const touch = e.touches[0];
            const row = e.target.closest('.song-row');
            
            startX = touch.clientX;
            startY = touch.clientY;
            isHorizontal = false;
            isEdgeSwipe = false;

            // Clear any existing long press timer
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            longPressTriggered = false;

            // 1. Edge Swipe Detection (from left: back to home; when SoundMash open, closes SoundMash)
            if (startX < 40) {
                isEdgeSwipe = true;
                isEdgeSwipeFromSoundMash = document.getElementById('soundmash-view')?.classList.contains('active') ?? false;
                if (isEdgeSwipeFromSoundMash) {
                    const sm = document.getElementById('soundmash-view');
                    if (sm) sm.style.transition = 'none';
                } else {
                    this.content.style.transition = 'none';
                }
                return;
            }

            const holdMsFull = 480;   /* hold anywhere on row/item */
            const holdMsCover = Math.round(holdMsFull * 0.7); /* 70% when on cover */

            // 2. Queue item: long-press anywhere -> Now Playing; on cover 70% of that time
            const queueItem = e.target.closest('.queue-item');
            if (queueItem) {
                const idx = parseInt(queueItem.getAttribute('data-index'), 10);
                const track = store.state.queue && store.state.queue[idx];
                if (track) {
                    const onCover = !!e.target.closest('.queue-item-cover');
                    const delay = onCover ? holdMsCover : holdMsFull;
                    longPressTimer = setTimeout(() => {
                        if (!isHorizontal) {
                            longPressTriggered = true;
                            this.showNowPlaying(track);
                            Haptics.heavy();
                        }
                        longPressTimer = null;
                    }, delay);
                }
                return;
            }

            // 3. Song row: long-press anywhere -> NP; on cover 70% of that time; short tap 3-dots still opens action menu
            if (row) {
                activeRow = row;
                row.style.transition = 'none';
                const trackId = row.getAttribute('data-id');
                const onCover = !!e.target.closest('.song-row-cover');
                const delay = onCover ? holdMsCover : holdMsFull;
                longPressTimer = setTimeout(() => {
                    if (!isHorizontal) {
                        longPressTriggered = true;
                        const track = typeof window.getTrackFromCurrentContext === 'function' ? window.getTrackFromCurrentContext(trackId) : null;
                        this.showNowPlaying(track ?? undefined);
                        Haptics.heavy();
                    }
                    longPressTimer = null;
                }, delay);
            }
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            const diffX = touch.clientX - startX;
            const diffY = Math.abs(touch.clientY - startY);

            // Cancel long-press on significant movement (e.g. queue item hold then drag)
            if (longPressTimer && (Math.abs(diffX) > 15 || diffY > 15)) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }

            // Edge Swipe Handling
            if (isEdgeSwipe) {
                if (e.cancelable) e.preventDefault();
                const move = Math.max(0, diffX);
                if (isEdgeSwipeFromSoundMash) {
                    const sm = document.getElementById('soundmash-view');
                    if (sm) sm.style.transform = `translateX(${move}px)`;
                } else {
                    this.content.style.transform = `translateX(${move}px)`;
                }
                return;
            }

            if (!activeRow) return;
            
            if (!isHorizontal && Math.abs(diffX) > diffY && Math.abs(diffX) > 10) {
                isHorizontal = true;
                // Cancel long press timer when swipe is detected
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
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

                if (isEdgeSwipeFromSoundMash) {
                    const sm = document.getElementById('soundmash-view');
                    if (sm) {
                        sm.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                        sm.style.transform = 'translateX(0)';
                    }
                    if (diffX > threshold) {
                        this.vibrate(20);
                        this.hideSoundMash();
                        this.showView('home', false, 'backward');
                    }
                } else {
                    this.content.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                    this.content.style.transform = 'translateX(0)';
                    if (diffX > threshold) {
                        this.vibrate(20);
                        this.navigateBack();
                    }
                }
                isEdgeSwipe = false;
                isEdgeSwipeFromSoundMash = false;
                return;
            }

            // 2. End Row Swipe
            if (activeRow) {
                const diff = e.changedTouches[0].clientX - startX;
                const trackId = activeRow.getAttribute('data-id');
                const isFav = trackId && store.state.favorites.includes(trackId);
                const isFavFirstAdd = isHorizontal && diff < -70 && !isFav &&
                    this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';

                if (isFavFirstAdd) {
                    // Exit animation: slide row left off screen, then toggle and run entrance after re-render
                    Haptics.tick();
                    this.showToast('Added to Favourites');
                    window._favFirstExitTrackId = trackId;
                    activeRow.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                    activeRow.offsetHeight; // force reflow so browser commits "from" state before "to"
                    activeRow.style.transform = 'translateX(-100vw)';
                    const rowForEnd = activeRow;
                    const onExitEnd = () => {
                        rowForEnd.removeEventListener('transitionend', onExitEnd);
                        if (trackId) {
                            store.toggleFavourite(trackId);
                            window._pendingFavFirstEntranceTrackId = trackId;
                        }
                        window._favFirstExitTrackId = undefined;
                        if (rowForEnd.parentElement) rowForEnd.parentElement.classList.remove('is-swiping');
                    };
                    activeRow.addEventListener('transitionend', onExitEnd, { once: true });
                    activeRow = null;
                } else {
                    // Fast swipe add-to-fav (favorites_first): same exit/entrance as isFavFirstAdd
                    const fastSwipeFavFirstAdd = !isHorizontal && diff < -70 && !isFav &&
                        this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';
                    if (fastSwipeFavFirstAdd) {
                        Haptics.tick();
                        this.showToast('Added to Favourites');
                        window._favFirstExitTrackId = trackId;
                        activeRow.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                        activeRow.offsetHeight;
                        activeRow.style.transform = 'translateX(-100vw)';
                        const rowForEnd = activeRow;
                        const onExitEnd = () => {
                            rowForEnd.removeEventListener('transitionend', onExitEnd);
                            if (trackId) {
                                store.toggleFavourite(trackId);
                                window._pendingFavFirstEntranceTrackId = trackId;
                            }
                            window._favFirstExitTrackId = undefined;
                            if (rowForEnd.parentElement) rowForEnd.parentElement.classList.remove('is-swiping');
                        };
                        activeRow.addEventListener('transitionend', onExitEnd, { once: true });
                        activeRow = null;
                    } else {
                        // Standard behavior: return to 0 and optionally toggle
                        activeRow.style.transition = 'transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)';
                        activeRow.style.transform = 'translateX(0)';
                        if (isHorizontal) {
                            if (diff > 70) {
                                const inQueue = store.state.queue.some(t => t.id === trackId);
                                store.toggleQueue(trackId);
                                Haptics.tick();
                                this.showToast(inQueue ? 'Removed from Queue' : 'Added to Queue');
                            } else if (diff < -70) {
                                store.toggleFavourite(trackId);
                                Haptics.tick();
                                this.showToast(isFav ? 'Removed from Favourites' : 'Added to Favourites');
                            }
                        }
                        const rowToCleanup = activeRow;
                        setTimeout(() => {
                            if (rowToCleanup && rowToCleanup.parentElement) {
                                rowToCleanup.parentElement.classList.remove('is-swiping');
                            }
                        }, 400);
                        activeRow = null;
                    }
                }
            }
            
            // Clear long press timer on touch end
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }, { passive: true });

        // Prevent click events after long press (song row or queue item cover)
        document.addEventListener('click', (e) => {
            if (longPressTriggered) {
                const row = e.target.closest('.song-row');
                const queueItem = e.target.closest('.queue-item');
                if (row || queueItem) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    longPressTriggered = false;
                    return false;
                }
            }
        }, { capture: true });

        // No-action zones: do not trigger row default action (e.g. play) on tap/long-press release
        document.addEventListener('click', (e) => {
            const row = e.target.closest('.song-row');
            const noAction = e.target.closest('.no-row-action');
            if (!row || !noAction || !row.contains(noAction)) return;
            const claimedBy = e.target.closest('[onclick]');
            if (claimedBy === row) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, { capture: true });

        // Action Menu Swipe-to-Dismiss logic
        this.initBottomSheetGestures();
    }

    static initNowPlayingGestures() {
        const npView = document.getElementById('now-playing-view');
        if (!npView) return;

        let startY = 0;
        let isDragging = false;
        let touchStartedOnSeekBar = false;
        const dragThreshold = 8;
        const closeThreshold = window.innerHeight * 0.08;

        npView.addEventListener('touchstart', (e) => {
            if (e.target.closest('button')) return;
            if (e.target.closest('#np-seek-container')) {
                touchStartedOnSeekBar = true;
                return;
            }
            touchStartedOnSeekBar = false;
            startY = e.touches[0].clientY;
            isDragging = false;
        }, { passive: true });

        npView.addEventListener('touchmove', (e) => {
            if (touchStartedOnSeekBar) return;
            const deltaY = e.touches[0].clientY - startY;
            if (!isDragging && deltaY > dragThreshold) isDragging = true;
        }, { passive: true });

        npView.addEventListener('touchend', (e) => {
            if (touchStartedOnSeekBar) {
                touchStartedOnSeekBar = false;
                return;
            }
            if (!isDragging) return;
            isDragging = false;
            const deltaY = e.changedTouches[0].clientY - startY;
            if (deltaY > closeThreshold) {
                Haptics.lock();
                this.hideNowPlaying();
            }
        }, { passive: true });

        const npArt = document.getElementById('np-art');
        if (npArt) {
            let coverStartTime = 0, coverStartX = 0, coverStartY = 0, coverMaxDelta = 0;
            let coverTapHandled = false; /* avoid double-fire when touch triggers click */
            const playPreviewTrackAndExpandTimeline = () => {
                if (!UI._npDisplayTrack || store.state.currentTrack?.id === UI._npDisplayTrack.id) return false;
                Haptics.tick();
                window.playTrack(UI._npDisplayTrack.id);
                UI._npDisplayTrack = null;
                const npViewEl = document.getElementById('now-playing-view');
                if (npViewEl) npViewEl.classList.remove('np-preview');
                const npSeekEl = document.getElementById('np-seek-container');
                if (npSeekEl) npSeekEl.classList.add('np-timeline-expanded');
                document.body.classList.add('np-timeline-expanded');
                return true;
            };
            npArt.addEventListener('touchstart', (e) => {
                const t = e.touches[0];
                coverStartTime = Date.now();
                coverStartX = t.clientX;
                coverStartY = t.clientY;
                coverMaxDelta = 0;
            }, { passive: true });
            npArt.addEventListener('touchmove', (e) => {
                const t = e.touches[0];
                const dx = t.clientX - coverStartX;
                const dy = t.clientY - coverStartY;
                coverMaxDelta = Math.max(coverMaxDelta, Math.hypot(dx, dy));
            }, { passive: true });
            npArt.addEventListener('touchend', (e) => {
                const t = e.changedTouches[0];
                const duration = Date.now() - coverStartTime;
                const dx = t.clientX - coverStartX;
                const dy = t.clientY - coverStartY;
                const movement = Math.hypot(dx, dy);
                const validTap = duration >= 100 && duration <= 450 && movement < 12 &&
                    UI._npDisplayTrack && store.state.currentTrack?.id !== UI._npDisplayTrack.id;
                if (!validTap) return;
                if (playPreviewTrackAndExpandTimeline()) {
                    coverTapHandled = true;
                    setTimeout(() => { coverTapHandled = false; }, 300);
                }
            }, { passive: true });
            npArt.addEventListener('click', (e) => {
                if (coverTapHandled) return;
                if (!UI._npDisplayTrack || store.state.currentTrack?.id === UI._npDisplayTrack.id) return;
                e.preventDefault();
                e.stopPropagation();
                playPreviewTrackAndExpandTimeline();
            });
        }
    }

    static initOmniIsland() {
        this.island = document.getElementById('omni-island');
        this.anchor = document.getElementById('omni-anchor');
        this.omniPrev = document.getElementById('omni-prev');
        this.omniNext = document.getElementById('omni-next');
        this.omniProgress = document.getElementById('omni-progress');
        
        if (!this.island || !this.anchor) return;

        // Sync progress track (and time labels) to collapsed state on load so labels are not visible before first touch
        const omniProgressTrack = document.getElementById('omni-progress-track');
        if (omniProgressTrack) {
            omniProgressTrack.style.transition = 'opacity 0.28s ease';
            omniProgressTrack.style.opacity = (this.isIslandActive && !this.islandUserCollapsed) ? '1' : '0';
        }

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
        this._soundMashHoldTimer = null;
        this._soundMashHoldTimerStarted = false;
        this._soundMashOpenedThisGesture = false;

        const startBloom = (e) => {
            if (document.getElementById('soundmash-view')?.classList.contains('active')) {
                e.preventDefault();
                return;
            }
            const touch = e.touches[0];
            const rect = island.getBoundingClientRect();
            this._startedInside = touch.clientX >= rect.left && touch.clientX <= rect.right && 
                                 touch.clientY >= rect.top && touch.clientY <= rect.bottom;

            this._isHolding = true;
            this._startY = touch.clientY;
            this._currentY = this._startY;
            this._soundMashHoldTimerStarted = false;
            this._soundMashOpenedThisGesture = false;
            if (this._soundMashHoldTimer) clearTimeout(this._soundMashHoldTimer);
            this._soundMashHoldTimer = null;
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
                    const omniProgressTrack = document.getElementById('omni-progress-track');

                    if (transport) {
                        transport.style.filter = 'blur(12px)';
                        transport.style.opacity = '0';
                        transport.style.transform = 'scale(0.9)';
                        transport.style.pointerEvents = 'none';
                    }
                    if (metadata) {
                        metadata.style.opacity = '0';
                    }
                    if (omniProgressTrack) {
                        omniProgressTrack.style.transition = 'opacity 0.28s ease';
                        omniProgressTrack.style.opacity = '0';
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
            if (this._soundMashHoldTimer) clearTimeout(this._soundMashHoldTimer);
            this._soundMashHoldTimer = null;

            // 0. SWIPE GESTURES FOR NOW PLAYING (Instant Toggle with 15px deadzone)
            const deadzone = 15;
            const expandSwipeThreshold = 10; // Softer threshold so slightly slower swipe still expands from dot
            if (this._isHolding && !this.isBlooming && this._startedInside && isHorizontalValid) {
                const isNPActive = document.getElementById('now-playing-view')?.classList.contains('active');

                // Swipe up when manually collapsed: uncollapse only (unless we opened SoundMash via hold)
                if (deltaY < -expandSwipeThreshold && this.islandUserCollapsed) {
                    if (this._soundMashOpenedThisGesture) {
                        this.resetOmniIsland();
                        return;
                    }
                    this.islandUserCollapsed = false;
                    this.resetOmniIsland();
                    return;
                }
                if (deltaY < -deadzone && !isNPActive) {
                    this.showNowPlaying();
                    this.resetOmniIsland();
                    return;
                } else if (deltaY > deadzone && isNPActive) {
                    this.hideNowPlaying();
                    this.resetOmniIsland();
                    return;
                } else if (deltaY < -deadzone && isNPActive) {
                    if (UI._npDisplayTrack) {
                        window.playTrack(UI._npDisplayTrack.id);
                        UI._npDisplayTrack = null;
                        const npViewEl = document.getElementById('now-playing-view');
                        if (npViewEl) npViewEl.classList.remove('np-preview');
                        const npSeekEl = document.getElementById('np-seek-container');
                        if (npSeekEl) npSeekEl.classList.add('np-timeline-expanded');
                        document.body.classList.add('np-timeline-expanded');
                    }
                    this.resetOmniIsland();
                    return;
                }
            }

            // 0b. SWIPE DOWN: collapse playback bar to blank (seed) form when not closing Now Playing
            const isNPActive = document.getElementById('now-playing-view')?.classList.contains('active');
            if (this._isHolding && !this.isBlooming && this._startedInside && isHorizontalValid &&
                this.isIslandActive && !isNPActive && deltaY > deadzone) {
                this.islandUserCollapsed = true;
                this.resetOmniIsland();
                return;
            }
            
            // 1. COORDINATE-BASED TRANSPORT (disabled when manually collapsed)
            if (this._isHolding && !this.isBlooming && isInside) {
                const tapExpandDeadzone = 12;
                if (this.islandUserCollapsed) {
                    if (Math.abs(deltaY) <= tapExpandDeadzone) {
                        this.islandUserCollapsed = false;
                        this.resetOmniIsland();
                        return;
                    }
                    return;
                }

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
                    if (UI._npDisplayTrack) {
                        audioEngine.toggle();
                    } else if (store.state.currentTrack) {
                        audioEngine.toggle();
                    }
                }
            }

            // 2. NAV COMMIT (Uses elementFromPoint but hides touchArea first)
            if (this.isBlooming && this._activeNavView) {
                Haptics.lock();
                const viewToShow = this._activeNavView;
                
                // Check if selected entry equals current entry
                if (viewToShow === this.currentView) {
                    // Fade out at current position, then fade in at center
                    label.classList.add('fade-out');
                    
                    setTimeout(() => {
                        // Move to center and prepare for fade in
                        label.style.setProperty('--tx', '0px');
                        label.style.removeProperty('transform');
                        label.classList.remove('hovered', 'fade-out');
                        label.classList.add('fade-in');
                        
                        // Force reflow, then trigger fade in animation
                        requestAnimationFrame(() => {
                            label.classList.add('fade-in-active');
                            
                            setTimeout(() => {
                                label.classList.remove('fade-in', 'fade-in-active');
                                label.classList.add('docked');
                            }, 200);
                        });
                    }, 200);
                } else {
                    // showView will handle search form transformation
                    this.showView(viewToShow);
                    
                    // Dock the Label with bounce animation
                    label.classList.remove('hovered');
                    label.classList.add('docked');
                    label.style.removeProperty('transform');
                    label.style.setProperty('--tx', '0px');
                }
            }

            this.resetOmniIsland();
        };

        // Bind events to the Hitbox Layer
        touchArea.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startBloom(e);
        });

        touchArea.addEventListener('click', (e) => {
            if (document.getElementById('soundmash-view')?.classList.contains('active')) return;
            if (this.islandUserCollapsed && this.isIslandActive) {
                e.preventDefault();
                e.stopPropagation();
                this.islandUserCollapsed = false;
                this.resetOmniIsland();
            }
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
                    const itemsArr = Array.from(items);
                    
                    // Full viewport width for X mapping (same idea as bottom not losing control: extremes register)
                    const trackLeft = 0;
                    const trackWidth = window.innerWidth || document.documentElement.clientWidth;
                    const touchX = touch.clientX - trackLeft;
                    const slotWidth = trackWidth / 7;
                    let index = Math.floor(touchX / slotWidth);
                    index = Math.max(0, Math.min(6, index));
                    
                    // Correct for the blank center spacer (index 3)
                    if (index < 3) item = itemsArr[index];
                    else if (index > 3) item = itemsArr[index - 1];
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

                // When omnibar is in seed form (manually collapsed or no playback): swipe up and hold opens SoundMash (~392ms hold)
                const deadzone = 15;
                const soundMashHoldMs = 392;
                const isSeedForm = this.islandUserCollapsed || !this.isIslandActive;
                if (isSeedForm && deltaY < -deadzone && isHorizontalValid && !this._soundMashHoldTimerStarted) {
                    this._soundMashHoldTimerStarted = true;
                    this._soundMashHoldTimer = setTimeout(() => {
                        this._soundMashHoldTimer = null;
                        this.showSoundMash();
                        this._soundMashOpenedThisGesture = true;
                        this.resetOmniIsland();
                    }, soundMashHoldMs);
                }

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
        if (this.isIslandActive && !this.islandUserCollapsed) this.island.style.width = '250px';
        else this.island.style.width = '56px';

        this.island.style.transform = ''; // Clear swipe displacement

        const omniProgressTrack = document.getElementById('omni-progress-track');
        const transportFadeDuration = '0.4s';
        if (transport) {
            transport.style.transition = `opacity ${transportFadeDuration} ease, filter 0.3s ease, transform 0.3s ease`;
            if (this.isIslandActive && !this.islandUserCollapsed) {
                transport.style.filter = 'blur(0px)';
                transport.style.opacity = '1';
                transport.style.transform = 'scale(1)';
                transport.style.pointerEvents = 'auto';
            } else {
                transport.style.opacity = '0';
                transport.style.pointerEvents = 'none';
            }
        }
        if (omniProgressTrack) {
            omniProgressTrack.style.transition = `opacity ${transportFadeDuration} ease`;
            omniProgressTrack.style.opacity = (this.isIslandActive && !this.islandUserCollapsed) ? '1' : '0';
        }

        const metadata = document.getElementById('omni-metadata-container');
        if (metadata) {
            metadata.style.transition = `opacity ${transportFadeDuration} ease`;
            metadata.style.opacity = (this.isIslandActive && !this.islandUserCollapsed) ? '1' : '0';
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
            el('action-fav').onclick = () => {
                const trackId = this.currentActionTrack.id;
                const isFav = store.state.favorites.includes(trackId);
                const onHomeFavFirst = this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';
                if (onHomeFavFirst && !isFav) {
                    const container = document.getElementById('all-songs');
                    const row = container && container.querySelector(`.song-row[data-id="${CSS.escape(trackId)}"]`);
                    if (row) {
                        this.hideActionMenu();
                        Haptics.tick();
                        this.showToast('Added to Favourites');
                        window._favFirstExitTrackId = trackId;
                        row.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                        row.offsetHeight;
                        row.style.transform = 'translateX(-100vw)';
                        const onExitEnd = () => {
                            row.removeEventListener('transitionend', onExitEnd);
                            store.toggleFavourite(trackId);
                            window._pendingFavFirstEntranceTrackId = trackId;
                            window._favFirstExitTrackId = undefined;
                            if (row.parentElement) row.parentElement.classList.remove('is-swiping');
                        };
                        row.addEventListener('transitionend', onExitEnd, { once: true });
                        return;
                    }
                }
                store.toggleFavourite(trackId);
                this.hideActionMenu();
            };
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
            const threshold = window.innerHeight * 0.08; // Same as NP swipe-to-close
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
            <div class="flex items-center p-3 hover:bg-[var(--surface-overlay)] rounded-[var(--radius-omni-sm)] cursor-pointer transition-colors border border-transparent active:border-[var(--accent)]/30 active:bg-[var(--accent)]/5" onclick="UI.applyFetchedMetadata('${r.title.replace(/'/g, "\\'")}', '${r.artist.replace(/'/g, "\\'")}', '${r.album.replace(/'/g, "\\'")}', '${r.cover}')">
                <img src="${r.cover}" class="w-10 h-10 rounded-[var(--radius-omni-xs)] object-cover shadow-md">
                <div class="ml-3 truncate">
                    <div class="text-xs font-bold truncate text-[var(--text-main)]">${r.title}</div>
                    <div class="text-[9px] font-bold text-[var(--text-dim)] truncate uppercase tracking-widest font-mono">${r.artist}</div>
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
        t.className = 'glass-view px-6 py-3 rounded-full shadow-2xl text-[10px] font-black uppercase tracking-[0.2em] font-mono text-[var(--text-main)] transition-all duration-500 ease-[cubic-bezier(0.19,1,0.22,1)] transform translate-y-10 opacity-0 border border-[var(--glass-border)]';
        t.style.backdropFilter = 'blur(32px)';
        t.style.webkitBackdropFilter = 'blur(32px)';
        t.style.backgroundColor = 'var(--bg-surface)';
        t.textContent = m;
        c.appendChild(t);
        setTimeout(() => { t.classList.replace('translate-y-10', 'translate-y-0'); t.classList.replace('opacity-0', 'opacity-100'); }, 10);
        setTimeout(() => { t.classList.replace('translate-y-0', 'translate-y-10'); t.classList.replace('opacity-100', 'opacity-0'); setTimeout(() => t.remove(), 500); }, 2500);
    }
}
window.UI = UI;
