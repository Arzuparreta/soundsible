/**
 * Discover: recommendations UI (mobile + desktop).
 * Buffer of 3 resolved items; API returns already-resolved items. Skip / Play / Add. Refill when <=2 remaining.
 */
import { store } from './store.js';
import { Resolver } from './resolver.js';
import { esc } from './renderers.js';

const INITIAL_BUFFER_LIMIT = 3;
const REFILL_LIMIT = 1;

/** Safe API base: prefer store.apiBase when activeHost is set, else same-origin (e.g. app and API on same host:port). */
function getApiBase() {
    if (typeof store !== 'undefined' && store.apiBase && store.state && store.state.activeHost) return store.apiBase;
    return window.location.origin || '';
}

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

/** Prefer HTTPS for image URLs so they load on HTTPS pages (e.g. Last.fm often returns http). */
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
    _refillInFlight: false,

    init(options = {}) {
        this._mobile = options.mobile !== false;
        const prefix = this._mobile ? '' : 'desktop-';
        this._emptyLibraryEl = document.getElementById(prefix + 'discover-empty-library');
        this._configWrap = document.getElementById(prefix + 'discover-config-wrap');
        this._mainEl = document.getElementById(prefix + 'discover-main');
        this._noResultsEl = document.getElementById(prefix + 'discover-no-results');
        this._sectionsEl = document.getElementById(prefix + 'discover-sections');
        this._refreshBtn = document.getElementById(prefix + 'discover-refresh-btn');
        this._contentPanel = document.getElementById(prefix + 'discover-content-panel');
        this._pageEl = document.getElementById(this._mobile ? 'view-discover' : 'desktop-view-discover');
        this._scrollEl = this._mobile ? this._pageEl : this._contentPanel;
        this._bindLastfmConfig();
        this._updateConfigVisibility();
        this._syncVisibility();
        this._bindRefresh();
        const inputId = this._mobile ? 'global-search-input' : 'desktop-global-search-input';
        const input = document.getElementById(inputId);
        const searchResultsPanel = document.getElementById(prefix + 'discover-search-results');
        if (this._contentPanel && searchResultsPanel && (!input || !(input.value || '').trim())) {
            this._contentPanel.classList.remove('hidden');
            searchResultsPanel.classList.add('hidden');
        }
        this._bindPullToRefresh();
        if (this._hasLibrary()) this._fetchRecommendations();
    },

    _bindPullToRefresh() {
        const pageEl = this._pageEl;
        const scrollEl = this._scrollEl;
        if (!pageEl || !scrollEl) return;
        let startY = 0;
        let pulled = false;
        pageEl.addEventListener('touchstart', (e) => {
            if (scrollEl.scrollTop <= 0) startY = e.touches[0].clientY;
            else startY = -1;
            pulled = false;
        }, { passive: true });
        pageEl.addEventListener('touchmove', (e) => {
            if (startY < 0) return;
            const y = e.touches[0].clientY;
            if (y - startY > 60) pulled = true;
        }, { passive: true });
        pageEl.addEventListener('touchend', () => {
            if (pulled && scrollEl.scrollTop <= 0) this.refresh();
            startY = -1;
        }, { passive: true });
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
        this._sectionsEl.innerHTML = `
            <div class="discover-tinder-wrap" aria-busy="true">
                <div class="discover-tinder-card-wrap">
                    <div class="discover-skeleton discover-skeleton-tinder">
                        <div class="discover-skeleton-cover"></div>
                        <div class="discover-skeleton-text">
                            <div class="discover-skeleton-line"></div>
                            <div class="discover-skeleton-line"></div>
                        </div>
                    </div>
                </div>
                <div class="discover-tinder-actions">
                    <div class="discover-tinder-btn discover-tinder-skip" aria-hidden="true"></div>
                    <div class="discover-tinder-btn discover-tinder-play" aria-hidden="true"></div>
                    <div class="discover-tinder-btn discover-tinder-add" aria-hidden="true"></div>
                </div>
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

    _renderShelfCard(r) {
        const rawCover = r.cover_url || r.thumbnail || '';
        const cover_url = ensureHttpsImageUrl(rawCover);
        const thumb = cover_url ? cover_url.replace(/"/g, '%22') : '';
        const placeholder = getDiscoverPlaceholderUrl().replace(/"/g, '%22');
        // Single quotes in url() so style="..." attribute is not broken by inner "
        const coverStyle = cover_url
            ? `background-image: url('${escapeCssUrl(cover_url)}')`
            : `background-image: url('${escapeCssUrl(placeholder)}'); background-color: var(--input-bg);`;
        const richMetaStr = escape(JSON.stringify({
            title: r.title,
            artist: r.artist,
            album: r.album,
            album_artist: r.album_artist,
            duration_sec: r.duration_sec,
            cover_url: r.cover_url,
            thumbnail: r.thumbnail, // Include thumbnail in rich metadata
            isrc: r.isrc,
            year: r.year,
            track_number: r.track_number,
            video_id: r.id
        }));

        return `
            <div class="discover-card discover-result-row relative" data-video-id="${esc(r.id)}" data-title="${esc(r.title)}" data-artist="${esc(r.artist || r.channel || '')}" data-duration="${r.duration || 0}" data-webpage-url="${esc(r.webpage_url || '')}" data-thumbnail="${esc(thumb)}" data-rich-metadata="${richMetaStr}">
                <button type="button" class="discover-card-play absolute inset-0 z-[1] flex items-center justify-center rounded-xl bg-black/0 hover:bg-black/30 active:bg-black/40 transition-colors group focus:outline-none focus:ring-2 focus:ring-[var(--accent)]" aria-label="Play preview">
                    <span class="opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition-opacity w-12 h-12 flex items-center justify-center rounded-full bg-[var(--accent)]/90 text-[var(--text-on-accent)]"><i class="fas fa-play text-lg ml-0.5"></i></span>
                </button>
                <div class="discover-card-cover ${!cover_url ? 'discover-card-cover-placeholder' : ''}" style="${coverStyle}" role="img" aria-label="${cover_url ? '' : 'No cover'}"></div>
                <div class="discover-card-meta">
                    <div class="discover-card-title">${esc(r.title)}</div>
                    <div class="discover-card-artist">${esc(r.artist || r.channel || '')}</div>
                </div>
                <button type="button" class="discover-add-btn relative z-[2] w-10 h-10 flex items-center justify-center rounded-full bg-[var(--accent)]/20 hover:bg-[var(--accent)] text-[var(--accent)] hover:text-[var(--text-on-accent)] transition-colors flex-shrink-0" aria-label="Add to download queue"><i class="fas fa-cloud-download-alt text-sm"></i></button>
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
            if (this._pendingRefill) { this._pendingRefill = false; this._refillInFlight = false; }
            this._buffer = [];
            this._bufferIndex = 0;
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        if (reason === 'providers_unavailable') {
            if (this._sectionsEl) {
                const lastfmUrl = 'https://www.last.fm/api/account/create';
                this._sectionsEl.innerHTML = `
                    <div class="text-center py-6 text-sm text-[var(--text-dim)]">
                        <p class="mb-3">Add a Last.fm API key below to get recommendations.</p>
                        <a href="${esc(lastfmUrl)}" target="_blank" rel="noopener noreferrer" class="text-[var(--accent)] font-bold underline hover:no-underline">https://www.last.fm/api/account/create</a>
                    </div>
                `;
            }
            return;
        }
        if (reason && reason !== 'no_seeds' && reason !== 'providers_unavailable') {
            if (this._pendingRefill) { this._pendingRefill = false; this._refillInFlight = false; }
            this._buffer = [];
            this._bufferIndex = 0;
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        const sections = this._sectionsFromResponse(data);
        const results = sections.flatMap(s => s.results || []);
        if (sections.every(s => !(s.results && s.results.length)) || !results.length) {
            const wasRefill = this._pendingRefill;
            if (this._pendingRefill) { this._pendingRefill = false; this._refillInFlight = false; }
            if (!wasRefill) { this._buffer = []; this._bufferIndex = 0; }
            if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
            this._renderTinderStack();
            return;
        }
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
        if (this._pendingRefill) {
            this._pendingRefill = false;
            this._refillInFlight = false;
            if (results.length > 0) this._buffer.push(results[0]);
        } else {
            this._buffer = results.slice();
            this._bufferIndex = 0;
        }
        this._renderTinderStack();
    },

    _renderTinderStack() {
        if (!this._sectionsEl) return;
        const r = this._buffer[this._bufferIndex];
        if (!r) {
            const msg = this._buffer.length === 0
                ? 'No recommendations right now. Try again later.'
                : 'No more cards. Pull to refresh or tap Refresh.';
            this._sectionsEl.innerHTML = `
                <div class="discover-tinder-wrap">
                    <div class="discover-tinder-empty">${esc(msg)}</div>
                </div>`;
            return;
        }
        const cardHtml = this._renderShelfCard(r);
        this._sectionsEl.innerHTML = `
            <div class="discover-tinder-wrap">
                <div class="discover-tinder-card-wrap">
                    ${cardHtml}
                </div>
                <div class="discover-tinder-actions">
                    <button type="button" class="discover-tinder-btn discover-tinder-skip" aria-label="Skip"><i class="fas fa-times"></i></button>
                    <button type="button" class="discover-tinder-btn discover-tinder-play" aria-label="Play"><i class="fas fa-play"></i></button>
                    <button type="button" class="discover-tinder-btn discover-tinder-add" aria-label="Add to queue"><i class="fas fa-cloud-download-alt"></i></button>
                </div>
            </div>`;
        this._bindTinderActions();
    },

    _bindTinderActions() {
        if (!this._sectionsEl) return;
        const wrap = this._sectionsEl.querySelector('.discover-tinder-wrap');
        const cardWrap = this._sectionsEl.querySelector('.discover-tinder-card-wrap');
        const row = this._sectionsEl.querySelector('.discover-result-row');
        if (!wrap || !row) return;

        const advance = () => {
            this._bufferIndex++;
            const remaining = this._buffer.length - this._bufferIndex;
            if (remaining <= 2 && !this._refillInFlight) this._refill();
            this._renderTinderStack();
        };

        const skipBtn = wrap.querySelector('.discover-tinder-skip');
        if (skipBtn) skipBtn.addEventListener('click', () => advance());

        const addBtn = wrap.querySelector('.discover-tinder-add');
        if (addBtn) addBtn.addEventListener('click', async () => {
            const item = this._itemFromRow(row);
            if (!item) return;
            const resolved = await this._resolveItemCached(item, row);
            if (resolved && resolved.webpage_url) this._addToQueue(resolved);
            advance();
        });

        const playBtn = wrap.querySelector('.discover-tinder-play');
        if (playBtn) playBtn.addEventListener('click', async () => {
            const item = this._itemFromRow(row);
            if (!item) return;
            const resolved = await this._resolveItemCached(item, row);
            if (!resolved) {
                if (typeof window.showToast === 'function') window.showToast('Could not find track');
                return;
            }
            if (!resolved.id || String(resolved.id).startsWith('raw-')) {
                if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
                return;
            }
            if (typeof window.playPreview === 'function') window.playPreview(resolved);
        });

        row.querySelector('.discover-card-play')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = this._itemFromRow(row);
            if (!item) return;
            const resolved = await this._resolveItemCached(item, row);
            if (!resolved) {
                if (typeof window.showToast === 'function') window.showToast('Could not find track');
                return;
            }
            if (!resolved.id || String(resolved.id).startsWith('raw-')) {
                if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
                return;
            }
            if (typeof window.playPreview === 'function') window.playPreview(resolved);
        });
        row.querySelector('.discover-add-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const item = this._itemFromRow(row);
            if (!item) return;
            const resolved = await this._resolveItemCached(item, row);
            if (resolved && resolved.webpage_url) this._addToQueue(resolved);
            advance();
        });

        this._bindTinderSwipe(cardWrap, row, advance, addBtn);
    },

    _bindTinderSwipe(cardWrap, row, onSkip, onAdd) {
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
                if (dx < 0) onSkip();
                else if (onAdd) onAdd.click();
            }
        }, { passive: true });
    },

    async _resolveItemRaw(item, row) {
        if (item.webpage_url && item.id && !String(item.id).startsWith('raw-')) return item;
        row.classList.add('discover-card-resolving');
        row.style.opacity = '0.7';
        const apiBase = getApiBase();
        try {
            const res = await fetch(`${apiBase}/api/discover/resolve`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ artist: item.artist, title: item.title }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 200 && data.result) {
                this._applyResolvedToRow(row, data.result);
                row.classList.remove('discover-card-resolving');
                row.style.opacity = '1';
                return { ...item, ...data.result };
            }
            if (res.status === 202 && data.job_id) {
                const jobId = data.job_id;
                const pollMs = 600;
                const maxAttempts = 80;
                for (let i = 0; i < maxAttempts; i++) {
                    await new Promise((r) => setTimeout(r, pollMs));
                    const st = await fetch(`${apiBase}/api/discover/resolve/status/${jobId}`);
                    const stData = await st.json().catch(() => ({}));
                    if (stData.status === 'completed' && stData.result) {
                        this._applyResolvedToRow(row, stData.result);
                        row.classList.remove('discover-card-resolving');
                        row.style.opacity = '1';
                        return { ...item, ...stData.result };
                    }
                    if (stData.status === 'failed') throw new Error(stData.error || 'Resolution failed');
                }
                throw new Error('Resolution timed out');
            }
            if (res.status === 404) throw new Error(data.error || 'Resolution failed');
            throw new Error(data.error || 'Resolution failed');
        } catch (err) {
            console.error('Failed to resolve recommendation:', err);
            return null;
        } finally {
            row.classList.remove('discover-card-resolving');
            row.style.opacity = '1';
        }
    },

    async _resolveItemCached(item, row) {
        if (item.webpage_url && item.id && !String(item.id).startsWith('raw-')) return item;
        return this._resolveItemRaw(item, row);
    },

    _applyResolvedToRow(row, data) {
        if (!row || !data) return;
        row.setAttribute('data-video-id', data.id);
        row.setAttribute('data-webpage-url', data.webpage_url || '');
        row.setAttribute('data-duration', data.duration || 0);
        const rawCover = data.cover_url || data.thumbnail;
        const coverUrl = ensureHttpsImageUrl(rawCover);
        if (coverUrl) {
            const coverEl = row.querySelector('.discover-card-cover');
            if (coverEl) coverEl.style.backgroundImage = `url("${escapeCssUrl(coverUrl)}")`;
            row.setAttribute('data-thumbnail', coverUrl.replace(/"/g, '%22'));
        }
    },

    _refill() {
        if (this._refillInFlight || !this._hasLibrary()) return;
        const remaining = this._buffer.length - this._bufferIndex;
        if (remaining > 2) return;
        if (this._bufferIndex > 0) {
            this._buffer = this._buffer.slice(this._bufferIndex);
            this._bufferIndex = 0;
        }
        const exclude_ids = this._buffer.map((i) => i.id).filter(Boolean);
        this._pendingRefill = true;
        this._refillInFlight = true;
        const apiBase = getApiBase();
        fetch(`${apiBase}/api/discover/recommendations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: REFILL_LIMIT, exclude_ids }),
        })
            .then((res) => res.json().catch(() => ({})))
            .then((data) => {
                this._renderResults(data, data.reason || null);
            })
            .catch(() => {
                this._pendingRefill = false;
                this._refillInFlight = false;
            });
    },

    _bindRefresh() {
        if (!this._refreshBtn) return;
        this._refreshBtn.addEventListener('click', () => this.refresh());
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
        const apiBase = getApiBase();

        const resolveItem = async (item, row) => {
            if (item.webpage_url && item.id && !String(item.id).startsWith('raw-')) return item;

            row.classList.add('discover-card-resolving');
            row.style.opacity = '0.7';
            const applyResult = (data) => {
                if (!data) return;
                row.setAttribute('data-video-id', data.id);
                row.setAttribute('data-webpage-url', data.webpage_url || '');
                row.setAttribute('data-duration', data.duration || 0);
                const rawCover = data.cover_url || data.thumbnail;
                const coverUrl = ensureHttpsImageUrl(rawCover);
                if (coverUrl) {
                    const coverEl = row.querySelector('.discover-card-cover');
                    if (coverEl) coverEl.style.backgroundImage = `url("${escapeCssUrl(coverUrl)}")`;
                    row.setAttribute('data-thumbnail', coverUrl.replace(/"/g, '%22'));
                }
            };
            try {
                const res = await fetch(`${apiBase}/api/discover/resolve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ artist: item.artist, title: item.title }),
                });
                const data = await res.json().catch(() => ({}));
                if (res.status === 200 && data.result) {
                    applyResult(data.result);
                    row.classList.remove('discover-card-resolving');
                    row.style.opacity = '1';
                    return { ...item, ...data.result };
                }
                if (res.status === 202 && data.job_id) {
                    const jobId = data.job_id;
                    const pollMs = 600;
                    const maxAttempts = 80;
                    for (let i = 0; i < maxAttempts; i++) {
                        await new Promise((r) => setTimeout(r, pollMs));
                        const st = await fetch(`${apiBase}/api/discover/resolve/status/${jobId}`);
                        const stData = await st.json().catch(() => ({}));
                        if (stData.status === 'completed' && stData.result) {
                            applyResult(stData.result);
                            row.classList.remove('discover-card-resolving');
                            row.style.opacity = '1';
                            return { ...item, ...stData.result };
                        }
                        if (stData.status === 'failed') {
                            throw new Error(stData.error || 'Resolution failed');
                        }
                    }
                    throw new Error('Resolution timed out');
                }
                if (res.status === 404) throw new Error(data.error || 'Resolution failed');
                throw new Error(data.error || 'Resolution failed');
            } catch (err) {
                console.error('Failed to resolve recommendation:', err);
                return null;
            } finally {
                row.classList.remove('discover-card-resolving');
                row.style.opacity = '1';
            }
        };

        this._resolveItem = resolveItem;
        this._resolveRow = (row) => {
            const item = this._itemFromRow(row);
            if (item && item.webpage_url && item.id) return Promise.resolve(item);
            return resolveItem(item, row);
        };

        this._sectionsEl.querySelectorAll('.discover-add-btn').forEach((btn) => {
            const row = btn.closest('.discover-result-row');
            if (!row) return;
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                let item = this._itemFromRow(row);
                if (!item) return;

                item = await resolveItem(item, row);
                if (item && item.webpage_url) this._addToQueue(item);
            });
        });

        this._sectionsEl.querySelectorAll('.discover-card-play').forEach((playBtn) => {
            const row = playBtn.closest('.discover-result-row');
            if (!row) return;
            playBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                let item = this._itemFromRow(row);
                if (!item) return;

                item = await resolveItem(item, row);
                if (!item) {
                    if (typeof window.showToast === 'function') window.showToast('Could not find track');
                    return;
                }
                if (!item.id || String(item.id).startsWith('raw-')) {
                    if (typeof window.showToast === 'function') window.showToast('Preview unavailable');
                    return;
                }
                if (typeof window.playPreview === 'function') window.playPreview(item);
            });
        });
    },

    async _updateConfigVisibility() {
        if (!this._configWrap) return;
        const apiBase = getApiBase();
        try {
            const res = await fetch(`${apiBase}/api/downloader/config`);
            const data = await res.json().catch(() => ({}));
            const key = data.lastfm_api_key || '';
            const isActivated = key && !String(key).startsWith('HIDDEN');
            this._configWrap.classList.toggle('hidden', !!isActivated);
        } catch {
            this._configWrap.classList.remove('hidden');
        }
    },

    _bindLastfmConfig() {
        const prefix = this._mobile ? '' : 'desktop-';
        const input = document.getElementById(prefix + 'discover-lastfm-input');
        const saveBtn = document.getElementById(prefix + 'discover-lastfm-save');
        const statusEl = document.getElementById(prefix + 'discover-lastfm-status');
        if (!saveBtn || !input) return;
        const apiBase = getApiBase();
        saveBtn.addEventListener('click', async () => {
            const key = (input.value || '').trim();
            if (!key) {
                if (statusEl) { statusEl.textContent = 'Enter an API key.'; statusEl.classList.remove('hidden'); }
                return;
            }
            saveBtn.disabled = true;
            if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.classList.remove('hidden'); }
            try {
                const res = await fetch(`${apiBase}/api/downloader/config`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ lastfm_api_key: key }),
                });
                if (res.ok) {
                    if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.classList.remove('hidden'); }
                    input.value = '';
                    this._updateConfigVisibility();
                } else {
                    const d = await res.json().catch(() => ({}));
                    if (statusEl) { statusEl.textContent = d.error || 'Save failed.'; statusEl.classList.remove('hidden'); }
                }
            } catch (err) {
                if (statusEl) { statusEl.textContent = 'Network error.'; statusEl.classList.remove('hidden'); }
            }
            saveBtn.disabled = false;
        });
    },

    async _fetchRecommendations(limit = INITIAL_BUFFER_LIMIT, excludeIds = []) {
        if (!this._hasLibrary()) return;
        if (this._loading) return;
        this._loading = true;
        if (this._mainEl) this._mainEl.classList.remove('hidden');
        if (this._noResultsEl) this._noResultsEl.classList.add('hidden');
        this._renderSkeleton();
        const apiBase = getApiBase();
        try {
            const res = await fetch(`${apiBase}/api/discover/recommendations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ limit, exclude_ids: excludeIds }),
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

    refresh() {
        if (!this._hasLibrary()) return;
        this._buffer = [];
        this._bufferIndex = 0;
        this._pendingRefill = false;
        this._refillInFlight = false;
        this._fetchRecommendations(INITIAL_BUFFER_LIMIT, []);
    },

    _addToQueue(item) {
        // Discover items are always queued as music (canonical metadata), never as raw YouTube.
        const opts = { source: 'music' };
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
