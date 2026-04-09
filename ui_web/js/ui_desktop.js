/**
 * Desktop UI: sidebar nav, now-playing bar, action menu, keyboard shortcuts.
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { audioEngine } from './audio.js';
import { getYouTubeWatchUrlForTrack, shareYouTubeTrack, isYtdlpPreviewStreamTrack } from './shared.js';
import * as renderers from './renderers.js';
import { createCoverOverlayController } from './cover_overlay.js';
import { attachSeekBar, bindSeekSliderKeys } from './seek_bar.js';
function el(id) {
    return document.getElementById(id);
}

const DESKTOP_PLAY_SELECTORS = '.song-row, .song-card, .playlist-track-row, .queue-item';

export const DesktopUI = {
    currentView: 'discover',
    currentActionTrack: null,
    selectedTrackId: null,
    _lastProgressTrackId: null,
    _volumeDragging: false,
    _volumePointerBaseline: null,

    setSelectedTrackId(id) {
        this.selectedTrackId = id || null;
        document.querySelectorAll(DESKTOP_PLAY_SELECTORS).forEach((el) => {
            if (el.getAttribute('data-id') === id) el.classList.add('selected');
            else el.classList.remove('selected');
        });
    },

    init() {
        store.applyTheme(store.state.theme);
        const select = el('desktop-settings-theme-select');
        if (select) select.value = store.state.theme;
        this.coverOverlay = createCoverOverlayController({
            getOverlay: () => el('full-cover-overlay'),
            getImage: () => el('full-cover-image'),
            getBackdrop: () => el('full-cover-overlay-backdrop'),
            getCloseButton: () => el('full-cover-close-bottom'),
            getFallbackCoverUrl: () => store.placeholderCoverUrl
        });
        this.coverOverlay.bind();
        this.metadataEditor = null;
        this._metadataEditorInit = import('./metadata_editor.js').then(({ createMetadataEditor }) => {
            this.metadataEditor = createMetadataEditor({
                store,
                resolver: Resolver,
                getTrackById: (trackId) => store.state.library.find((track) => track.id === trackId),
                getElements: () => ({
                    metadataEditor: el('metadata-editor'),
                    metadataEditorContent: el('metadata-editor-content'),
                    editTitle: el('edit-title'),
                    editArtist: el('edit-artist'),
                    editAlbum: el('edit-album'),
                    editCoverPreview: el('edit-cover-preview'),
                    editSaveBtn: el('edit-save-btn'),
                    editUploadBtn: el('edit-upload-btn'),
                    editFileInput: el('edit-file-input'),
                    editStatus: el('edit-status'),
                    editRawYoutubeNote: el('edit-raw-youtube-note')
                }),
                showToast: (message) => this.showToast(message)
            });
        });
        this.bindSidebar();
        this.bindNowPlayingBar();
        this.bindContextMenu();
        this.bindKeyboard();
    },

    showView(viewId) {
        this.currentView = viewId;
        document.querySelectorAll('.desktop-view').forEach((v) => v.classList.remove('active'));
        document.querySelectorAll('.desktop-nav-btn').forEach((b) => b.classList.remove('active'));
        const viewEl = el(`desktop-view-${viewId}`);
        if (viewEl) viewEl.classList.add('active');
        const btnEl = document.querySelector(`.desktop-nav-btn[data-view="${viewId}"]`);
        if (btnEl) btnEl.classList.add('active');
        const main = el('desktop-main');
        if (main) {
            main.classList.toggle('desktop-main--discover', viewId === 'discover');
            main.classList.toggle('desktop-main--settings', viewId === 'settings');
        }
    },

    navigateBack() {
        if (this.currentView === 'playlist-detail') this.showView('playlists');
        else if (this.currentView === 'artist-detail') this.showView('artists');
        else this.showView('discover');
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
        const dlBtn = el('desktop-np-download-btn');
        if (dlBtn) dlBtn.classList.toggle('hidden', !isYtdlpPreviewStreamTrack(track));
        if (playBtn && playIcon) {
            playIcon.className = state.isPlaying ? 'fas fa-pause' : 'fas fa-play';
        }

        const omniPlayIcon = el('desktop-omni-play-icon');
        if (omniPlayIcon) omniPlayIcon.className = state.isPlaying ? 'fas fa-pause text-sm' : 'fas fa-play text-sm';

        const trackId = track?.id ?? null;
        const trackJustChanged = trackId != null && trackId !== this._lastProgressTrackId;
        if (trackJustChanged) this._lastProgressTrackId = trackId;
        const nowPlayingBar = el('desktop-now-playing');
        if (nowPlayingBar) nowPlayingBar.classList.toggle('has-track', !!track);
        if (trackJustChanged) {
            const timeCurrent = el('desktop-np-time-current');
            const timeDuration = el('desktop-np-time-duration');
            const seekProgress = el('desktop-np-seek-progress');
            if (timeCurrent) timeCurrent.textContent = '0:00';
            if (timeDuration) timeDuration.textContent = track ? renderers.formatTime(track.duration ?? 0) : '0:00';
            if (seekProgress) {
                seekProgress.style.transition = 'none';
                seekProgress.style.width = '0%';
                seekProgress.style.transition = '';
            }
            const seekEl = el('desktop-np-seek-container');
            if (seekEl) {
                seekEl.setAttribute('aria-valuenow', '0');
                seekEl.setAttribute('aria-valuemin', '0');
                seekEl.setAttribute('aria-valuemax', '100');
                const durs = track ? renderers.formatTime(track.duration ?? 0) : '0:00';
                seekEl.setAttribute('aria-valuetext', `0:00 / ${durs}`);
            }
        }

        const shuffleBtn = el('desktop-shuffle-btn');
        const repeatBtn = el('desktop-repeat-btn');
        const repeatOneInd = el('desktop-repeat-one-indicator');
        const volumeInput = el('desktop-volume');
        if (shuffleBtn) {
            shuffleBtn.classList.toggle('text-[var(--accent)]', state.shuffleEnabled);
            shuffleBtn.classList.toggle('text-[var(--text-dim)]', !state.shuffleEnabled);
            shuffleBtn.classList.toggle('desktop-np-mode-on', state.shuffleEnabled);
        }
        if (repeatBtn) {
            repeatBtn.classList.toggle('text-[var(--accent)]', state.repeatMode !== 'off');
            repeatBtn.classList.toggle('text-[var(--text-dim)]', state.repeatMode === 'off');
            repeatBtn.classList.toggle('desktop-np-mode-on', state.repeatMode !== 'off');
        }
        if (repeatOneInd) repeatOneInd.classList.toggle('hidden', state.repeatMode !== 'once');
        if (volumeInput && !this._volumeDragging) {
            const vol = state.volume;
            volumeInput.value = Math.round(Number.isFinite(vol) ? Math.min(100, Math.max(0, vol * 100)) : 100);
        }
        const volumeIcon = el('desktop-volume-icon');
        const volumeMuteBtn = el('desktop-volume-mute-btn');
        if (volumeIcon) {
            volumeIcon.className = state.volume === 0 ? 'fas fa-volume-xmark text-xs' : 'fas fa-volume-high text-xs';
        }
        if (volumeMuteBtn) volumeMuteBtn.setAttribute('aria-label', state.volume === 0 ? 'Unmute' : 'Mute');
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

    showActionMenu(trackId, sourceEl) {
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

        const actShare = el('desktop-action-share');
        if (actShare) actShare.classList.toggle('hidden', !getYouTubeWatchUrlForTrack(track));

        const inPlaylistDetail = sourceEl ? !!sourceEl.closest('#desktop-playlist-detail-tracks') : this.currentView === 'playlist-detail';
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

    showContextMenu(trackId, clientX, clientY, row) {
        const track = store.state.library.find((t) => t.id === trackId);
        if (!track) return;
        this.currentActionTrack = track;

        const menu = el('desktop-context-menu');
        const queueText = el('desktop-context-queue-text');
        const favText = el('desktop-context-fav-text');
        if (queueText) queueText.textContent = store.state.queue.some((t) => t.id === trackId) ? 'Remove from Queue' : 'Add to Queue';
        if (favText) favText.textContent = store.state.favorites.includes(trackId) ? 'Remove from Favourites' : 'Add to Favourites';

        const ctxFav = el('desktop-context-fav');
        const ctxQueue = el('desktop-context-queue');
        const ctxShare = el('desktop-context-share');
        const ctxAddToPlaylist = el('desktop-context-add-to-playlist');
        const ctxEdit = el('desktop-context-edit-metadata');
        const ctxRemoveFromPlaylist = el('desktop-context-remove-from-playlist');
        const ctxDelete = el('desktop-context-delete');
        if (ctxFav) ctxFav.classList.remove('hidden');
        if (ctxQueue) ctxQueue.classList.remove('hidden');
        if (ctxAddToPlaylist) ctxAddToPlaylist.classList.remove('hidden');
        if (ctxEdit) ctxEdit.classList.remove('hidden');
        if (ctxRemoveFromPlaylist) ctxRemoveFromPlaylist.classList.remove('hidden');
        if (ctxDelete) ctxDelete.classList.remove('hidden');
        if (ctxShare) ctxShare.classList.toggle('hidden', !getYouTubeWatchUrlForTrack(track));

        const inPlaylistDetail = row ? !!row.closest('#desktop-playlist-detail-tracks') : this.currentView === 'playlist-detail';
        const ctxPlayPlaylist = el('desktop-context-play-playlist');
        const ctxDeletePlaylist = el('desktop-context-delete-playlist');
        if (ctxPlayPlaylist) ctxPlayPlaylist.classList.add('hidden');
        if (ctxDeletePlaylist) ctxDeletePlaylist.classList.add('hidden');
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

    showPlaylistContextMenu(playlistName, clientX, clientY, cardEl) {
        const menu = el('desktop-context-menu');
        if (!menu || !playlistName) return;

        const ctxFav = el('desktop-context-fav');
        const ctxQueue = el('desktop-context-queue');
        const ctxShare = el('desktop-context-share');
        const ctxAddToPlaylist = el('desktop-context-add-to-playlist');
        const ctxEdit = el('desktop-context-edit-metadata');
        const ctxRemoveFromPlaylist = el('desktop-context-remove-from-playlist');
        const ctxDeleteTrack = el('desktop-context-delete');
        const ctxPlayPlaylist = el('desktop-context-play-playlist');
        const ctxDeletePlaylist = el('desktop-context-delete-playlist');

        // Note: Hide all track-specific actions
        if (ctxFav) ctxFav.classList.add('hidden');
        if (ctxQueue) ctxQueue.classList.add('hidden');
        if (ctxShare) ctxShare.classList.add('hidden');
        if (ctxAddToPlaylist) ctxAddToPlaylist.classList.add('hidden');
        if (ctxEdit) ctxEdit.classList.add('hidden');
        if (ctxRemoveFromPlaylist) ctxRemoveFromPlaylist.classList.add('hidden');
        if (ctxDeleteTrack) ctxDeleteTrack.classList.add('hidden');

        // Note: Show playlist-specific actions
        if (ctxPlayPlaylist) ctxPlayPlaylist.classList.remove('hidden');
        if (ctxDeletePlaylist) ctxDeletePlaylist.classList.remove('hidden');

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
        if (this._contextMenuOpen) {
            this.currentActionTrack = null;
            this.currentContextPlaylistName = null;
        }
        this._contextMenuOpen = false;
    },

    currentContextPlaylistName: null,
    _contextMenuOpen: false,

    bindContextMenu() {
        const app = el('desktop-app');
        const menu = el('desktop-context-menu');
        if (!app) return;

        document.addEventListener('contextmenu', (e) => {
            if (e.target.closest('input, textarea, select')) return;

            // Note: Playlist cards (in playlists grid)
            const playlistCard = e.target.closest('.playlist-card');
            if (playlistCard && this.currentView === 'playlists') {
                e.preventDefault();
                const name = playlistCard.getAttribute('data-playlist-name');
                if (!name) return;
                this._contextMenuOpen = true;
                this.currentContextPlaylistName = name;
                this.showPlaylistContextMenu(name, e.clientX, e.clientY, playlistCard);
                return;
            }

            // Note: Track rows / cards / queue items
            e.preventDefault();
            const row = e.target.closest('.song-row, .song-card, .queue-item');
            const trackId = row?.getAttribute?.('data-id');
            if (trackId) {
                this._contextMenuOpen = true;
                this.showContextMenu(trackId, e.clientX, e.clientY, row);
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
        const shareBtn = el('desktop-context-share');
        if (shareBtn) {
            shareBtn.addEventListener('click', () => {
                const track = this.currentActionTrack;
                if (track && getYouTubeWatchUrlForTrack(track)) shareYouTubeTrack(track, (m) => this.showToast(m));
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
        const playPlaylistBtn = el('desktop-context-play-playlist');
        if (playPlaylistBtn) {
            playPlaylistBtn.addEventListener('click', () => {
                const name = this.currentContextPlaylistName;
                this.hideContextMenu();
                if (name && typeof window.playPlaylistFromContext === 'function') {
                    window.playPlaylistFromContext(name);
                }
            });
        }
        const deletePlaylistBtn = el('desktop-context-delete-playlist');
        if (deletePlaylistBtn) {
            deletePlaylistBtn.addEventListener('click', () => {
                const name = this.currentContextPlaylistName;
                this.hideContextMenu();
                if (name && typeof window.deletePlaylistConfirm === 'function') {
                    window._currentPlaylistName = name;
                    window.deletePlaylistConfirm();
                }
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

    async showMetadataEditor(trackId) {
        this.hideActionMenu();
        await this._metadataEditorInit;
        this.metadataEditor?.show(trackId);
    },

    async hideMetadataEditor() {
        await this._metadataEditorInit;
        this.metadataEditor?.hide();
    },

    async saveMetadata() {
        await this._metadataEditorInit;
        await this.metadataEditor?.save();
    },

    async handleCoverUpload(e) {
        await this._metadataEditorInit;
        await this.metadataEditor?.handleCoverUpload(e);
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

    },

    bindNowPlayingBar() {
        const playBtn = el('desktop-np-play');
        const prevBtn = el('desktop-np-prev');
        const nextBtn = el('desktop-np-next');
        const omniPlay = el('desktop-omni-play');
        const omniPrev = el('desktop-omni-prev');
        const omniNext = el('desktop-omni-next');
        const seekContainer = el('desktop-np-seek-container');
        const seekProgress = el('desktop-np-seek-progress');
        const npCover = el('desktop-np-cover');

        const desktopSeekDragRef = { current: false };
        const desktopDurationState = { last: 0 };

        if (playBtn) playBtn.addEventListener('click', () => (store.state.isPlaying ? audioEngine.pause() : audioEngine.play()));
        if (prevBtn) prevBtn.addEventListener('click', () => audioEngine.prev());
        if (nextBtn) nextBtn.addEventListener('click', () => audioEngine.next());
        if (omniPlay) omniPlay.addEventListener('click', () => (store.state.isPlaying ? audioEngine.pause() : audioEngine.play()));
        if (omniPrev) omniPrev.addEventListener('click', () => audioEngine.prev());
        if (omniNext) omniNext.addEventListener('click', () => audioEngine.next());

        if (seekContainer && seekProgress) {
            attachSeekBar(seekContainer, seekProgress, {
                dragRef: desktopSeekDragRef,
                durationState: desktopDurationState,
                onScrub: (pct, cur, dur) => {
                    const timeCurrent = el('desktop-np-time-current');
                    const timeDuration = el('desktop-np-time-duration');
                    if (timeCurrent) timeCurrent.textContent = renderers.formatTime(cur);
                    if (timeDuration) timeDuration.textContent = renderers.formatTime(dur);
                    seekContainer.setAttribute('aria-valuenow', String(Math.round(pct)));
                    seekContainer.setAttribute('aria-valuetext', `${renderers.formatTime(cur)} / ${renderers.formatTime(dur)}`);
                }
            });
            bindSeekSliderKeys(seekContainer, seekProgress, {
                dragRef: desktopSeekDragRef,
                durationState: desktopDurationState,
                onScrub: (pct, cur, dur) => {
                    const timeCurrent = el('desktop-np-time-current');
                    const timeDuration = el('desktop-np-time-duration');
                    if (timeCurrent) timeCurrent.textContent = renderers.formatTime(cur);
                    if (timeDuration) timeDuration.textContent = renderers.formatTime(dur);
                    seekContainer.setAttribute('aria-valuenow', String(Math.round(pct)));
                    seekContainer.setAttribute('aria-valuetext', `${renderers.formatTime(cur)} / ${renderers.formatTime(dur)}`);
                }
            });
        }

        document.addEventListener('touchmove', (e) => {
            if (desktopSeekDragRef.current && e.cancelable) e.preventDefault();
        }, { passive: false });
        document.addEventListener('wheel', (e) => {
            if (desktopSeekDragRef.current) e.preventDefault();
        }, { passive: false });

        if (npCover) {
            npCover.addEventListener('click', () => {
                const track = store.state.currentTrack;
                if (track) this.showFullCoverView(Resolver.getCoverUrl(track));
            });
        }

        const npDownload = el('desktop-np-download-btn');
        if (npDownload) {
            npDownload.addEventListener('click', (e) => {
                e.stopPropagation();
                const Dl = window.Downloader;
                if (Dl && typeof Dl.addPreviewStreamToDownloadQueue === 'function') {
                    Dl.addPreviewStreamToDownloadQueue(store.state.currentTrack);
                }
            });
        }

        const shuffleBtn = el('desktop-shuffle-btn');
        const repeatBtn = el('desktop-repeat-btn');
        const volumeInput = el('desktop-volume');
        const volumeMuteBtn = el('desktop-volume-mute-btn');
        const volumeWrap = el('desktop-volume-wrap');
        if (shuffleBtn) shuffleBtn.addEventListener('click', () => store.toggleShuffle());
        if (repeatBtn) repeatBtn.addEventListener('click', () => store.toggleRepeat());
        if (volumeMuteBtn) {
            volumeMuteBtn.addEventListener('click', () => {
                this._volumeDragging = false;
                this._volumePointerBaseline = null;
                if (store.state.volume > 0) {
                    const volumeBeforeMute = store.state.volume;
                    store.update({ volume: 0, volumeBeforeMute });
                    audioEngine.setVolume(0);
                } else {
                    const restore = store.state.volumeBeforeMute ?? 1;
                    store.update({ volume: restore });
                    audioEngine.setVolume(restore);
                }
            });
        }
        if (volumeInput) {
            let volumeCommitTimer = null;
            const commitPointerVolume = () => {
                if (!this._volumeDragging) return;
                this._volumeDragging = false;
                volumeWrap?.classList.remove('is-volume-open');
                if (volumeCommitTimer) {
                    clearTimeout(volumeCommitTimer);
                    volumeCommitTimer = null;
                }
                const v = Number(volumeInput.value) / 100;
                const patch = { volume: v };
                if (v === 0 && (this._volumePointerBaseline ?? store.state.volume) > 0) {
                    patch.volumeBeforeMute = this._volumePointerBaseline ?? store.state.volume;
                }
                store.update(patch);
                this._volumePointerBaseline = null;
            };
            const scheduleIdleVolumePersist = () => {
                if (this._volumeDragging) return;
                if (volumeCommitTimer) clearTimeout(volumeCommitTimer);
                volumeCommitTimer = setTimeout(() => {
                    volumeCommitTimer = null;
                    const v = Number(volumeInput.value) / 100;
                    const patch = { volume: v };
                    if (v === 0 && store.state.volume > 0) patch.volumeBeforeMute = store.state.volume;
                    store.update(patch);
                }, 140);
            };
            volumeInput.addEventListener('pointerdown', () => {
                this._volumeDragging = true;
                this._volumePointerBaseline = store.state.volume;
                volumeWrap?.classList.add('is-volume-open');
            });
            volumeInput.addEventListener('input', () => {
                const v = Number(volumeInput.value) / 100;
                audioEngine.setVolume(v);
            });
            const endVolumePointer = () => commitPointerVolume();
            volumeInput.addEventListener('pointerup', endVolumePointer);
            volumeInput.addEventListener('pointercancel', endVolumePointer);
            volumeInput.addEventListener('change', () => {
                if (this._volumeDragging) {
                    commitPointerVolume();
                    return;
                }
                scheduleIdleVolumePersist();
            });
            volumeInput.addEventListener('blur', () => {
                if (volumeCommitTimer) {
                    clearTimeout(volumeCommitTimer);
                    volumeCommitTimer = null;
                }
                if (this._volumeDragging) return;
                const v = Number(volumeInput.value) / 100;
                const patch = { volume: v };
                if (v === 0 && store.state.volume > 0) patch.volumeBeforeMute = store.state.volume;
                store.update(patch);
            });
            document.addEventListener('pointerup', endVolumePointer);
            document.addEventListener('pointercancel', endVolumePointer);
        }

        // Note: Progress bar and time labels must come from event detail only (never audio.currenttime here),
        // Note: So the bar resets to 0 when a new track starts instead of showing the previous track's position.
        window.addEventListener('audio:timeupdate', (e) => {
            const d = e.detail;
            if (d && typeof d.progress === 'number' && store.state.currentTrack) {
                const pct = Math.min(100, Math.max(0, d.progress));
                const timeCurrent = el('desktop-np-time-current');
                const timeDuration = el('desktop-np-time-duration');
                const container = el('desktop-np-seek-container');
                const bar = el('desktop-np-seek-progress');
                if (typeof d.duration === 'number') desktopDurationState.last = d.duration;
                if (!desktopSeekDragRef.current && bar) bar.style.width = `${pct}%`;
                if (timeCurrent) timeCurrent.textContent = renderers.formatTime(d.currentTime ?? 0);
                if (timeDuration) timeDuration.textContent = renderers.formatTime(d.duration ?? 0);
                if (container) {
                    container.setAttribute('aria-valuenow', String(Math.round(pct)));
                    container.setAttribute(
                        'aria-valuetext',
                        `${renderers.formatTime(d.currentTime ?? 0)} / ${renderers.formatTime(d.duration ?? 0)}`
                    );
                }
            }
        });
    },

    showFullCoverView(coverUrl) {
        this.coverOverlay?.show(coverUrl);
    },

    hideFullCoverView() {
        this.coverOverlay?.hide();
    },

    bindFullCoverOverlay() {
        this.coverOverlay?.bind();
    },

    bindKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.target.closest('input, textarea, select')) return;
            if (e.target.closest('#desktop-np-seek-container')) return;
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
