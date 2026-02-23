/**
 * UI Component Manager
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { formatTime } from './renderers.js';
import { audioEngine } from './audio.js';
import { Haptics } from './haptics.js';
import { wireActionMenu } from './wires.js';

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
        'playlist-detail': 'PLAYLIST',
        'downloader': 'ODST',
        'settings': 'CONFIG'
    };

    static init() {
        console.log("UI: Initializing Omni-Island Core...");
        const d = document.getElementById.bind(document);
        this.dom = {
            content: d('content'),
            allSongs: d('all-songs'),
            omniLabel: d('omni-label'),
            omniLabelContainer: d('omni-label-container'),
            nowPlayingView: d('now-playing-view'),
            npSeekContainer: d('np-seek-container'),
            queueFab: d('queue-fab'),
            queueBadge: d('queue-badge'),
            omniAnchorIcon: d('omni-anchor-icon'),
            omniMetadataContainer: d('omni-metadata-container'),
            omniMetadata: d('omni-metadata'),
            omniText1: d('omni-text-1'),
            omniText2: d('omni-text-2'),
            omniPrev: d('omni-prev'),
            omniNext: d('omni-next'),
            omniTransport: d('omni-transport'),
            omniProgressTrack: d('omni-progress-track'),
            omniIslandContainer: d('omni-island-container'),
            settingsThemeSelect: d('settings-theme-select'),
            hapticsIndicator: d('haptics-indicator'),
            settingsLibraryOrder: d('settings-library-order'),
            statusLed: d('status-led'),
            statusLedPulse: d('status-led-pulse'),
            serverStatus: d('server-status'),
            activeHostDisplay: d('active-host-display'),
            fullCoverOverlay: d('full-cover-overlay'),
            fullCoverImage: d('full-cover-image'),
            fullCoverOverlayBackdrop: d('full-cover-overlay-backdrop'),
            fullCoverCloseBottom: d('full-cover-close-bottom'),
            soundmashView: d('soundmash-view'),
            queuePopover: d('queue-popover'),
            queueContainer: d('queue-container'),
            dlSearchSourceWrap: d('dl-search-source-wrap'),
            dlQueueContainer: d('dl-queue-container'),
            omniTimeCurrent: d('omni-time-current'),
            omniTimeDuration: d('omni-time-duration'),
            npTimeCurrent: d('np-time-current'),
            npTimeDuration: d('np-time-duration'),
            omniProgress: d('omni-progress'),
            npSeekProgress: d('np-seek-progress'),
            npArt: d('np-art'),
            npTitle: d('np-title'),
            npArtist: d('np-artist'),
            npAlbumTitle: d('np-album-title'),
            desktopApp: d('desktop-app'),
            omniIsland: d('omni-island'),
            omniAnchor: d('omni-anchor'),
            omniTouchArea: d('omni-touch-area'),
            omniNavRibbon: d('omni-nav-ribbon'),
            actionMenu: d('action-menu'),
            actionMenuOverlay: d('action-menu-overlay'),
            actionMenuSheet: d('action-menu-sheet'),
            metadataEditor: d('metadata-editor'),
            metadataEditorContent: d('metadata-editor-content'),
            editTitle: d('edit-title'),
            editArtist: d('edit-artist'),
            editAlbum: d('edit-album'),
            editCoverPreview: d('edit-cover-preview'),
            editSaveBtn: d('edit-save-btn'),
            editAutoFetchBtn: d('edit-auto-fetch-btn'),
            editUploadBtn: d('edit-upload-btn'),
            editFileInput: d('edit-file-input'),
            editStatus: d('edit-status'),
            autoFetchResults: d('auto-fetch-results'),
            toastContainer: d('toast-container'),
            miniPlayBtn: d('mini-play-btn'),
            miniRepeatBtn: d('mini-repeat-btn'),
            omniRepeatBtn: d('omni-repeat-btn'),
            omniRepeatOneIndicator: d('omni-repeat-one-indicator'),
            miniRepeatOneIndicator: d('mini-repeat-one-indicator'),
            miniShuffleBtn: d('mini-shuffle-btn'),
            omniShuffleBtn: d('omni-shuffle-btn'),
            miniNextBtn: d('mini-next-btn'),
            miniPrevBtn: d('mini-prev-btn')
        };
        this.content = this.dom.content;
        // Platform Detection: Notch Safety
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad Pro
        if (isIOS) document.body.classList.add('is-ios');

        // Navigation State
        this.viewStack = [];
        this.currentView = 'home';
        this._npGesturesBound = false;
        this._npCurrentTrackOpen = false; // true when NP is open for the *currently playing* track (labels fade out)
        this._npViewOpen = false; // true when Now Playing view is visible (omni label fades out)
        this.isIslandActive = false;
        this.isBlooming = false;
        this.isDraggingQueue = false;
        this._keyboardHeight = 0;
        this._platform = this.detectPlatform();

        this.initGlobalListeners();
        this.initOmniIsland();
        this.initKeyboardSync();
        this.updateLabel(this.currentView);
        store.subscribe((state) => this.updatePlayer(state));
        this.updatePlayer(store.state);

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

        // Action menu: wire buttons once (shared wires.js)
        wireActionMenu({
            overlay: 'action-menu-overlay',
            queueBtn: 'action-queue',
            editBtn: 'action-edit-metadata',
            favBtn: 'action-fav',
            addToPlaylistBtn: 'action-add-to-playlist',
            deleteBtn: 'action-delete',
            removeFromPlaylistBtn: 'action-remove-from-playlist'
        }, {
            store,
            getCurrentActionTrack: () => this.currentActionTrack,
            onClose: () => this.hideActionMenu(),
            onShowMetadataEditor: (id) => this.showMetadataEditor(id),
            onAddToPlaylist: (trackId) => typeof window.showAddToPlaylistPicker === 'function' && window.showAddToPlaylistPicker(trackId),
            onRemoveFromPlaylist: (track) => {
                const name = window.viewContext?.currentPlaylistName;
                if (name && track) store.removeFromPlaylist(name, track.id);
                this.hideActionMenu();
            },
            onFavClick: (track) => {
                if (!track) return;
                const trackId = track.id;
                const isFav = store.state.favorites.includes(trackId);
                const onHomeFavFirst = this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';
                if (onHomeFavFirst && !isFav) {
                    const container = this.dom.allSongs;
                    const row = container && container.querySelector(`.song-row[data-id="${CSS.escape(trackId)}"]`);
                    if (row && typeof window.scheduleFavFirstAnimation === 'function') {
                        this.hideActionMenu();
                        Haptics.tick();
                        this.showToast('Added to Favourites');
                        window.scheduleFavFirstAnimation(trackId, row);
                        return;
                    }
                }
                store.toggleFavourite(trackId);
                this.hideActionMenu();
            }
        });
    }

    static updateLabel(viewId) {
        const label = this.dom.omniLabel;
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
            if (this.dom.nowPlayingView?.classList.contains('active')) {
                // Clear preview only when the *playing* track actually changed (user skipped), not on play/pause or seek
                const playingTrackJustChanged = state.currentTrack && UI._lastCurrentTrackId !== state.currentTrack.id;
                if (UI._npDisplayTrack && playingTrackJustChanged && state.currentTrack.id !== UI._npDisplayTrack.id) {
                    UI._npDisplayTrack = null;
                    if (this.dom.nowPlayingView) this.dom.nowPlayingView.classList.remove('np-preview');
                }
                const displayTrack = UI._npDisplayTrack || state.currentTrack;
                const isPlaying = UI._npDisplayTrack
                    ? (state.currentTrack?.id === UI._npDisplayTrack.id && state.isPlaying)
                    : state.isPlaying;
                this.updateNowPlaying(displayTrack, isPlaying);
                // Timeline expands only when current track's NP (not preview)
                const npSeek = this.dom.npSeekContainer;
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
        const fab = this.dom.queueFab;
        const badge = this.dom.queueBadge;
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

        // Real-time UI Sync: expanded = play/pause; collapsed = always grid (hold hint)
        const anchorIcon = this.dom.omniAnchorIcon;
        if (!anchorIcon) return;
        if (this.isIslandActive) {
            anchorIcon.classList.remove('omni-grid-hint-pulse');
            anchorIcon.className = state.isPlaying ? 'fas fa-pause text-lg text-[var(--text-main)]' : 'fas fa-play text-lg text-[var(--text-main)] ml-1';
            this.updateMetadataScroller(state.currentTrack);
        } else {
            anchorIcon.className = 'fas fa-th-large text-lg text-[var(--text-main)] omni-grid-hint-pulse';
        }
    }

    static updateMetadataScroller(track) {
        if (!track) return;
        const container = this.dom.omniMetadataContainer;
        const scroller = this.dom.omniMetadata;
        const text1 = this.dom.omniText1;
        const text2 = this.dom.omniText2;
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
        this.updateOmniMetadataVisibility();

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
        this.island.classList.remove('omni-seed');

        const prev = this.dom.omniPrev;
        const next = this.dom.omniNext;
        const anchorIcon = this.dom.omniAnchorIcon;

        if (prev) { prev.classList.remove('hidden'); setTimeout(() => { prev.classList.replace('opacity-0', 'opacity-100'); prev.classList.replace('scale-75', 'scale-100'); }, 100); }
        if (next) { next.classList.remove('hidden'); setTimeout(() => { next.classList.replace('opacity-0', 'opacity-100'); next.classList.replace('scale-75', 'scale-100'); }, 100); }
        
        if (anchorIcon) {
            anchorIcon.classList.remove('omni-grid-hint-pulse');
            anchorIcon.className = store.state.isPlaying ? 'fas fa-pause text-lg text-[var(--text-main)]' : 'fas fa-play text-lg text-[var(--text-main)] ml-1';
        }

        const transport = this.dom.omniTransport;
        const metadata = this.dom.omniMetadataContainer;
        const omniProgressTrack = this.dom.omniProgressTrack;
        const t = '0.22s';
        if (transport) {
            transport.style.transition = `opacity ${t} ease, filter 0.17s ease, transform 0.17s ease`;
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
            this.updateOmniMetadataVisibility();
        }
    }

    /** Omnibar metadata visible only when island expanded and not viewing current track's NP. */
    static updateOmniMetadataVisibility() {
        const container = this.dom.omniMetadataContainer;
        if (!container) return;
        const visible = this.isIslandActive && !this._npCurrentTrackOpen;
        container.style.opacity = visible ? '1' : '0';
    }

    /** Omni page label: hidden when NP view is open; visible when NP closed or when nav bar (ribbon) is open. */
    static updateOmniLabelVisibility() {
        const container = this.dom.omniLabelContainer;
        if (!container) return;
        const hidden = this._npViewOpen && !this.isBlooming;
        container.classList.toggle('omni-label-hidden', hidden);
    }

    static collapseToSeed() {
        this.isIslandActive = false;
        this.island.style.width = '56px';
        this.island.classList.add('omni-seed');

        const prev = this.dom.omniPrev;
        const next = this.dom.omniNext;
        const anchorIcon = this.dom.omniAnchorIcon;

        if (prev) { prev.classList.replace('opacity-100', 'opacity-0'); prev.classList.replace('scale-100', 'scale-75'); setTimeout(() => prev.classList.add('hidden'), 300); }
        if (next) { next.classList.replace('opacity-100', 'opacity-0'); next.classList.replace('scale-100', 'scale-75'); setTimeout(() => next.classList.add('hidden'), 300); }
        
        if (anchorIcon) {
            anchorIcon.className = 'fas fa-th-large text-lg text-[var(--text-main)] omni-grid-hint-pulse';
        }
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

        const container = this.dom.omniIslandContainer;
        if (!container) return;
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
        const container = this.dom.omniIslandContainer;
        if (!container) return;

        this._keyboardHeight = keyboardHeight;
        container.style.transform = `translateY(-${keyboardHeight}px)`;
    }

    static handleKeyboardClose() {
        const container = this.dom.omniIslandContainer;
        if (!container) return;

        this._keyboardHeight = 0;
        container.style.transform = '';
    }

    static updateThemeUI(theme) {
        const select = this.dom.settingsThemeSelect;
        if (select && ['dark', 'light', 'odst'].includes(theme)) select.value = theme;
    }

    static updateHapticsUI(enabled) {
        const indicator = this.dom.hapticsIndicator;
        if (indicator) {
            indicator.style.transform = enabled ? 'translateX(24px)' : 'translateX(0px)';
        }
    }

    static updateLibraryOrderUI(libraryOrder) {
        const sel = this.dom.settingsLibraryOrder;
        if (sel && libraryOrder) sel.value = libraryOrder;
    }

    static updateStatus(state) {
        const statusLed = this.dom.statusLed;
        const statusPulse = this.dom.statusLedPulse;
        const statusText = this.dom.serverStatus;
        const hostDisplay = this.dom.activeHostDisplay;

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
        const art = this.dom.npArt;
        const title = this.dom.npTitle;
        const artistEl = this.dom.npArtist;
        const album = this.dom.npAlbumTitle;

        if (art) {
            const url = Resolver.getCoverUrl(track);
            art.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '%22')}")` : '';
        }
        if (title) title.textContent = track.title;
        if (artistEl) artistEl.textContent = track.artist;
        if (album) album.textContent = track.album;
        
        this.updateTransportControls(isPlaying);
    }

    static showNowPlaying(trackOrUndefined) {
        const track = trackOrUndefined ?? store.state.currentTrack;
        if (!track) return;

        // Preview only when opening NP for a different track than the one playing
        UI._npDisplayTrack = (trackOrUndefined !== undefined && store.state.currentTrack?.id !== track.id) ? track : null;

        const npView = this.dom.nowPlayingView;
        if (!npView) return;

        const isPlaying = UI._npDisplayTrack
            ? (store.state.currentTrack?.id === UI._npDisplayTrack.id && store.state.isPlaying)
            : store.state.isPlaying;

        npView.classList.remove('hidden', 'np-closing');
        if (UI._npDisplayTrack) npView.classList.add('np-preview');
        else npView.classList.remove('np-preview');
        this._npCurrentTrackOpen = !UI._npDisplayTrack; // hide omnibar labels only when viewing current track's NP
        this._npViewOpen = true;
        this.updateOmniMetadataVisibility();
        this.updateOmniLabelVisibility();
        document.body.classList.add('now-playing-open');
        this.updateNowPlaying(track, isPlaying);

        setTimeout(() => {
            npView.classList.add('active');
            Haptics.heavy(); // 30ms pulse for opening
            if (!UI._npDisplayTrack) {
                requestAnimationFrame(() => {
                    const npSeek = this.dom.npSeekContainer;
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
        UI._npCurrentTrackOpen = false;
        this._npViewOpen = false;
        this.updateOmniMetadataVisibility();
        this.updateOmniLabelVisibility();
        UI._npPendingSeekPercent = null;
        UI._lastCurrentTrackId = store.state.currentTrack?.id ?? null;
        const npView = this.dom.nowPlayingView;
        if (!npView) return;

        const npSeek = this.dom.npSeekContainer;
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

    static showFullCoverView(coverUrl) {
        const overlay = this.dom.fullCoverOverlay;
        const img = this.dom.fullCoverImage;
        if (!overlay || !img) return;
        const url = (coverUrl || 'assets/icons/icon-512.png').replace(/"/g, '%22').replace(/'/g, '%27');
        img.style.backgroundImage = `url("${url}")`;
        overlay.classList.remove('hidden');
    }

    static hideFullCoverView() {
        const overlay = this.dom.fullCoverOverlay;
        if (overlay) overlay.classList.add('hidden');
    }

    static bindFullCoverOverlay() {
        const overlay = this.dom.fullCoverOverlay;
        const backdrop = this.dom.fullCoverOverlayBackdrop;
        const closeBottom = this.dom.fullCoverCloseBottom;
        if (!overlay) return;
        if (backdrop) backdrop.addEventListener('click', () => this.hideFullCoverView());
        if (closeBottom) closeBottom.addEventListener('click', () => this.hideFullCoverView());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.hideFullCoverView();
        });
    }

    static showSoundMash() {
        const view = this.dom.soundmashView;
        if (!view) return;
        view.classList.remove('hidden');
        requestAnimationFrame(() => view.classList.add('active'));
        Haptics.heavy();
    }

    static hideSoundMash() {
        const view = this.dom.soundmashView;
        if (!view) return;
        view.classList.remove('active');
        view.style.transform = '';
        setTimeout(() => {
            if (!view.classList.contains('active')) view.classList.add('hidden');
        }, 600);
    }

    static toggleQueue() {
        const popover = this.dom.queuePopover;
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
        const popover = this.dom.queuePopover;
        if (!popover || popover.classList.contains('hidden')) return;
        
        popover.classList.replace('scale-100', 'scale-95');
        popover.classList.replace('opacity-100', 'opacity-0');
        popover.classList.add('pointer-events-none');
        popover.style.pointerEvents = 'none'; // Block interaction
        setTimeout(() => popover.classList.add('hidden'), 300);
    }

    static showView(viewId, saveToHistory = true, direction = 'forward') {
        // Auto-hide Now Playing if active (even if selecting the same view)
        if (this.dom.nowPlayingView?.classList.contains('active')) {
            this.hideNowPlaying();
        }

        if (viewId === this.currentView) return;

        UI._viewTransitionEnd = Date.now() + 520;
        this.updateLabel(viewId);

        const oldView = document.getElementById(`view-${this.currentView}`);
        const targetView = document.getElementById(`view-${viewId}`);
        if (!targetView) return;

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
        targetView.classList.remove('hidden', 'view-warm-hidden-left', 'view-warm-hidden-right');
        targetView.classList.add('view-incoming');
        targetView.classList.add(slideClass);
        
        // Returning to artists from artist-detail: clear sticky :active from back button and suppress card feedback briefly
        const fromArtistDetail = viewId === 'artists' && this.currentView === 'artist-detail';
        if (fromArtistDetail) {
            document.activeElement?.blur?.();
            targetView.classList.add('artist-just-returned');
            setTimeout(() => targetView.classList.remove('artist-just-returned'), 320);
        }
        
        // 3. Trigger Animation — double rAF so browser can apply classes without forcing synchronous reflow
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                targetView.classList.remove('view-from-right', 'view-from-left');
                if (this.dom.content) this.dom.content.scrollTop = 0;
            });
        });

        // 4. Cleanup after transition — clear old view content, hide old view, then render new view content (Option B: no heavy DOM during slide)
        setTimeout(() => {
            const oldViewId = oldView && oldView.id ? oldView.id.replace(/^view-/, '') : null;
            if (oldViewId && typeof window.clearContentForView === 'function') {
                window.clearContentForView(oldViewId);
            }
            if (oldView && oldView.id !== `view-${viewId}`) {
                const warmViews = { 'view-home': 'view-warm-hidden-left', 'view-artists': 'view-warm-hidden-right' };
                const warmClass = warmViews[oldView.id];
                if (warmClass) {
                    oldView.classList.add(warmClass);
                } else {
                    oldView.classList.add('hidden');
                }
                oldView.classList.remove('view-outgoing');
            }
            targetView.classList.remove('view-incoming');
            UI._viewTransitionEnd = 0;
            if (typeof window.renderContentForView === 'function') {
                window.renderContentForView(viewId);
            }
        }, 500);

        this.currentView = viewId;

        const dlSearchSourceWrap = this.dom.dlSearchSourceWrap;
        if (dlSearchSourceWrap) {
            if (viewId === 'downloader') {
                dlSearchSourceWrap.classList.remove('hidden');
                dlSearchSourceWrap.setAttribute('aria-hidden', 'false');
            } else {
                dlSearchSourceWrap.classList.add('hidden');
                dlSearchSourceWrap.setAttribute('aria-hidden', 'true');
            }
        }

        const queueContainer = this.dom.queueContainer;
        if (queueContainer) {
            if (viewId === 'downloader') queueContainer.classList.add('hidden');
            else queueContainer.classList.remove('hidden');
        }

        // syncArtistGridIndicators deferred to 500ms cleanup so we don't touch sliding view DOM in same turn
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
                const dlq = this.dom.dlQueueContainer;
                if (dlq && !dlq.contains(e.target)) Downloader.hideDownloadQueue?.();
            } else {
                const q = this.dom.queueContainer;
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
        const OMNI_CURRENT_LABEL_MIN_PCT = 8;
        const updateTimeLabels = (progress, currentTime, duration) => {
            const dur = duration ?? lastDuration;
            const cur = currentTime ?? (dur * (progress / 100));
            lastDuration = dur;
            const omniCurrent = this.dom.omniTimeCurrent;
            const omniDuration = this.dom.omniTimeDuration;
            if (omniCurrent) {
                omniCurrent.textContent = UI.formatTime(cur);
                omniCurrent.style.left = `${Math.max(progress, OMNI_CURRENT_LABEL_MIN_PCT)}%`;
            }
            if (omniDuration) omniDuration.textContent = UI.formatTime(dur);
            const npCurrent = this.dom.npTimeCurrent;
            const npDuration = this.dom.npTimeDuration;
            if (npCurrent) {
                npCurrent.textContent = UI.formatTime(cur);
                npCurrent.style.left = `${progress}%`;
            }
            if (npDuration) npDuration.textContent = UI.formatTime(dur);
        };

        const omniDragRef = { current: false };
        const npDragRef = { current: false };
        const attachSeekBar = (container, progressBarEl, opts = {}) => {
            const { onPointerDownGuard = () => true, dragRef } = opts;
            let isDragging = false, dragPointerId = null, hasDragged = false;
            const onStart = (e) => {
                if (isDragging) return;
                if (!onPointerDownGuard()) return;
                e.preventDefault();
                e.stopPropagation();
                isDragging = true;
                if (dragRef) dragRef.current = true;
                hasDragged = false;
                dragPointerId = e.pointerId;
                container.setPointerCapture(e.pointerId);
                container.classList.add('seeking');
                const pct = calculateSeekPercent(e, container);
                if (pct != null && progressBarEl) {
                    progressBarEl.style.transition = 'none';
                    progressBarEl.style.width = `${pct}%`;
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };
            const onMove = (e) => {
                if (!isDragging || e.pointerId !== dragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                hasDragged = true;
                const pct = calculateSeekPercent(e, container);
                if (pct != null && progressBarEl) {
                    progressBarEl.style.width = `${pct}%`;
                    if (!container._lastSeekTime || Date.now() - container._lastSeekTime > 50) {
                        audioEngine.seek(pct);
                        container._lastSeekTime = Date.now();
                    }
                }
                if (pct != null) updateTimeLabels(pct, (pct / 100) * lastDuration, lastDuration);
            };
            const onEnd = (e) => {
                if (!isDragging || e.pointerId !== dragPointerId) return;
                e.preventDefault();
                e.stopPropagation();
                const wasDragging = hasDragged;
                isDragging = false;
                if (dragRef) dragRef.current = false;
                dragPointerId = null;
                container.releasePointerCapture(e.pointerId);
                container.classList.remove('seeking');
                const pct = calculateSeekPercent(e, container);
                if (pct != null) {
                    audioEngine.seek(pct);
                    if (progressBarEl) progressBarEl.style.transition = '';
                }
                if (wasDragging) setTimeout(() => { hasDragged = false; }, 100);
            };
            container.addEventListener('pointerdown', onStart);
            container.addEventListener('pointermove', onMove);
            container.addEventListener('pointerup', onEnd);
            container.addEventListener('pointercancel', onEnd);
            container.addEventListener('click', (e) => {
                if (!hasDragged) {
                    const pct = calculateSeekPercent(e, container);
                    if (pct != null) handleSeek(e, container);
                }
            });
        };

        const omniTrack = this.dom.omniProgressTrack;
        const omniProgressBar = this.dom.omniProgress;
        if (omniTrack && omniProgressBar) attachSeekBar(omniTrack, omniProgressBar, { dragRef: omniDragRef });

        const npSeekContainer = this.dom.npSeekContainer;
        const npSeekProgress = this.dom.npSeekProgress;
        if (npSeekContainer && npSeekProgress) {
            attachSeekBar(npSeekContainer, npSeekProgress, {
                onPointerDownGuard: () => document.body.classList.contains('np-timeline-expanded'),
                dragRef: npDragRef
            });
        }

        // Block page scroll while dragging omnibar or NP timeline
        document.addEventListener('touchmove', (e) => {
            if ((omniDragRef.current || npDragRef.current) && e.cancelable) {
                e.preventDefault();
            }
        }, { passive: false });
        document.addEventListener('wheel', (e) => {
            if (omniDragRef.current || npDragRef.current) {
                e.preventDefault();
            }
        }, { passive: false });

        window.addEventListener('audio:timeupdate', (e) => {
            const { progress, currentTime, duration } = e.detail;

            if (omniDragRef.current) return;

            const omniBar = this.dom.omniProgress;
            if (omniBar) omniBar.style.width = `${progress}%`;

            if (!npDragRef.current && document.body.classList.contains('np-timeline-expanded')) {
                const npBar = this.dom.npSeekProgress;
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
        let isEdgeSwipeFromFullCover = false;
        let longPressTimer = null;
        let longPressTriggered = false;

        document.addEventListener('touchstart', (e) => {
            if (!e.touches.length) return;
            // Desktop context (fine pointer + large width): no mobile swipe/long-press; use click-only behaviour
            if (this.dom.desktopApp || (window.matchMedia('(pointer: fine)').matches && window.matchMedia('(min-width: 1024px)').matches)) return;
            const touch = e.touches[0];
            const row = e.target.closest('.song-row');
            
            startX = touch.clientX;
            startY = touch.clientY;
            isHorizontal = false;
            isEdgeSwipe = false;
            isEdgeSwipeFromFullCover = false;

            // Clear any existing long press timer
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            longPressTriggered = false;

            // 1. Edge Swipe Detection (from left: close full-cover / SoundMash, or go to All songs). Capture phase so it works when touch starts on overlay.
            if (startX < 40) {
                isEdgeSwipe = true;
                const fullCoverEl = this.dom.fullCoverOverlay;
                const fullCoverOpen = fullCoverEl && !fullCoverEl.classList.contains('hidden');
                if (fullCoverOpen) {
                    isEdgeSwipeFromFullCover = true;
                } else {
                    isEdgeSwipeFromSoundMash = this.dom.soundmashView?.classList.contains('active') ?? false;
                    if (isEdgeSwipeFromSoundMash) {
                        const sm = this.dom.soundmashView;
                        if (sm) sm.style.transition = 'none';
                    } else {
                        this.content.style.transition = 'none';
                    }
                }
                return;
            }

            const holdMsFull = 480;   /* hold anywhere on row */
            const holdMsCover = Math.round(holdMsFull * 0.7); /* 70% when on cover */

            // 2. Queue item: long-press is only for reorder (handled in app.js). Do not open NP or full-cover.
            const queueItem = e.target.closest('.queue-item');
            if (queueItem) return;

            // 3. Song row: long-press on cover -> full-resolution cover overlay; elsewhere -> Now Playing
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
                        if (onCover && track) {
                            this.showFullCoverView(Resolver.getCoverUrl(track));
                            Haptics.heavy();
                        } else {
                            this.showNowPlaying(track ?? undefined);
                            Haptics.heavy();
                        }
                        longPressTimer = null;
                    }
                }, delay);
            }
        }, { passive: true, capture: true });

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
                if (isEdgeSwipeFromFullCover) return; // no visual drag for full-cover; just close on touchend
                const move = Math.max(0, diffX);
                if (isEdgeSwipeFromSoundMash) {
                    const sm = this.dom.soundmashView;
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

                if (isEdgeSwipeFromFullCover) {
                    if (diffX > threshold) {
                        this.vibrate(20);
                        this.hideFullCoverView();
                    }
                } else if (isEdgeSwipeFromSoundMash) {
                    const sm = this.dom.soundmashView;
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
                    if (this.dom.content) this.dom.content.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                    if (this.dom.content) this.dom.content.style.transform = 'translateX(0)';
                    if (diffX > threshold) {
                        this.vibrate(20);
                        if (this.currentView === 'artist-detail') this.showView('artists', false, 'backward');
                        else if (this.currentView === 'playlist-detail') this.showView('playlists', false, 'backward');
                        else this.showView('home', false, 'backward');
                    }
                }
                isEdgeSwipe = false;
                isEdgeSwipeFromSoundMash = false;
                isEdgeSwipeFromFullCover = false;
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
                    Haptics.tick();
                    this.showToast('Added to Favourites');
                    if (typeof window.scheduleFavFirstAnimation === 'function') window.scheduleFavFirstAnimation(trackId, activeRow);
                    activeRow = null;
                } else {
                    const fastSwipeFavFirstAdd = !isHorizontal && diff < -70 && !isFav &&
                        this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';
                    if (fastSwipeFavFirstAdd) {
                        Haptics.tick();
                        this.showToast('Added to Favourites');
                        if (typeof window.scheduleFavFirstAnimation === 'function') window.scheduleFavFirstAnimation(trackId, activeRow);
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
        this.bindFullCoverOverlay();
    }

    static initNowPlayingGestures() {
        const npView = this.dom.nowPlayingView;
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

        const npArt = this.dom.npArt;
        if (npArt) {
            let coverStartTime = 0, coverStartX = 0, coverStartY = 0, coverMaxDelta = 0;
            let coverTapHandled = false; /* avoid double-fire when touch triggers click */
            const playPreviewTrackAndExpandTimeline = () => {
                if (!UI._npDisplayTrack || store.state.currentTrack?.id === UI._npDisplayTrack.id) return false;
                Haptics.tick();
                window.playTrack(UI._npDisplayTrack.id);
                UI._npDisplayTrack = null;
                if (this.dom.nowPlayingView) this.dom.nowPlayingView.classList.remove('np-preview');
                if (this.dom.npSeekContainer) this.dom.npSeekContainer.classList.add('np-timeline-expanded');
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
        this.island = this.dom.omniIsland;
        this.anchor = this.dom.omniAnchor;
        this.omniPrev = this.dom.omniPrev;
        this.omniNext = this.dom.omniNext;
        this.omniProgress = this.dom.omniProgress;
        
        if (!this.island || !this.anchor) return;

        // Sync progress track (and time labels) to collapsed state on load so labels are not visible before first touch
        const omniProgressTrack = this.dom.omniProgressTrack;
        if (omniProgressTrack) {
            omniProgressTrack.style.transition = 'opacity 0.28s ease';
            omniProgressTrack.style.opacity = this.isIslandActive ? '1' : '0';
        }

        this.initOmniGestures();
    }

    static initOmniGestures() {
        const island = this.dom.omniIsland;
        const touchArea = this.dom.omniTouchArea;
        const ribbon = this.dom.omniNavRibbon;
        const label = this.dom.omniLabel;
        const items = document.querySelectorAll('.omni-nav-item');
        if (!island || !touchArea || !ribbon || !label) return;

        this._isHolding = false;
        this._startedInside = false;
        this._activeNavView = null;
        this._lastActiveNavView = null;
        this._startY = 0;
        this._currentY = 0;

        const startBloom = (e) => {
            if (this.dom.soundmashView?.classList.contains('active')) {
                e.preventDefault();
                return;
            }
            const touch = e.touches[0];
            const rect = island.getBoundingClientRect();
            this._startedInside = touch.clientX >= rect.left && touch.clientX <= rect.right && 
                                 touch.clientY >= rect.top && touch.clientY <= rect.bottom;

            this._isHolding = true;
            this._lastActiveNavView = null;
            this._startY = touch.clientY;
            this._currentY = this._startY;
            Haptics.tick();
            
            this._labelAnimTimer = setTimeout(() => {
                if (this._isHolding && this._startedInside) {
                    label.classList.remove('docked');
                    label.classList.add('hovered');
                    label.style.opacity = '1';
                }
            }, 67);

            this._omniHoldTimer = setTimeout(() => {
                // Only bloom if we haven't swiped up significantly
                if (this._startedInside && Math.abs(this._currentY - this._startY) < 30) {
                    Haptics.heavy();
                    this.isBlooming = true;

                    island.style.width = '380px';
                    island.classList.remove('omni-seed');

                    const transport = this.dom.omniTransport;
                    const metadata = this.dom.omniMetadataContainer;
                    const omniProgressTrack = this.dom.omniProgressTrack;
                    const anchorIcon = this.dom.omniAnchorIcon;

                    if (anchorIcon) anchorIcon.classList.remove('omni-grid-hint-pulse');
                    if (transport) {
                        transport.style.transition = 'opacity 0.16s ease, filter 0.17s ease, transform 0.17s ease';
                        transport.style.filter = 'blur(12px)';
                        transport.style.opacity = '0';
                        transport.style.transform = 'scale(0.9)';
                        transport.style.pointerEvents = 'none';
                    }
                    if (metadata) {
                        metadata.style.opacity = '0';
                    }
                    if (omniProgressTrack) {
                        omniProgressTrack.style.transition = 'opacity 0.16s ease';
                        omniProgressTrack.style.opacity = '0';
                    }

                    ribbon.classList.remove('pointer-events-none');
                    ribbon.style.opacity = '1';
                    ribbon.style.transform = 'scale(1)';
                    ribbon.style.filter = 'blur(0px)';
                    this.updateOmniLabelVisibility();
                }
            }, 180);
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

            // 0. SWIPE GESTURES: up = NP / preview play; down = back to all tracks (same as edge swipe from left)
            const deadzone = 15;
            if (this._isHolding && !this.isBlooming && this._startedInside && isHorizontalValid) {
                const isNPActive = this.dom.nowPlayingView?.classList.contains('active');

                if (deltaY < -deadzone && !isNPActive) {
                    this.showNowPlaying();
                    this.resetOmniIsland();
                    return;
                }
                if (deltaY < -deadzone && isNPActive && UI._npDisplayTrack) {
                    window.playTrack(UI._npDisplayTrack.id);
                    UI._npDisplayTrack = null;
                    if (this.dom.nowPlayingView) this.dom.nowPlayingView.classList.remove('np-preview');
                    if (this.dom.npSeekContainer) this.dom.npSeekContainer.classList.add('np-timeline-expanded');
                    document.body.classList.add('np-timeline-expanded');
                    this.resetOmniIsland();
                    return;
                }
                // Swipe down: same as edge swipe from left — go back (artist-detail → artists, playlist-detail → playlists, else home)
                if (deltaY > deadzone) {
                    const targetView = this.currentView === 'artist-detail' ? 'artists' : this.currentView === 'playlist-detail' ? 'playlists' : 'home';
                    if (this.currentView !== targetView) this.vibrate(20);
                    this.showView(targetView, false, 'backward');
                    this.resetOmniIsland();
                    return;
                }
            }

            // 1. COORDINATE-BASED TRANSPORT — only when expanded; when collapsed, tap does nothing (keep grid icon)
            if (this._isHolding && !this.isBlooming && isInside && this.isIslandActive) {
                const relX = (touch.clientX - rect.left) / rect.width;
                let zone = 'anchor';
                if (relX < 0.35) zone = 'prev';
                else if (relX > 0.65) zone = 'next';

                Haptics.tick();
                const visualEl = zone === 'prev' ? this.dom.omniPrev : zone === 'next' ? this.dom.omniNext : this.dom.omniAnchor;
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

            // 2. NAV COMMIT — use _activeNavView, or _lastActiveNavView if finger released over blank (e.g. edge of Artists slot)
            const viewToShow = this._activeNavView || this._lastActiveNavView;
            if (this.isBlooming && viewToShow) {
                Haptics.lock();
                
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

            requestAnimationFrame(() => this.resetOmniIsland());
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
                        this._lastActiveNavView = view;

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
        const ribbon = this.dom.omniNavRibbon;
        const transport = this.dom.omniTransport;
        const items = document.querySelectorAll('.omni-nav-item');
        const label = this.dom.omniLabel;

        if (this._omniHoldTimer) {
            clearTimeout(this._omniHoldTimer);
            this._omniHoldTimer = null;
        }
        if (this._labelAnimTimer) {
            clearTimeout(this._labelAnimTimer);
            this._labelAnimTimer = null;
        }

        // Restore Playback UI
        if (this.isIslandActive) {
            this.island.style.width = '250px';
            this.island.classList.remove('omni-seed');
        } else {
            this.island.style.width = '56px';
            this.island.classList.add('omni-seed');
        }

        this.island.style.transform = ''; // Clear swipe displacement

        const omniProgressTrack = this.dom.omniProgressTrack;
        const transportFadeDuration = '0.22s';
        if (transport) {
            transport.style.transition = `opacity ${transportFadeDuration} ease, filter 0.17s ease, transform 0.17s ease`;
            if (this.isIslandActive) {
                transport.style.filter = 'blur(0px)';
                transport.style.opacity = '1';
                transport.style.transform = 'scale(1)';
                transport.style.pointerEvents = 'auto';
            } else {
                transport.style.filter = 'blur(0px)';
                transport.style.opacity = '1';
                transport.style.transform = 'scale(1)';
                transport.style.pointerEvents = 'none';
            }
        }
        if (omniProgressTrack) {
            omniProgressTrack.style.transition = `opacity ${transportFadeDuration} ease`;
            omniProgressTrack.style.opacity = this.isIslandActive ? '1' : '0';
        }

        const metadata = this.dom.omniMetadataContainer;
        if (metadata) {
            metadata.style.transition = `opacity ${transportFadeDuration} ease`;
            this.updateOmniMetadataVisibility();
        }

        if (ribbon) {
            ribbon.classList.add('pointer-events-none');
            ribbon.style.opacity = '0';
            ribbon.style.transform = 'scale(0.95)';
            ribbon.style.filter = 'blur(8px)';
        }
        this.updateOmniLabelVisibility();

        items.forEach(i => {
            i.classList.remove('active');
            i.style.transform = 'scale(1)';
            i.querySelector('i').style.color = '';
        });

        // Seed state: show grid icon and urge pulse; playback state leaves play/pause as-is
        const anchorIcon = this.dom.omniAnchorIcon;
        if (!this.isIslandActive && anchorIcon) {
            anchorIcon.className = 'fas fa-th-large text-lg text-[var(--text-main)] omni-grid-hint-pulse';
        }

        // Always reset label to the current view's docked state
        if (label) {
            this.updateLabel(this.currentView);
        }

        this.isBlooming = false;
        this._isHolding = false;
        this._activeNavView = null;
        this._lastActiveNavView = null;
    }

    static showActionMenu(trackId) {
        // CRITICAL: Blur any active element to prevent auto-focus/highlight on mobile
        if (document.activeElement) document.activeElement.blur();

        const track = store.state.library.find(t => t.id === trackId);
        if (!track) return;

        this.currentActionTrack = track;
        const actionTrackTitle = document.getElementById('action-track-title');
        const actionTrackArtist = document.getElementById('action-track-artist');
        const actionTrackArt = document.getElementById('action-track-art');
        if (actionTrackTitle) actionTrackTitle.textContent = track.title;
        if (actionTrackArtist) {
            actionTrackArtist.textContent = track.artist;
            actionTrackArtist.classList.add('font-mono');
        }
        if (actionTrackArt) actionTrackArt.src = Resolver.getCoverUrl(track);

        const isFav = store.state.favorites.includes(trackId);
        const actionFavText = document.getElementById('action-fav-text');
        if (actionFavText) actionFavText.textContent = isFav ? 'Remove from Favourites' : 'Add to Favourites';
        
        const isInQueue = store.state.queue.some(t => t.id === trackId);
        const actionQueueText = document.getElementById('action-queue-text');
        if (actionQueueText) actionQueueText.textContent = isInQueue ? 'Remove from Queue' : 'Add to Queue';

        const inPlaylistDetail = this.currentView === 'playlist-detail';
        const actionDelete = document.getElementById('action-delete');
        const actionAddToPlaylist = document.getElementById('action-add-to-playlist');
        const actionRemoveFromPlaylist = document.getElementById('action-remove-from-playlist');
        if (actionDelete) actionDelete.classList.toggle('hidden', inPlaylistDetail);
        if (actionAddToPlaylist) actionAddToPlaylist.classList.toggle('hidden', inPlaylistDetail);
        if (actionRemoveFromPlaylist) actionRemoveFromPlaylist.classList.toggle('hidden', !inPlaylistDetail);

        const menu = this.dom.actionMenu;
        const sheet = this.dom.actionMenuSheet;
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
    }

    static hideActionMenu() {
        if (document.activeElement) document.activeElement.blur();
        
        const menu = this.dom.actionMenu;
        const sheet = this.dom.actionMenuSheet;
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
        const sheet = this.dom.actionMenuSheet;
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
        const mini = this.dom.miniPlayBtn?.querySelector('i');
        if (mini) {
            mini.className = isPlaying ? 'fas fa-pause' : 'fas fa-play ml-0.5';
        }

        const mode = store.state.repeatMode;
        const shuffleOn = store.state.shuffleEnabled;
        const repeatBtns = [this.dom.miniRepeatBtn, this.dom.omniRepeatBtn].filter(b => b);
        repeatBtns.forEach(b => {
            b.classList.toggle('text-[var(--accent)]', mode !== 'off');
            b.classList.toggle('text-[var(--text-dim)]', mode === 'off');
        });
        const omniRepeatOne = this.dom.omniRepeatOneIndicator;
        if (omniRepeatOne) omniRepeatOne.classList.toggle('hidden', mode !== 'one');
        
        const indMini = this.dom.miniRepeatOneIndicator;
        if (indMini) indMini.classList.toggle('hidden', mode !== 'one');

        const shuffleBtns = [this.dom.miniShuffleBtn, this.dom.omniShuffleBtn].filter(b => b);
        shuffleBtns.forEach(b => {
            b.classList.toggle('text-[var(--accent)]', shuffleOn);
            b.classList.toggle('text-[var(--text-dim)]', !shuffleOn);
        });
    }

    static showMetadataEditor(id) {
        const t = store.state.library.find(x => x.id === id);
        if (!t) return;
        this.editingTrack = t;
        
        const modal = this.dom.metadataEditor;
        const content = this.dom.metadataEditorContent;
        
        this.dom.editTitle.value = t.title;
        this.dom.editArtist.value = t.artist;
        this.dom.editAlbum.value = t.album;
        this.dom.editCoverPreview.src = Resolver.getCoverUrl(t);

        if (modal) modal.classList.remove('hidden');
        setTimeout(() => {
            if (content) {
                content.classList.replace('scale-95', 'scale-100');
                content.classList.replace('opacity-0', 'opacity-100');
            }
        }, 10);

        if (!this._edBound) {
            this.dom.editSaveBtn.onclick = () => this.saveMetadata();
            this.dom.editAutoFetchBtn.onclick = () => this.autoFetch();
            
            const uploadBtn = this.dom.editUploadBtn;
            const fileInput = this.dom.editFileInput;
            if (uploadBtn && fileInput) {
                uploadBtn.onclick = () => { this.vibrate(10); fileInput.click(); };
                fileInput.onchange = (e) => this.handleCoverUpload(e);
            }
            this._edBound = true;
        }
    }

    static hideMetadataEditor() {
        const modal = this.dom.metadataEditor;
        const content = this.dom.metadataEditorContent;
        if (content) {
            content.classList.replace('scale-100', 'scale-95');
            content.classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => modal && modal.classList.add('hidden'), 300);
    }

    static async saveMetadata() {
        if (!this.editingTrack) return;
        this.vibrate(30);
        const status = this.dom.editStatus;
        if (status) status.textContent = 'Saving Changes...';

        const metadata = {
            title: this.dom.editTitle?.value ?? '',
            artist: this.dom.editArtist?.value ?? '',
            album: this.dom.editAlbum?.value ?? ''
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
        const status = this.dom.editStatus;
        const resultsContainer = this.dom.autoFetchResults;
        if (status) status.textContent = 'Searching technical data...';
        if (resultsContainer) {
            resultsContainer.innerHTML = '';
            resultsContainer.classList.add('hidden');
        }

        const query = `${this.dom.editTitle?.value ?? ''} ${this.dom.editArtist?.value ?? ''}`;
        const results = await store.searchMetadata(query);

        if (!results || results.length === 0) {
            if (status) status.textContent = 'No matches found';
            return;
        }

        if (status) status.textContent = 'Matches found';
        if (resultsContainer) {
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
    }

    static applyFetchedMetadata(title, artist, album, cover) {
        this.vibrate(10);
        if (this.dom.editTitle) this.dom.editTitle.value = title;
        if (this.dom.editArtist) this.dom.editArtist.value = artist;
        if (this.dom.editAlbum) this.dom.editAlbum.value = album;
        if (this.dom.editCoverPreview) this.dom.editCoverPreview.src = cover;
        if (this.dom.autoFetchResults) this.dom.autoFetchResults.classList.add('hidden');
        if (this.dom.editStatus) this.dom.editStatus.textContent = 'Metadata applied locally';
    }

    static async handleCoverUpload(e) {
        const file = e.target.files[0];
        if (!file || !this.editingTrack) return;
        
        this.vibrate(20);
        const status = this.dom.editStatus;
        if (status) status.textContent = 'Uploading Cover Art...';

        const success = await store.uploadCover(this.editingTrack.id, file);
        if (success) {
            this.showToast('Cover Art Updated');
            if (this.dom.editCoverPreview) this.dom.editCoverPreview.src = URL.createObjectURL(file);
            if (status) status.textContent = 'Cover applied';
        } else {
            if (status) status.textContent = 'Upload Failed';
        }
    }

    static formatTime(s) {
        return formatTime(s);
    }

    static showToast(m) {
        const c = this.dom.toastContainer;
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
