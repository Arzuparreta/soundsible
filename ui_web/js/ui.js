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
    static VIEW_LABELS = {
        'home': 'LIBRARY',
        'favourites': 'FAVORITES',
        'artist-detail': 'ARTIST',
        'playlists': 'PLAYLISTS',
        'playlist-detail': 'PLAYLIST',
        'podcast': 'PODCASTS',
        'settings': 'CONFIG',
        'discover': 'DISCOVER'
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
            omniAnchorLogoWrap: d('omni-anchor-logo-wrap'),
            omniMetadataContainer: d('omni-metadata-container'),
            omniMetadata: d('omni-metadata'),
            omniText1: d('omni-text-1'),
            omniText2: d('omni-text-2'),
            omniPrev: d('omni-prev'),
            omniNext: d('omni-next'),
            omniTransport: d('omni-transport'),
            omniProgressTrack: d('omni-progress-track'),
            omniIslandContainer: d('omni-island-container'),
            omniBarTouchBlock: d('omni-bar-touch-block'),
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
            queuePopover: d('queue-popover'),
            queueContainer: d('queue-container'),
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

        if (state.currentTrack) {
            if (this.dom.nowPlayingView?.classList.contains('active')) {
                this.updateNowPlaying(state.currentTrack, state.isPlaying);
                const npSeek = this.dom.npSeekContainer;
                if (npSeek) npSeek.classList.add('np-timeline-expanded');
                document.body.classList.add('np-timeline-expanded');
            }
            this.updateTransportControls(state.isPlaying);
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

        // Real-time UI Sync: expanded = play/pause; collapsed = logo (hold hint)
        const anchorIcon = this.dom.omniAnchorIcon;
        const logoWrap = this.dom.omniAnchorLogoWrap;
        if (!anchorIcon || !logoWrap) return;
        if (this.isIslandActive) {
            logoWrap.classList.add('hidden');
            anchorIcon.classList.remove('hidden');
            anchorIcon.classList.remove('omni-grid-hint-pulse');
            anchorIcon.className = state.isPlaying ? 'fas fa-pause text-lg text-[var(--text-main)]' : 'fas fa-play text-lg text-[var(--text-main)] ml-1';
            this.updateMetadataScroller(state.currentTrack);
        } else {
            anchorIcon.classList.add('hidden');
            logoWrap.classList.remove('hidden');
            logoWrap.classList.add('omni-grid-hint-pulse');
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
            anchorIcon.classList.remove('hidden');
        }
        if (this.dom.omniAnchorLogoWrap) this.dom.omniAnchorLogoWrap.classList.add('hidden');

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

    /** Omnibar metadata visible when island expanded and NP view is closed. */
    static updateOmniMetadataVisibility() {
        const container = this.dom.omniMetadataContainer;
        if (!container) return;
        const visible = this.isIslandActive && !this._npViewOpen;
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
        
        if (anchorIcon) anchorIcon.classList.add('hidden');
        if (this.dom.omniAnchorLogoWrap) {
            this.dom.omniAnchorLogoWrap.classList.remove('hidden');
            this.dom.omniAnchorLogoWrap.classList.add('omni-grid-hint-pulse');
        }
    }

    static detectPlatform() {
        const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || 
                     (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        return isIOS ? 'ios' : 'android';
    }

    /** No-op: omnibar is pinned to layout viewport via #omni-bar-root so it does not move with the keyboard. */
    static initKeyboardSync() {}

    static handleKeyboardOpen() {}

    static handleKeyboardClose() {
        const container = this.dom.omniIslandContainer;
        const touchBlock = this.dom.omniBarTouchBlock;
        const labelContainer = this.dom.omniLabelContainer;
        if (container) container.style.transform = '';
        if (touchBlock) touchBlock.style.transform = '';
        if (labelContainer) labelContainer.style.transform = '';
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
            const fallback = store.placeholderCoverUrl.replace(/"/g, '%22');
            art.style.backgroundImage = url ? `url("${String(url).replace(/"/g, '%22')}")` : `url("${fallback}")`;
        }
        if (title) title.textContent = track.title;
        if (artistEl) artistEl.textContent = track.artist;
        if (album) album.textContent = track.album;
        
        this.updateTransportControls(isPlaying);
    }

    /** Opens Now Playing only for the currently playing track. No-op if nothing is playing. */
    static showNowPlaying() {
        const track = store.state.currentTrack;
        if (!track) return;

        const npView = this.dom.nowPlayingView;
        if (!npView) return;

        npView.classList.remove('hidden', 'np-closing');
        this._npViewOpen = true;
        this.updateOmniMetadataVisibility();
        this.updateOmniLabelVisibility();
        document.body.classList.add('now-playing-open');
        this.updateNowPlaying(track, store.state.isPlaying);

        setTimeout(() => {
            npView.classList.add('active');
            Haptics.heavy();
            requestAnimationFrame(() => {
                const npSeek = this.dom.npSeekContainer;
                if (npSeek) npSeek.classList.add('np-timeline-expanded');
                document.body.classList.add('np-timeline-expanded');
            });
        }, 10);

        if (!this._npGesturesBound) {
            this.initNowPlayingGestures();
            this._npGesturesBound = true;
        }
    }

    static hideNowPlaying() {
        this._npViewOpen = false;
        this.updateOmniMetadataVisibility();
        this.updateOmniLabelVisibility();
        const npView = this.dom.nowPlayingView;
        if (!npView) return;

        const npSeek = this.dom.npSeekContainer;
        if (npSeek) npSeek.classList.remove('np-timeline-expanded');
        document.body.classList.remove('np-timeline-expanded');

        const closeDurationMs = 692; /* matches np-closing transition duration */

        npView.classList.add('np-closing');
        npView.offsetHeight; /* force reflow so close transition is applied */
        npView.classList.remove('active');
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
        const url = (coverUrl || store.placeholderCoverUrl).replace(/"/g, '%22').replace(/'/g, '%27');
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

    /** Discover is a full content view; kept for any external callers (e.g. gestures). */
    static showDiscover() {
        this.showView('discover');
    }

    static hideDiscover() {
        if (this.currentView === 'discover') this.navigateBack();
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

    /**
     * Slide direction from omnibar DOM order: views left of the blank slide from left, right of blank slide from right.
     * Reordering ribbon items in HTML preserves this behavior. Stack views (artist-detail, playlist-detail) use their root view's side.
     */
    static getSlideClassForView(viewId) {
        const ribbon = document.getElementById('omni-nav-ribbon');
        if (!ribbon) return 'view-from-right';
        const leftViews = [];
        const rightViews = [];
        let pastBlank = false;
        for (const el of ribbon.children) {
            if (el.hasAttribute('data-omni-blank')) {
                pastBlank = true;
                continue;
            }
            const v = el.getAttribute('data-view');
            if (v) {
                if (pastBlank) rightViews.push(v);
                else leftViews.push(v);
            }
        }
        const stackToRoot = { 'artist-detail': 'home', 'playlist-detail': 'playlists' };
        const resolved = stackToRoot[viewId] || viewId;
        return leftViews.includes(resolved) ? 'view-from-left' : 'view-from-right';
    }

    static showView(viewId, saveToHistory = true) {
        // Auto-hide Now Playing if active (even if selecting the same view)
        if (this.dom.nowPlayingView?.classList.contains('active')) {
            this.hideNowPlaying();
        }

        if (viewId === this.currentView) return;

        if (viewId === 'home' && this.currentView === 'artist-detail') store.update({ libraryTab: 'artists' });

        UI._viewTransitionEnd = Date.now() + 520;
        this.updateLabel(viewId);

        const oldView = document.getElementById(`view-${this.currentView}`);
        const targetView = document.getElementById(`view-${viewId}`);
        if (!targetView) return;

        if (saveToHistory) {
            const roots = ['home', 'favourites', 'playlists', 'podcast', 'settings', 'discover'];
            if (roots.includes(this.currentView) && roots.includes(viewId)) this.viewStack = [];
            else this.viewStack.push(this.currentView);
        }

        // --- PERFORM STACKING TRANSITION ---
        
        // 1. Prepare Outgoing (stays in background with dim/scale)
        if (oldView) oldView.classList.add('view-outgoing');

        // 2. Prepare Incoming — slide direction from omnibar DOM order: views left of blank → slide from left, right of blank → slide from right (reorder ribbon = behavior follows)
        const slideClass = UI.getSlideClassForView(viewId);
        targetView.classList.remove('hidden', 'view-warm-hidden-left', 'view-warm-hidden-right');
        targetView.classList.add('view-incoming');
        targetView.classList.add(slideClass);
        
        // Returning to artists from artist-detail: clear sticky :active from back button and suppress card feedback briefly
        const fromArtistDetail = viewId === 'home' && this.currentView === 'artist-detail';
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
                const warmViews = { 'view-home': 'view-warm-hidden-right' };
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

        const queueContainer = this.dom.queueContainer;
        if (queueContainer) queueContainer.classList.remove('hidden');

        // ODST Music/YouTube toggle is now embedded in the search bar; visibility controlled by show-discover-odst on container (app.js)

        // syncArtistGridIndicators deferred to 500ms cleanup so we don't touch sliding view DOM in same turn
    }

    static navigateBack() {
        if (this.viewStack.length === 0) {
            this.showView('home', false);
            return;
        }
        
        const previousView = this.viewStack.pop();
        this.showView(previousView, false);
    }

    static initGlobalListeners() {
        // Global: Prevent context menu everywhere for a native app feel
        window.addEventListener('contextmenu', (e) => e.preventDefault());

        // Global Clicks
        window.addEventListener('click', (e) => {
            if (this.currentView === 'discover') {
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

        const gesture = {
            startX: 0,
            startY: 0,
            activeRow: null,
            isHorizontal: false,
            isEdgeSwipe: false,
            isEdgeSwipeFromFullCover: false,
            longPressTimer: null,
            longPressTriggered: false,
            releasedToNativeScroll: false,
            touchMoveBound: false
        };

        function shouldAttachBlockingTouchMove() {
            return gesture.isEdgeSwipe || !!gesture.activeRow;
        }

        function attachGestureTouchMove() {
            if (gesture.touchMoveBound) return;
            gesture.touchMoveBound = true;
            document.addEventListener('touchmove', onGestureTouchMove, { passive: false });
        }

        function detachGestureTouchMove() {
            if (!gesture.touchMoveBound) return;
            gesture.touchMoveBound = false;
            document.removeEventListener('touchmove', onGestureTouchMove, { passive: false });
        }

        function onGestureTouchMove(e) {
            const touch = e.touches[0];
            const diffX = touch.clientX - gesture.startX;
            const diffY = Math.abs(touch.clientY - gesture.startY);

            if (gesture.longPressTimer && (Math.abs(diffX) > 15 || diffY > 15)) {
                clearTimeout(gesture.longPressTimer);
                gesture.longPressTimer = null;
            }

            if (gesture.activeRow && !gesture.isEdgeSwipe && diffY > 10 && diffY > Math.abs(diffX)) {
                detachGestureTouchMove();
                gesture.releasedToNativeScroll = true;
                return;
            }

            if (gesture.isEdgeSwipe) {
                if (gesture.isEdgeSwipeFromFullCover) return;
                if (this.currentView === 'home') return;
                if (e.cancelable) e.preventDefault();
                this.content.style.transform = `translateX(${Math.max(0, diffX)}px)`;
                return;
            }

            if (!gesture.activeRow) return;

            if (!gesture.isHorizontal && Math.abs(diffX) > diffY && Math.abs(diffX) > 10) {
                gesture.isHorizontal = true;
                if (gesture.longPressTimer) {
                    clearTimeout(gesture.longPressTimer);
                    gesture.longPressTimer = null;
                }
            }

            if (gesture.isHorizontal) {
                if (e.cancelable) e.preventDefault();
                gesture.activeRow.style.transform = `translateX(${Math.max(Math.min(diffX, 100), -100)}px)`;
                if (gesture.activeRow.parentElement) {
                    gesture.activeRow.parentElement.classList.add('is-swiping');
                }
            }
        }

        document.addEventListener('touchstart', (e) => {
            if (!e.touches.length) return;
            if (this.dom.desktopApp || (window.matchMedia('(pointer: fine)').matches && window.matchMedia('(min-width: 1024px)').matches)) return;
            const touch = e.touches[0];
            const row = e.target.closest('.song-row');

            gesture.startX = touch.clientX;
            gesture.startY = touch.clientY;
            gesture.isHorizontal = false;
            gesture.isEdgeSwipe = false;
            gesture.isEdgeSwipeFromFullCover = false;
            gesture.releasedToNativeScroll = false;

            if (gesture.longPressTimer) {
                clearTimeout(gesture.longPressTimer);
                gesture.longPressTimer = null;
            }
            gesture.longPressTriggered = false;

            if (gesture.startX < 40) {
                gesture.isEdgeSwipe = true;
                const fullCoverEl = this.dom.fullCoverOverlay;
                const fullCoverOpen = fullCoverEl && !fullCoverEl.classList.contains('hidden');
                if (fullCoverOpen) {
                    gesture.isEdgeSwipeFromFullCover = true;
                } else if (this.currentView !== 'home') {
                    this.content.style.transition = 'none';
                }
                if (shouldAttachBlockingTouchMove()) attachGestureTouchMove();
                return;
            }

            const holdMsCover = 340;

            if (e.target.closest('.queue-item')) return;

            const onCover = !!e.target.closest('.song-row-cover');
            if (row && onCover) {
                gesture.activeRow = row;
                row.style.transition = 'none';
                const trackId = row.getAttribute('data-id');
                gesture.longPressTimer = setTimeout(() => {
                    if (!gesture.isHorizontal) {
                        gesture.longPressTriggered = true;
                        const track = typeof window.getTrackFromCurrentContext === 'function' ? window.getTrackFromCurrentContext(trackId) : null;
                        if (track) {
                            this.showFullCoverView(Resolver.getCoverUrl(track));
                            Haptics.heavy();
                        }
                        gesture.longPressTimer = null;
                    }
                }, holdMsCover);
            } else if (row) {
                gesture.activeRow = row;
                row.style.transition = 'none';
            }

            if (shouldAttachBlockingTouchMove()) attachGestureTouchMove();
        }, { passive: true, capture: true });

        function cleanupGestureEnd() {
            detachGestureTouchMove();
            if (gesture.releasedToNativeScroll) {
                if (gesture.activeRow && gesture.activeRow.parentElement) {
                    gesture.activeRow.parentElement.classList.remove('is-swiping');
                }
                gesture.activeRow = null;
                gesture.releasedToNativeScroll = false;
            }
        }

        document.addEventListener('touchend', (e) => {
            const wasReleasedToScroll = gesture.releasedToNativeScroll;
            cleanupGestureEnd();
            if (wasReleasedToScroll) return;

            if (gesture.isEdgeSwipe) {
                const diffX = e.changedTouches[0].clientX - gesture.startX;
                const threshold = window.innerWidth * 0.12;

                if (gesture.isEdgeSwipeFromFullCover) {
                    if (diffX > threshold) {
                        this.vibrate(20);
                        this.hideFullCoverView();
                    }
                } else {
                    if (this.currentView !== 'home') {
                        if (this.dom.content) this.dom.content.style.transition = 'transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)';
                        if (this.dom.content) this.dom.content.style.transform = 'translateX(0)';
                    }
                    if (diffX > threshold && this.currentView !== 'home') {
                        this.vibrate(20);
                        if (this.currentView === 'artist-detail') {
                            store.update({ libraryTab: 'artists' });
                            this.showView('home', false);
                        } else if (this.currentView === 'playlist-detail') this.showView('playlists', false);
                        else if (this.currentView === 'discover') this.navigateBack();
                        else this.showView('home', false);
                    }
                }
                gesture.isEdgeSwipe = false;
                gesture.isEdgeSwipeFromFullCover = false;
                return;
            }

            if (gesture.activeRow) {
                const diff = e.changedTouches[0].clientX - gesture.startX;
                const trackId = gesture.activeRow.getAttribute('data-id');
                const isFav = trackId && store.state.favorites.includes(trackId);
                const isFavFirstAdd = gesture.isHorizontal && diff < -70 && !isFav &&
                    this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';

                if (isFavFirstAdd) {
                    Haptics.tick();
                    this.showToast('Added to Favourites');
                    if (typeof window.scheduleFavFirstAnimation === 'function') window.scheduleFavFirstAnimation(trackId, gesture.activeRow);
                    gesture.activeRow = null;
                } else {
                    const fastSwipeFavFirstAdd = !gesture.isHorizontal && diff < -70 && !isFav &&
                        this.currentView === 'home' && (store.state.libraryOrder || 'date_added') === 'favorites_first';
                    if (fastSwipeFavFirstAdd) {
                        Haptics.tick();
                        this.showToast('Added to Favourites');
                        if (typeof window.scheduleFavFirstAnimation === 'function') window.scheduleFavFirstAnimation(trackId, gesture.activeRow);
                        gesture.activeRow = null;
                    } else {
                        gesture.activeRow.style.transition = 'transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)';
                        gesture.activeRow.style.transform = 'translateX(0)';
                        if (gesture.isHorizontal) {
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
                        const rowToCleanup = gesture.activeRow;
                        setTimeout(() => {
                            if (rowToCleanup && rowToCleanup.parentElement) {
                                rowToCleanup.parentElement.classList.remove('is-swiping');
                            }
                        }, 400);
                        gesture.activeRow = null;
                    }
                }
            }

            if (gesture.longPressTimer) {
                clearTimeout(gesture.longPressTimer);
                gesture.longPressTimer = null;
            }
        }, { passive: true });

        document.addEventListener('touchcancel', () => {
            cleanupGestureEnd();
        }, { passive: true });

        // Prevent click events after long press (song row or queue item cover)
        document.addEventListener('click', (e) => {
            if (gesture.longPressTriggered) {
                const row = e.target.closest('.song-row');
                const queueItem = e.target.closest('.queue-item');
                if (row || queueItem) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    gesture.longPressTriggered = false;
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
            }, 33);

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
                    if (this.dom.omniAnchorLogoWrap) this.dom.omniAnchorLogoWrap.classList.remove('omni-grid-hint-pulse');
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
            }, 100);
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

            // 0. SWIPE GESTURES: up = Now Playing (current track only); down = back to library
            const deadzone = 15;
            if (this._isHolding && !this.isBlooming && this._startedInside && isHorizontalValid) {
                const isNPActive = this.dom.nowPlayingView?.classList.contains('active');

                if (deltaY < -deadzone && !isNPActive) {
                    this.showNowPlaying();
                    this.resetOmniIsland();
                    return;
                }
                // Swipe down: same as edge swipe from left — go back (artist-detail → home with Artists tab, playlist-detail → playlists, else home)
                if (deltaY > deadzone) {
                    if (this.currentView === 'artist-detail') {
                        store.update({ libraryTab: 'artists' });
                        this.showView('home', false);
                    } else {
                        const targetView = this.currentView === 'playlist-detail' ? 'playlists' : 'home';
                        if (this.currentView !== targetView) this.vibrate(20);
                        this.showView(targetView, false);
                    }
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
                else if (store.state.currentTrack) audioEngine.toggle();
            }

            // 2. NAV COMMIT — use _activeNavView, or _lastActiveNavView if finger released over blank (e.g. edge of Artists slot)
            const viewToShow = this._activeNavView || this._lastActiveNavView;
            if (this.isBlooming && viewToShow) {
                Haptics.lock();
                if (viewToShow !== this.currentView) this.showView(viewToShow);
                label.classList.remove('hovered');
                label.classList.add('docked');
                label.style.removeProperty('transform');
                label.style.setProperty('--tx', '0px');
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

                if (isVerticalValid && ribbon) {
                    const touchX = touch.clientX;
                    const touchY = touch.clientY;
                    let hitChild = false;
                    // 1) Hit-test over ribbon children so behaviour is identical for every item when finger is on the bar
                    for (const child of ribbon.children) {
                        const r = child.getBoundingClientRect();
                        const padding = 8;
                        if (touchX >= r.left - padding && touchX <= r.right + padding && touchY >= r.top - padding && touchY <= r.bottom + padding) {
                            hitChild = true;
                            if (child.hasAttribute('data-omni-blank')) item = null;
                            else if (child.classList.contains('omni-nav-item')) item = child;
                            break;
                        }
                    }
                    // 2) Finger in valid vertical band but not over a child (e.g. space below the omnibar): project X onto ribbon width so grabbing continues to work
                    if (!hitChild) {
                        const ribbonRect = ribbon.getBoundingClientRect();
                        const ribbonWidth = ribbonRect.width;
                        if (ribbonWidth > 0 && ribbon.children.length) {
                            const x = Math.max(ribbonRect.left, Math.min(ribbonRect.right, touchX));
                            const t = (x - ribbonRect.left) / ribbonWidth;
                            let index = Math.floor(t * ribbon.children.length);
                            index = Math.max(0, Math.min(ribbon.children.length - 1, index));
                            const child = ribbon.children[index];
                            if (child.hasAttribute('data-omni-blank')) item = null;
                            else if (child.classList.contains('omni-nav-item')) item = child;
                        }
                    }
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

        // Seed state: show logo and urge pulse; playback state leaves play/pause as-is
        const anchorIcon = this.dom.omniAnchorIcon;
        const logoWrap = this.dom.omniAnchorLogoWrap;
        if (!this.isIslandActive) {
            if (anchorIcon) anchorIcon.classList.add('hidden');
            if (logoWrap) {
                logoWrap.classList.remove('hidden');
                logoWrap.classList.add('omni-grid-hint-pulse');
            }
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
        if (actionTrackArt) {
            actionTrackArt.src = Resolver.getCoverUrl(track);
            actionTrackArt.onerror = function () { this.src = store.placeholderCoverUrl192; };
        }

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
        if (omniRepeatOne) omniRepeatOne.classList.toggle('hidden', mode !== 'once');
        
        const indMini = this.dom.miniRepeatOneIndicator;
        if (indMini) indMini.classList.toggle('hidden', mode !== 'once');

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
        if (this.dom.editCoverPreview) this.dom.editCoverPreview.src = cover || store.placeholderCoverUrl;
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
