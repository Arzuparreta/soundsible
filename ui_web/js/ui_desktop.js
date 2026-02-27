/**
 * Desktop UI: sidebar nav, now-playing bar, action menu, keyboard shortcuts.
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { audioEngine } from './audio.js';
import * as renderers from './renderers.js';

function el(id) {
    return document.getElementById(id);
}

const DESKTOP_PLAY_SELECTORS = '.song-row, .song-card, .playlist-track-row, .queue-item';

export const DesktopUI = {
    currentView: 'home',
    currentActionTrack: null,
    selectedTrackId: null,

    setSelectedTrackId(id) {
        this.selectedTrackId = id || null;
        document.querySelectorAll(DESKTOP_PLAY_SELECTORS).forEach((el) => {
            if (el.getAttribute('data-id') === id) el.classList.add('selected');
            else el.classList.remove('selected');
        });
    },

    init() {
        this.applyTheme(store.state.theme);
        this.bindSidebar();
        this.bindNowPlayingBar();
        this.bindContextMenu();
        this.bindKeyboard();
        store.subscribe((state) => this.updatePlayer(state));
    },

    showView(viewId) {
        this.currentView = viewId;
        document.querySelectorAll('.desktop-view').forEach((v) => v.classList.remove('active'));
        document.querySelectorAll('.desktop-nav-btn').forEach((b) => b.classList.remove('active'));
        const viewEl = el(`desktop-view-${viewId}`);
        const btnEl = document.querySelector(`.desktop-nav-btn[data-view="${viewId}"]`);
        if (viewEl) viewEl.classList.add('active');
        if (btnEl) btnEl.classList.add('active');
        const dlQueueContainer = el('desktop-dl-queue-container');
        if (dlQueueContainer) {
            if (viewId === 'discover') dlQueueContainer.classList.remove('hidden');
            else dlQueueContainer.classList.add('hidden');
        }
        if (viewId === 'discover') {
            import('./discover.js').then((m) => m.Discover && m.Discover.init({ mobile: false }));
        }
    },

    navigateBack() {
        if (this.currentView === 'playlist-detail') this.showView('playlists');
        else if (this.currentView === 'artist-detail') this.showView('artists');
        else this.showView('home');
    },

    updatePlayer(state) {
        const fab = el('desktop-queue-count');
        if (fab) {
            const count = state.queue?.length ?? 0;
            fab.textContent = count;
            fab.classList.toggle('queue-has-items', count > 0);
        }

        const cover = el('desktop-np-cover');
        const title = el('desktop-np-title');
        const artist = el('desktop-np-artist');
        const playBtn = el('desktop-np-play');
        const playIcon = playBtn?.querySelector('i');
        const track = state.currentTrack;

        if (cover) cover.style.backgroundImage = track ? `url("${String(Resolver.getCoverUrl(track)).replace(/"/g, '%22')}")` : '';
        if (title) title.textContent = track?.title ?? '';
        if (artist) artist.textContent = track?.artist ?? '';
        if (playBtn && playIcon) {
            playIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';
        }

        const omniPlayIcon = el('desktop-omni-play-icon');
        if (omniPlayIcon) omniPlayIcon.className = state.isPlaying ? 'fas fa-pause text-sm' : 'fas fa-play text-sm';

        const timeCurrent = el('desktop-np-time-current');
        const timeDuration = el('desktop-np-time-duration');
        const timebarRow = el('desktop-np-timebar-row');
        const seek = el('desktop-np-seek');
        const ct = audioEngine.audio?.currentTime ?? 0;
        const nowPlayingBar = el('desktop-now-playing');
        if (nowPlayingBar) nowPlayingBar.classList.toggle('has-track', !!track);
        if (timeCurrent) timeCurrent.textContent = track ? renderers.formatTime(ct) : '0:00';
        if (timeDuration) timeDuration.textContent = track ? renderers.formatTime(track.duration ?? 0) : '0:00';
        if (seek && track?.duration) {
            const pct = track.duration > 0 ? (100 * ct / track.duration) : 0;
            seek.value = Math.min(100, Math.max(0, pct));
        }

        const shuffleBtn = el('desktop-shuffle-btn');
        const repeatBtn = el('desktop-repeat-btn');
        const repeatOneInd = el('desktop-repeat-one-indicator');
        const volumeInput = el('desktop-volume');
        if (shuffleBtn) {
            shuffleBtn.classList.toggle('text-[var(--accent)]', state.shuffleEnabled);
            shuffleBtn.classList.toggle('text-[var(--text-dim)]', !state.shuffleEnabled);
        }
        if (repeatBtn) {
            repeatBtn.classList.toggle('text-[var(--accent)]', state.repeatMode !== 'off');
            repeatBtn.classList.toggle('text-[var(--text-dim)]', state.repeatMode === 'off');
        }
        if (repeatOneInd) repeatOneInd.classList.toggle('hidden', state.repeatMode !== 'once');
        if (volumeInput) {
            const vol = state.volume;
            volumeInput.value = Math.round(Number.isFinite(vol) ? Math.min(100, Math.max(0, vol * 100)) : 100);
        }
        const volumeIcon = el('desktop-volume-icon');
        const volumeMuteBtn = el('desktop-volume-mute-btn');
        if (volumeIcon) {
            volumeIcon.className = state.muted ? 'fas fa-volume-xmark text-xs' : 'fas fa-volume-high text-xs';
        }
        if (volumeMuteBtn) volumeMuteBtn.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
    },

    showToast(msg) {
        const container = el('toast-container');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'glass-view px-4 py-2 rounded-xl text-sm font-medium text-[var(--text-main)] border border-[var(--glass-border)]';
        div.textContent = msg;
        container.appendChild(div);
        setTimeout(() => div.remove(), 2500);
    },

    showActionMenu(trackId) {
        const track = store.state.library.find((t) => t.id === trackId);
        if (!track) return;
        this.currentActionTrack = track;

        const menu = el('desktop-action-menu');
        const titleEl = el('desktop-action-track-title');
        const artistEl = el('desktop-action-track-artist');
        const artEl = el('desktop-action-track-art');
        const favText = el('desktop-action-fav-text');
        const queueText = el('desktop-action-queue-text');

        if (titleEl) titleEl.textContent = track.title;
        if (artistEl) artistEl.textContent = track.artist;
        if (artEl) artEl.style.backgroundImage = `url("${String(Resolver.getCoverUrl(track)).replace(/"/g, '%22')}")`;
        if (favText) favText.textContent = store.state.favorites.includes(trackId) ? 'Remove from Favourites' : 'Add to Favourites';
        if (queueText) queueText.textContent = store.state.queue.some((t) => t.id === trackId) ? 'Remove from Queue' : 'Add to Queue';

        const inPlaylistDetail = this.currentView === 'playlist-detail';
        const actDelete = el('desktop-action-delete');
        const actAddToPlaylist = el('desktop-action-add-to-playlist');
        const actRemoveFromPlaylist = el('desktop-action-remove-from-playlist');
        if (actDelete) actDelete.classList.toggle('hidden', inPlaylistDetail);
        if (actAddToPlaylist) actAddToPlaylist.classList.toggle('hidden', inPlaylistDetail);
        if (actRemoveFromPlaylist) actRemoveFromPlaylist.classList.toggle('hidden', !inPlaylistDetail);

        if (menu) menu.classList.remove('hidden');
    },

    hideActionMenu() {
        const menu = el('desktop-action-menu');
        if (menu) menu.classList.add('hidden');
        this.currentActionTrack = null;
    },

    showContextMenu(trackId, clientX, clientY) {
        const track = store.state.library.find((t) => t.id === trackId);
        if (!track) return;
        this.currentActionTrack = track;

        const menu = el('desktop-context-menu');
        const queueText = el('desktop-context-queue-text');
        const favText = el('desktop-context-fav-text');
        if (queueText) queueText.textContent = store.state.queue.some((t) => t.id === trackId) ? 'Remove from Queue' : 'Add to Queue';
        if (favText) favText.textContent = store.state.favorites.includes(trackId) ? 'Remove from Favourites' : 'Add to Favourites';

        const inPlaylistDetail = this.currentView === 'playlist-detail';
        const ctxDelete = el('desktop-context-delete');
        const ctxAddToPlaylist = el('desktop-context-add-to-playlist');
        const ctxRemoveFromPlaylist = el('desktop-context-remove-from-playlist');
        if (ctxDelete) ctxDelete.classList.toggle('hidden', inPlaylistDetail);
        if (ctxAddToPlaylist) ctxAddToPlaylist.classList.toggle('hidden', inPlaylistDetail);
        if (ctxRemoveFromPlaylist) ctxRemoveFromPlaylist.classList.toggle('hidden', !inPlaylistDetail);

        if (!menu) return;
        menu.style.left = `${clientX + 4}px`;
        menu.style.top = `${clientY + 4}px`;
        menu.classList.remove('hidden');
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            const pad = 8;
            let left = parseFloat(menu.style.left) || clientX + 4;
            let top = parseFloat(menu.style.top) || clientY + 4;
            if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
            if (top + rect.height > window.innerHeight - pad) top = window.innerHeight - rect.height - pad;
            if (left < pad) left = pad;
            if (top < pad) top = pad;
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        });
    },

    hideContextMenu() {
        const menu = el('desktop-context-menu');
        if (menu) menu.classList.add('hidden');
        if (this._contextMenuOpen) this.currentActionTrack = null;
        this._contextMenuOpen = false;
    },

    _contextMenuOpen: false,

    bindContextMenu() {
        const app = el('desktop-app');
        const menu = el('desktop-context-menu');
        if (!app) return;

        document.addEventListener('contextmenu', (e) => {
            if (e.target.closest('input, textarea, select')) return;
            e.preventDefault();
            const row = e.target.closest('.song-row, .song-card, .queue-item');
            const trackId = row?.getAttribute?.('data-id');
            if (trackId) {
                this._contextMenuOpen = true;
                this.showContextMenu(trackId, e.clientX, e.clientY);
            }
        });

        document.addEventListener('mousedown', (e) => {
            if (!menu || menu.classList.contains('hidden')) return;
            if (menu.contains(e.target)) return;
            this.hideContextMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.hideContextMenu();
        });

        const queueBtn = el('desktop-context-queue');
        const editBtn = el('desktop-context-edit-metadata');
        const favBtn = el('desktop-context-fav');
        const deleteBtn = el('desktop-context-delete');
        if (queueBtn) {
            queueBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                if (track) store.toggleQueue(track.id);
                this.hideContextMenu();
            });
        }
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                this.hideContextMenu();
                if (track) this.showMetadataEditor(track.id);
            });
        }
        if (favBtn) {
            favBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                if (track) store.toggleFavourite(track.id);
                this.hideContextMenu();
            });
        }
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                this.hideContextMenu();
                if (track && confirm('Delete?')) store.deleteTrack(track.id);
            });
        }
        const addToPlaylistBtn = el('desktop-context-add-to-playlist');
        if (addToPlaylistBtn) {
            addToPlaylistBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                this.hideContextMenu();
                if (track && typeof window.showAddToPlaylistPicker === 'function') window.showAddToPlaylistPicker(track.id);
            });
        }
        const removeFromPlaylistBtn = el('desktop-context-remove-from-playlist');
        if (removeFromPlaylistBtn) {
            removeFromPlaylistBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                const name = window._currentPlaylistName;
                this.hideContextMenu();
                if (track && name) store.removeFromPlaylist(name, track.id);
            });
        }
    },

    _editingTrack: null,
    _edBound: false,

    showMetadataEditor(trackId) {
        const t = store.state.library.find((x) => x.id === trackId);
        if (!t) return;
        this.hideActionMenu();
        this._editingTrack = t;

        const modal = el('metadata-editor');
        const content = el('metadata-editor-content');
        el('edit-title').value = t.title;
        el('edit-artist').value = t.artist;
        el('edit-album').value = t.album;
        el('edit-cover-preview').src = Resolver.getCoverUrl(t);

        if (modal) modal.classList.remove('hidden');
        setTimeout(() => {
            if (content) {
                content.classList.replace('scale-95', 'scale-100');
                content.classList.replace('opacity-0', 'opacity-100');
            }
        }, 10);

        if (!this._edBound) {
            el('edit-save-btn').onclick = () => this.saveMetadata();
            el('edit-auto-fetch-btn').onclick = () => this.autoFetch();
            const uploadBtn = el('edit-upload-btn');
            const fileInput = el('edit-file-input');
            if (uploadBtn && fileInput) {
                uploadBtn.onclick = () => fileInput.click();
                fileInput.onchange = (e) => this.handleCoverUpload(e);
            }
            this._edBound = true;
        }
    },

    hideMetadataEditor() {
        const modal = el('metadata-editor');
        const content = el('metadata-editor-content');
        if (content) {
            content.classList.replace('scale-100', 'scale-95');
            content.classList.replace('opacity-100', 'opacity-0');
        }
        setTimeout(() => modal && modal.classList.add('hidden'), 300);
    },

    async saveMetadata() {
        if (!this._editingTrack) return;
        const status = el('edit-status');
        status.textContent = 'Saving Changes...';

        const metadata = {
            title: el('edit-title').value,
            artist: el('edit-artist').value,
            album: el('edit-album').value
        };

        const success = await store.updateMetadata(this._editingTrack.id, metadata);
        if (success) {
            this.showToast('Metadata Updated');
            this.hideMetadataEditor();
        } else {
            status.textContent = 'Save Failed';
        }
    },

    async autoFetch() {
        if (!this._editingTrack) return;
        const status = el('edit-status');
        const resultsContainer = el('auto-fetch-results');
        status.textContent = 'Searching technical data...';
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('hidden');

        const query = `${el('edit-title').value} ${el('edit-artist').value}`;
        const results = await store.searchMetadata(query);

        if (!results || results.length === 0) {
            status.textContent = 'No matches found';
            return;
        }
        status.textContent = 'Matches found';
        resultsContainer.classList.remove('hidden');
        resultsContainer.innerHTML = results.slice(0, 5).map((r) => {
            const title = (r.title || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const artist = (r.artist || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const album = (r.album || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const cover = (r.cover || '').replace(/"/g, '&quot;');
            const placeholder = store.placeholderCoverUrl.replace(/'/g, "\\'");
            return `<div class="flex items-center p-3 hover:bg-[var(--surface-overlay)] rounded-[var(--radius-omni-sm)] cursor-pointer transition-colors border border-transparent active:border-[var(--accent)]/30 active:bg-[var(--accent)]/5" data-meta-title="${title}" data-meta-artist="${artist}" data-meta-album="${album}" data-meta-cover="${cover}">
                <img src="${cover}" class="w-10 h-10 rounded-[var(--radius-omni-xs)] object-cover shadow-md" onerror="this.src='${placeholder}'">
                <div class="ml-3 truncate">
                    <div class="text-xs font-bold truncate text-[var(--text-main)]">${(r.title || '').replace(/</g, '&lt;')}</div>
                    <div class="text-[9px] font-bold text-[var(--text-dim)] truncate uppercase tracking-widest font-mono">${(r.artist || '').replace(/</g, '&lt;')}</div>
                </div>
            </div>`;
        }).join('');

        resultsContainer.querySelectorAll('[data-meta-title]').forEach((node) => {
            node.addEventListener('click', () => {
                this.applyFetchedMetadata(
                    node.getAttribute('data-meta-title') || '',
                    node.getAttribute('data-meta-artist') || '',
                    node.getAttribute('data-meta-album') || '',
                    node.getAttribute('data-meta-cover') || ''
                );
            });
        });
    },

    applyFetchedMetadata(title, artist, album, cover) {
        el('edit-title').value = title;
        el('edit-artist').value = artist;
        el('edit-album').value = album;
        el('edit-cover-preview').src = cover || store.placeholderCoverUrl;
        el('auto-fetch-results').classList.add('hidden');
        el('edit-status').textContent = 'Metadata applied locally';
    },

    async handleCoverUpload(e) {
        const file = e.target.files[0];
        if (!file || !this._editingTrack) return;
        const status = el('edit-status');
        status.textContent = 'Uploading Cover Art...';

        const success = await store.uploadCover(this._editingTrack.id, file);
        if (success) {
            this.showToast('Cover Art Updated');
            el('edit-cover-preview').src = URL.createObjectURL(file);
            status.textContent = 'Cover applied';
        } else {
            status.textContent = 'Upload Failed';
        }
        e.target.value = '';
    },

    applyTheme(theme) {
        const valid = ['dark', 'light', 'odst'].includes(theme) ? theme : 'dark';
        const root = document.documentElement;
        root.setAttribute('data-theme', valid);
        const meta = document.getElementById('meta-theme-color');
        if (meta) meta.content = valid === 'light' ? '#f5f5f5' : valid === 'odst' ? '#1c2026' : '#0d0d0f';
        const select = el('desktop-settings-theme-select');
        if (select) select.value = valid;
    },

    bindSidebar() {
        document.querySelectorAll('.desktop-nav-btn[data-view]').forEach((btn) => {
            btn.addEventListener('click', () => this.showView(btn.getAttribute('data-view')));
        });
        const queueBtn = el('desktop-queue-btn');
        const queuePanel = el('desktop-queue-panel');
        if (queueBtn && queuePanel) {
            queueBtn.addEventListener('click', () => {
                const isOpen = !queuePanel.classList.toggle('hidden');
                queueBtn.setAttribute('aria-expanded', String(isOpen));
                queueBtn.classList.toggle('queue-panel-open', isOpen);
            });
        }
        const queueClearBtn = el('desktop-queue-clear-btn');
        if (queueClearBtn) queueClearBtn.addEventListener('click', () => store.clearQueue());

        const logoOmni = el('desktop-logo-omni');
        if (logoOmni) {
            logoOmni.addEventListener('click', () => {
                logoOmni.classList.toggle('logo-omni-seed');
            });
        }
    },

    bindNowPlayingBar() {
        const playBtn = el('desktop-np-play');
        const prevBtn = el('desktop-np-prev');
        const nextBtn = el('desktop-np-next');
        const omniPlay = el('desktop-omni-play');
        const omniPrev = el('desktop-omni-prev');
        const omniNext = el('desktop-omni-next');
        const seek = el('desktop-np-seek');
        const npCover = el('desktop-np-cover');

        if (playBtn) playBtn.addEventListener('click', () => (store.state.isPlaying ? audioEngine.pause() : audioEngine.play()));
        if (prevBtn) prevBtn.addEventListener('click', () => audioEngine.prev());
        if (nextBtn) nextBtn.addEventListener('click', () => audioEngine.next());
        if (omniPlay) omniPlay.addEventListener('click', () => (store.state.isPlaying ? audioEngine.pause() : audioEngine.play()));
        if (omniPrev) omniPrev.addEventListener('click', () => audioEngine.prev());
        if (omniNext) omniNext.addEventListener('click', () => audioEngine.next());

        if (seek) {
            seek.addEventListener('input', () => {
                audioEngine.seek(Number(seek.value));
            });
        }

        if (npCover) {
            npCover.addEventListener('click', () => {
                const track = store.state.currentTrack;
                if (track) this.showFullCoverView(Resolver.getCoverUrl(track));
            });
        }

        const shuffleBtn = el('desktop-shuffle-btn');
        const repeatBtn = el('desktop-repeat-btn');
        const volumeInput = el('desktop-volume');
        const volumeMuteBtn = el('desktop-volume-mute-btn');
        if (shuffleBtn) shuffleBtn.addEventListener('click', () => store.toggleShuffle());
        if (repeatBtn) repeatBtn.addEventListener('click', () => store.toggleRepeat());
        if (volumeMuteBtn) {
            volumeMuteBtn.addEventListener('click', () => {
                store.toggleMute();
                audioEngine.setVolume(store.state.muted ? 0 : store.state.volume);
            });
        }
        if (volumeInput) {
            volumeInput.addEventListener('input', () => {
                const v = Number(volumeInput.value) / 100;
                audioEngine.setVolume(v);
                const patch = { volume: v };
                if (store.state.muted && v > 0) patch.muted = false;
                store.update(patch);
            });
        }

        this.bindFullCoverOverlay();
        window.addEventListener('audio:timeupdate', () => this.updatePlayer(store.state));
    },

    showFullCoverView(coverUrl) {
        const overlay = el('full-cover-overlay');
        const img = el('full-cover-image');
        if (!overlay || !img) return;
        const url = (coverUrl || store.placeholderCoverUrl).replace(/"/g, '%22').replace(/'/g, '%27');
        img.style.backgroundImage = `url("${url}")`;
        overlay.classList.remove('hidden');
    },

    hideFullCoverView() {
        const overlay = el('full-cover-overlay');
        if (overlay) overlay.classList.add('hidden');
    },

    bindFullCoverOverlay() {
        const overlay = el('full-cover-overlay');
        const backdrop = el('full-cover-overlay-backdrop');
        const closeBottom = el('full-cover-close-bottom');
        if (backdrop) backdrop.addEventListener('click', () => this.hideFullCoverView());
        if (closeBottom) closeBottom.addEventListener('click', () => this.hideFullCoverView());
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) this.hideFullCoverView();
            });
        }
    },

    bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.target.closest('input, textarea, select')) return;
            if (e.code === 'Enter' && this.selectedTrackId && typeof window.playTrack === 'function') {
                e.preventDefault();
                window.playTrack(this.selectedTrackId);
                return;
            }
            if (e.code === 'Space') {
                e.preventDefault();
                if (store.state.currentTrack) (store.state.isPlaying ? audioEngine.pause() : audioEngine.play());
            }
            if (e.code === 'ArrowLeft') {
                e.preventDefault();
                const ct = audioEngine.audio?.currentTime ?? 0;
                if (audioEngine.audio?.duration) audioEngine.seek(Math.max(0, (100 * (ct - 10) / audioEngine.audio.duration)));
            }
            if (e.code === 'ArrowRight') {
                e.preventDefault();
                const ct = audioEngine.audio?.currentTime ?? 0;
                const dur = audioEngine.audio?.duration;
                if (dur) audioEngine.seek(Math.min(100, (100 * (ct + 10) / dur)));
            }
        });
    }
};

window.UI = DesktopUI;
