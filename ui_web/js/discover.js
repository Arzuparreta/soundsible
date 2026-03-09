/**
 * Discover: recommendations UI (mobile + desktop).
 * Single fill process keeps buffer full to BUFFER_CAP. No refill; navigation does not trigger loading.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';
import { esc } from './renderers.js';
import { searchService } from './search_service.js';

const BUFFER_CAP = 30;
const FILL_INTERVAL_MS = 10000;

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

function isYoutubeId(id) {
    return id && typeof id === 'string' && id.length === 11 && !String(id).startsWith('raw-');
}

/** Prefer HTTPS for image URLs so they load on HTTPS pages. */
function ensureHttpsImageUrl(url) {
    if (!url || typeof url !== 'string') return url || '';
    const t = url.trim();
    if (t.startsWith('http://')) return 'https://' + t.slice(7);
    return t;
}

/** Placeholder for discover cards when no cover: same as store or inline fallback so cover area is never empty. */
function getDiscoverPlaceholderUrl() {
    if (typeof store !== 'undefined' && store.placeholderCoverUrl) return store.placeholderCoverUrl;
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>');
}

export const Discover = {
    _mobile: true,
    _loading: false,
    _buffer: [],
    _bufferIndex: 0,
    _fillInFlight: false,
    _fillIntervalStarted: false,
    _inited: false,

    async init(options = {}) {
        this._mobile = options.mobile !== false;
        const prefix = this._mobile ? '' : 'desktop-';
        this._emptyLibraryEl = document.getElementById(prefix + 'discover-empty-library');
        this._mainEl = document.getElementById(prefix + 'discover-main');
        this._noResultsEl = document.getElementById(prefix + 'discover-no-results');
        this._sectionsEl = document.getElementById(prefix + 'discover-sections');
        this._contentPanel = document.getElementById(prefix + 'discover-content-panel');
        this._pageEl = document.getElementById(this._mobile ? 'view-discover' : 'desktop-view-discover');
        this._scrollEl = this._contentPanel;
        this._syncVisibility();
        const inputId = this._mobile ? 'global-search-input' : 'desktop-global-search-input';
        const input = document.getElementById(inputId);
        const searchResultsPanel = document.getElementById(prefix + 'discover-search-results');
        if (!this._mobile && this._contentPanel && searchResultsPanel && (!input || !(input.value || '').trim())) {
            this._contentPanel.classList.remove('hidden');
            searchResultsPanel.classList.add('hidden');
        }
        if (this._hasLibrary()) {
            if (this._mainEl) this._mainEl.classList.remove('hidden');
            this._renderTinderStack();
        }
        store.subscribe((state) => this._syncTinderPlayButton(state));
        this._inited = true;
    },

    async ensureInited(options = {}) {
        if (this._inited) {
            if (this._sectionsEl && this._buffer && this._buffer.length > 0) this._renderTinderStack();
            return;
        }
        await this.init(options);
    },

    _hasLibrary() {
        const lib = (store.state && store.state.library) || [];
        return lib.length > 0;
    },

    _syncVisibility() {
        const hasLibrary = this._hasLibrary();
        if (this._emptyLibraryEl) this._emptyLibraryEl.classList.toggle('hidden', hasLibrary);
        if (this._mainEl) this._mainEl.classList.toggle('hidden', !hasLibrary);
        if (!hasLibrary) return;
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
    },

    _renderSkeleton() {
        if (!this._sectionsEl) return;
        const cardHtml = this._renderShelfCard(null, { skeleton: true });
        this._sectionsEl.innerHTML = `
            <div class="discover-tinder-outer">
                <button type="button" class="discover-tinder-side-btn discover-tinder-prev" disabled aria-hidden="true"><i class="fas fa-chevron-left"></i></button>
                <div class="discover-tinder-wrap" aria-busy="true">
                    <div class="discover-tinder-card-wrap is-skeleton" aria-busy="true">
                        ${cardHtml}
                        <div class="discover-tinder-actions">
                            <button type="button" class="discover-tinder-btn discover-tinder-add" disabled aria-hidden="true"><i class="fas fa-cloud-download-alt"></i></button>
                            <button type="button" class="discover-tinder-btn discover-tinder-playback-queue" disabled aria-hidden="true" aria-label="Add to playback queue"><i class="fas fa-list-ul"></i></button>
                            <button type="button" class="discover-tinder-btn discover-tinder-play" disabled aria-hidden="true"><i class="fas fa-play"></i></button>
                        </div>
                    </div>
                </div>
                <button type="button" class="discover-tinder-side-btn discover-tinder-next" disabled aria-hidden="true"><i class="fas fa-chevron-right"></i></button>
            </div>
        `;
    },

    _sectionsFromResponse(data) {
        if (data.sections && Array.isArray(data.sections) && data.sections.length > 0) {
            return data.sections.map(s => ({ id: s.id || '', name: s.name || 'For you', results: s.results || [] }));
        }
        const results = data.results || [];
        return [{ id: 'for-you', name: 'For you', results }];
    },

    _renderShelfCard(r, opts = {}) {
        const skeleton = opts.skeleton === true;
        const item = skeleton ? {} : (r || {});
        const rawCover = item.cover_url || item.thumbnail || '';
        const cover_url = ensureHttpsImageUrl(rawCover);
        const thumb = cover_url ? cover_url.replace(/"/g, '%22') : '';
        const placeholder = getDiscoverPlaceholderUrl().replace(/"/g, '%22');
        // Note: Single quotes in URL() so style="..." attribute is not broken by inner "
        const coverStyle = skeleton
            ? ''
            : cover_url
                ? `background-image: url('${escapeCssUrl(cover_url)}')`
                : `background-image: url('${escapeCssUrl(placeholder)}'); background-color: var(--input-bg);`;
        const richMetaStr = skeleton ? escape('{}') : escape(JSON.stringify({
            title: r.title,
            artist: r.artist,
            album: r.album,
            album_artist: r.album_artist,
            duration_sec: r.duration_sec,
            cover_url: r.cover_url,
            thumbnail: r.thumbnail,
            isrc: r.isrc,
            year: r.year,
            track_number: r.track_number,
            video_id: r.video_id ?? r.id
        }));

        const playbackId = (item.video_id ?? item.id) || '';
        const titleText = skeleton ? '\u00A0' : esc(item.title || r?.title || '');
        const artistText = skeleton ? '\u00A0' : esc(item.artist || item.channel || r?.artist || r?.channel || '');

        return `
            <div class="discover-card discover-result-row relative" data-video-id="${esc(playbackId)}" data-title="${esc(item.title || '')}" data-artist="${esc(item.artist || item.channel || '')}" data-duration="${item.duration || r?.duration || 0}" data-webpage-url="${esc(item.webpage_url || '')}" data-thumbnail="${esc(thumb)}" data-rich-metadata="${richMetaStr}">
                <div class="discover-card-cover-wrap relative flex-shrink-0">
                    <button type="button" class="discover-card-play absolute inset-0 z-[1] flex items-center justify-center rounded-xl bg-black/0 hover:bg-black/30 active:bg-black/40 transition-colors group focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" aria-label="Play preview">
                        <span class="opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity w-12 h-12 flex items-center justify-center rounded-full bg-[var(--accent)]/90 text-[var(--text-on-accent)]"><i class="fas fa-play text-lg ml-0.5"></i></span>
                    </button>
                    <div class="discover-card-cover ${!cover_url && !skeleton ? 'discover-card-cover-placeholder' : ''}" style="${coverStyle}" role="img" aria-label="${cover_url ? '' : 'No cover'}"></div>
                </div>
                <div class="discover-card-meta">
                    <div class="discover-card-title">${titleText}</div>
                    <div class="discover-card-artist">${artistText}</div>
                </div>
            </div>
        `;
    },

    _renderSections(sections) {
        if (!this._sectionsEl) return;
        const html = sections.map(sec => `
            <section class="discover-section" data-section-id="${esc(sec.id)}">
                <h2>${esc(sec.name)}</h2>
                <div class="discover-shelf">
                    ${(sec.results || []).map(r => this._renderShelfCard(r)).join('')}
                </div>
            </section>
        `).join('');
        this._sectionsEl.innerHTML = html;
        this._bindResultButtons();
    },

    _renderResults(data, reason) {
        this._loading = false;
        this._syncVisibility();
        if (!this._hasLibrary()) return;
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
        if (reason === 'no_seeds') {
            this._buffer = [];
            this._bufferIndex = 0;
            this._noSeeds = true;
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        this._noSeeds = false;
        this._noResultsFromFetch = reason === 'no_results';
        if (reason && reason !== 'no_seeds') {
            this._buffer = [];
            this._bufferIndex = 0;
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        this._noResultsFromFetch = false;
        const sections = this._sectionsFromResponse(data);
        const results = sections.flatMap(s => s.results || []);
        if (sections.every(s => !(s.results && s.results.length)) || !results.length) {
            this._buffer = [];
            this._bufferIndex = 0;
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
        this._noResultsFromFetch = false;
        this._buffer = results.slice(0, BUFFER_CAP);
        this._bufferIndex = 0;
        this._renderTinderStack();
    },

    _renderTinderStack() {
        if (!this._sectionsEl) return;
        const r = this._buffer[this._bufferIndex];
        if (!r) {
            const msg = this._noSeeds
                ? 'Add music from YouTube to your library to get recommendations.'
                : this._noResultsFromFetch
                    ? 'Could not load recommendations. YouTube Music mix may require login—check downloader cookies in Settings.'
                    : this._buffer.length === 0
                        ? (this._fillInFlight ? 'Loading more…' : 'No recommendations right now. Try again later.')
                        : this._fillInFlight
                            ? 'Loading more…'
                            : 'No more cards.';
            this._sectionsEl.innerHTML = `
                <div class="discover-tinder-outer">
                    <div class="discover-tinder-wrap">
                        <div class="discover-tinder-empty">${esc(msg)}</div>
                    </div>
                </div>`;
            return;
        }
        const cardHtml = this._renderShelfCard(r);
        const ids = store.state.libraryYoutubeIds || [];
        const playbackId = r.video_id ?? r.id;
        const inLibrary = isYoutubeId(playbackId) && ids.includes(playbackId);
        const dlIcon = inLibrary ? 'fa-sync-alt' : 'fa-cloud-download-alt';
        const dlAria = inLibrary ? 'Re-download' : 'Add to queue';
        const tooltipAttrs = inLibrary ? ' data-hover-tooltip="Download again" data-hover-tooltip-delay="1000"' : '';
        this._sectionsEl.innerHTML = `
            <div class="discover-tinder-outer">
                <button type="button" class="discover-tinder-side-btn discover-tinder-prev" aria-label="Previous" ${this._bufferIndex === 0 ? ' disabled' : ''}><i class="fas fa-chevron-left"></i></button>
                <div class="discover-tinder-wrap">
                    <div class="discover-tinder-card-wrap">
                        ${cardHtml}
                        <div class="discover-tinder-actions">
                            <button type="button" class="discover-tinder-btn discover-tinder-add" aria-label="${esc(dlAria)}"${tooltipAttrs}><i class="fas ${dlIcon}"></i></button>
                            <button type="button" class="discover-tinder-btn discover-tinder-playback-queue" aria-label="Add to playback queue"><i class="fas fa-list-ul"></i></button>
                            <button type="button" class="discover-tinder-btn discover-tinder-play" aria-label="Play"><i class="fas fa-play"></i></button>
                        </div>
                    </div>
                </div>
                <button type="button" class="discover-tinder-side-btn discover-tinder-next" aria-label="Next"><i class="fas fa-chevron-right"></i></button>
            </div>        `;
        this._bindTinderActions();
    },

    _syncTinderPlayButton(state) {
        if (!this._sectionsEl) return;
        const btn = this._sectionsEl.querySelector('.discover-tinder-play');
        const row = this._sectionsEl.querySelector('.discover-result-row');
        if (!btn || !row) return;
        const cardId = row.getAttribute('data-video-id') || '';
        const isThisPlaying = state.currentTrack?.id === cardId && state.isPlaying;
        const icon = btn.querySelector('i');
        if (icon) icon.className = isThisPlaying ? 'fas fa-pause' : 'fas fa-play';
        btn.setAttribute('aria-label', isThisPlaying ? 'Pause' : 'Play');
    },

    _bindTinderActions() {
        if (!this._sectionsEl) return;
        const outer = this._sectionsEl.querySelector('.discover-tinder-outer');
        const wrap = this._sectionsEl.querySelector('.discover-tinder-wrap');
        const cardWrap = this._sectionsEl.querySelector('.discover-tinder-card-wrap');
        const row = this._sectionsEl.querySelector('.discover-result-row');
        if (!wrap || !row) return;

        const advance = () => {
            this._bufferIndex++;
            this._renderTinderStack();
        };

        const goPrevious = () => {
            if (this._bufferIndex > 0) {
                this._bufferIndex--;
                this._renderTinderStack();
            }
        };

        const prevBtn = outer?.querySelector('.discover-tinder-prev');
        if (prevBtn && !prevBtn.disabled) prevBtn.addEventListener('click', goPrevious);

        const nextBtn = outer?.querySelector('.discover-tinder-next');
        if (nextBtn) nextBtn.addEventListener('click', advance);

        const addBtn = wrap.querySelector('.discover-tinder-add');
        if (addBtn) addBtn.addEventListener('click', () => {
            const item = this._itemFromRow(row);
            if (item && item.webpage_url) this._addToQueue(item);
        });

        const playbackQueueBtn = wrap.querySelector('.discover-tinder-playback-queue');
        if (playbackQueueBtn) playbackQueueBtn.addEventListener('click', () => {
            const item = this._itemFromRow(row);
            if (item && (item.video_id || item.id)) {
                if (store.addPreviewToQueue) store.addPreviewToQueue(item);
            }
        });

        const playBtn = wrap.querySelector('.discover-tinder-play');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                const item = this._itemFromRow(row);
                if (!item || !item.webpage_url) return;
                const playbackId = item.video_id ?? item.id;
                if (!playbackId || String(playbackId).startsWith('raw-')) return;
                const { currentTrack, isPlaying } = store.state;
                if (currentTrack?.id === playbackId) {
                    if (isPlaying) audioEngine.pause();
                    else audioEngine.play();
                    return;
                }
                if (typeof window.playPreview === 'function') window.playPreview(item);
            });
            this._syncTinderPlayButton(store.state);
        }

        row.querySelector('.discover-card-play')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = this._itemFromRow(row);
            if (!item || !item.webpage_url) return;
            const playbackId = item.video_id ?? item.id;
            if (!playbackId || String(playbackId).startsWith('raw-')) return;
            if (typeof window.playPreview === 'function') window.playPreview(item);
        });

        this._bindTinderSwipe(cardWrap, row, advance, goPrevious);
    },

    _bindTinderSwipe(cardWrap, row, onNext, onPrevious) {
        if (!cardWrap || !row) return;
        let startX = 0;
        let startY = 0;
        cardWrap.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });
        cardWrap.addEventListener('touchend', (e) => {
            if (!e.changedTouches[0]) return;
            const dx = e.changedTouches[0].clientX - startX;
            const dy = e.changedTouches[0].clientY - startY;
            const threshold = 60;
            if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy)) {
                if (dx < 0) onPrevious?.();
                else onNext();
            }
        }, { passive: true });
    },

    _itemFromRow(row) {
        if (!row) return null;
        const id = row.getAttribute('data-video-id');
        if (!id) return null;

        let metadata_evidence = {};
        try {
            const rawMeta = row.getAttribute('data-rich-metadata');
            if (rawMeta) {
                metadata_evidence = JSON.parse(unescape(rawMeta));
            }
        } catch (e) {
            console.warn("Could not parse rich metadata", e);
        }

        return {
            id,
            video_id: id,
            title: row.getAttribute('data-title') || '',
            artist: row.getAttribute('data-artist') || '',
            duration: parseInt(row.getAttribute('data-duration') || '0', 10),
            webpage_url: row.getAttribute('data-webpage-url') || '',
            thumbnail: row.getAttribute('data-thumbnail') || '',
            channel: row.getAttribute('data-artist') || '',
            metadata_evidence: metadata_evidence,
            source_type: 'youtube_url'
        };
    },

    _bindResultButtons() {
        if (!this._sectionsEl) return;
        this._sectionsEl.querySelectorAll('.discover-add-btn').forEach((btn) => {
            const row = btn.closest('.discover-result-row');
            if (!row) return;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = this._itemFromRow(row);
                if (item && item.webpage_url) this._addToQueue(item);
            });
        });
        this._sectionsEl.querySelectorAll('.discover-card-play').forEach((playBtn) => {
            const row = playBtn.closest('.discover-result-row');
            if (!row) return;
            playBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = this._itemFromRow(row);
                if (!item || !item.webpage_url) return;
                const shelfPlaybackId = item.video_id ?? item.id;
                if (!shelfPlaybackId || String(shelfPlaybackId).startsWith('raw-')) return;
                if (typeof window.playPreview === 'function') window.playPreview(item);
            });
        });
    },

    async _fetchRecommendations(limit = BUFFER_CAP) {
        if (!this._hasLibrary()) return;
        if (this._loading) return;
        this._loading = true;
        if (this._mainEl) this._mainEl.classList.remove('hidden');
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
        this._renderSkeleton();
        const apiBase = searchService.getApiBase();
        try {
            const res = await fetch(`${apiBase}/api/discover/recommendations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit }),
            });
            const data = await res.json().catch(() => ({}));
            const reason = data.reason || null;
            this._loading = false;
            this._renderResults(data, reason);
        } catch (err) {
            this._loading = false;
            this._renderResults({ results: [] }, 'error');
            if (this._noResultsEl) {
                this._noResultsEl.textContent = 'Network error. Try again.';
                this._noResultsEl.classList.remove('hidden');
            }
        }
    },

    fillBuffer() {
        if (!this._hasLibrary()) return;
        if (!this._fillIntervalStarted) {
            this._fillIntervalStarted = true;
            setInterval(() => this.fillBuffer(), FILL_INTERVAL_MS);
        }
        if (this._fillInFlight) return;
        if (this._bufferIndex > 0) {
            this._buffer = this._buffer.slice(this._bufferIndex);
            this._bufferIndex = 0;
        }
        if (this._buffer.length >= BUFFER_CAP) return;
        this._fillInFlight = true;
        const apiBase = searchService.getApiBase();
        const limit = BUFFER_CAP - this._buffer.length;
        fetch(`${apiBase}/api/discover/recommendations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit }),
        })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                this._fillInFlight = false;
                if (!data || typeof data !== 'object') return;
                const sections = this._sectionsFromResponse(data);
                const results = sections.flatMap(s => s.results || []);
                if (results.length) {
                    this._buffer.push(...results);
                    this._buffer = this._buffer.slice(0, BUFFER_CAP);
                }
                if (this._sectionsEl) this._renderTinderStack();
                if (this._buffer.length < BUFFER_CAP && results.length) this.fillBuffer();
            })
            .catch(() => {
                this._fillInFlight = false;
            });
    },

    _addToQueue(item) {
        // Note: Discover items read the global search source mode (music vs youtube).
        const opts = { source: searchService.sourceMode };
        const dl = typeof window.Downloader !== 'undefined' ? window.Downloader : null;
        if (dl && dl.addToDownloadQueue) {
            if (dl.init && !dl.initialized) dl.init();
            dl.addToDownloadQueue(item, opts);
            return;
        }
        import('./downloader.js').then((mod) => {
            if (mod.Downloader) {
                if (mod.Downloader.init && !mod.Downloader.initialized) mod.Downloader.init();
                mod.Downloader.addToDownloadQueue(item, opts);
            }
        });
    },
};

if (typeof window !== 'undefined') window.Discover = Discover;
