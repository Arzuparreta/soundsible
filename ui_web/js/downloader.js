/**
 * Soundsible Downloader Manager
 * New view: YouTube Music–style search, click result to play, "+" adds to download queue, rounded icon submits.
 * Legacy: ODST Tool section in Settings (paste URLs, queue, logs).
 */
import { store } from './store.js';
import { Haptics } from './haptics.js';
import { formatTime, esc } from './renderers.js';
import { isVisible, onChange as onVisibilityChange } from './visibility.js';
import { searchService, SourceType } from './search_service.js';
import { isYtdlpPreviewStreamTrack } from './shared.js';
import { getApiBase as stationApiUrl } from './config.js';

/** Default element IDs for mobile (index.html). Desktop passes overrides so the same class works in desktop.html. */
const DEFAULT_DL_SELECTORS = {
    searchInput: 'dl-search-input',
    searchBtn: 'dl-search-btn',
    searchResults: 'dl-search-results',
    queueContainer: 'dl-queue-container',
    dlQueueFab: 'dl-queue-fab',
    dlQueueBadge: 'dl-queue-badge',
    downloadQueuePopover: 'dl-download-queue-popover',
    downloadQueueList: 'dl-download-queue-list',
    clearQueueBtn: 'dl-clear-queue-btn',
    submitDownloadBtn: 'dl-submit-download-btn',
    previewModal: 'dl-preview-modal',
    previewClose: 'dl-preview-close',
    previewIframeWrap: 'dl-preview-iframe-wrap',
    previewAddToQueue: 'dl-preview-add-to-queue',
    coverChoiceModal: 'dl-cover-choice-modal',
    queueList: 'dl-queue-list',
    logs: 'dl-logs',
    startBtn: 'dl-start-btn',
    confPath: 'dl-conf-path',
    confR2Acc: 'dl-conf-r2-acc',
    confR2Bucket: 'dl-conf-r2-bucket',
    confR2Key: 'dl-conf-r2-key',
    confR2Secret: 'dl-conf-r2-secret',
    saveConfBtn: 'dl-save-conf-btn',
    optimizeBtn: 'dl-optimize-btn',
    syncBtn: 'dl-sync-btn',
    dlQueueProgressRing: 'dl-queue-progress-ring',
    downloadsSection: 'desktop-downloads-section',
    downloadsPanel: 'desktop-downloads-panel',
    downloadsList: 'desktop-downloads-list',
    mobileDownloadsSection: 'mobile-downloads-section',
    mobileDownloadsList: 'mobile-downloads-list'
};

/** ODST search source (UI toggle). */
const ODST_SOURCE_MUSIC = 'ytmusic';
const ODST_SOURCE_YOUTUBE = 'youtube';

export class Downloader {
    static downloadQueue = [];
    static lastSearchResults = [];
    static librarySyncFallbackTimer = null;
    static librarySyncFallbackAttempts = 0;
    static lastDownloaderStatus = null;
    /** Throttle socket-driven status polls so downloader_update bursts do not starve other API calls. */
    static _refreshStatusThrottleTimer = null;
    static _refreshStatusThrottleNext = 0;
    /** Single in-flight queue/status fetch: overlapping refreshStatus() calls await the same work. */
    static _refreshStatusPromise = null;
    static suppressResultClicksUntil = 0;
    /** Guard: ignore outside-click close for this many ms after opening (avoids mobile ghost tap closing the popover). */
    static _downloadQueueOpenedAt = 0;

    /** @param {Partial<typeof DEFAULT_DL_SELECTORS>} [selectors] - Override element IDs (e.g. desktop-dl-*). Omit for mobile. */
    static init(selectors) {
        if (this.initialized) return;
        this.initialized = true;
        const sel = { ...DEFAULT_DL_SELECTORS, ...(selectors || {}) };

        this.searchInput = document.getElementById(sel.searchInput);
        this.searchBtn = document.getElementById(sel.searchBtn);
        this.searchResults = document.getElementById(sel.searchResults);
        this.queueContainer = document.getElementById(sel.queueContainer);
        this.dlQueueFab = document.getElementById(sel.dlQueueFab);
        this.dlQueueBadge = document.getElementById(sel.dlQueueBadge);
        this.dlQueueProgressRing = document.getElementById(sel.dlQueueProgressRing);
        this.downloadQueuePopover = document.getElementById(sel.downloadQueuePopover);
        this.downloadsSection = document.getElementById(sel.downloadsSection);
        this.downloadsPanel = document.getElementById(sel.downloadsPanel);
        this.downloadsList = document.getElementById(sel.downloadsList);
        this.mobileDownloadsSection = document.getElementById(sel.mobileDownloadsSection);
        this.mobileDownloadsList = document.getElementById(sel.mobileDownloadsList);
        this.downloadQueueList = document.getElementById(sel.downloadQueueList);
        this.clearQueueBtn = document.getElementById(sel.clearQueueBtn);
        this.submitDownloadBtn = document.getElementById(sel.submitDownloadBtn);
        this.previewModal = document.getElementById(sel.previewModal);
        this.previewClose = document.getElementById(sel.previewClose);
        this.previewIframeWrap = document.getElementById(sel.previewIframeWrap);
        this.previewAddToQueue = document.getElementById(sel.previewAddToQueue);
        this.coverChoiceModal = document.getElementById(sel.coverChoiceModal);
        this.coverChoiceBound = false;
        this.currentCoverChoiceTrack = null;
        this.currentPreviewItem = null;
        this.currentPreviewSource = null;

        this.queueList = document.getElementById(sel.queueList);
        this.logs = document.getElementById(sel.logs);
        this.startBtn = document.getElementById(sel.startBtn);

        this.confPath = document.getElementById(sel.confPath);
        this.confR2Acc = document.getElementById(sel.confR2Acc);
        this.confR2Bucket = document.getElementById(sel.confR2Bucket);
        this.confR2Key = document.getElementById(sel.confR2Key);
        this.confR2Secret = document.getElementById(sel.confR2Secret);
        this.saveConfBtn = document.getElementById(sel.saveConfBtn);
        this.optimizeBtn = document.getElementById(sel.optimizeBtn);
        this.syncBtn = document.getElementById(sel.syncBtn);
        this.searchSourceMusicBtn = document.getElementById(sel.searchSourceMusicBtn);
        this.searchSourceYoutubeBtn = document.getElementById(sel.searchSourceYoutubeBtn);

        if (this.queueContainer) this.queueContainer.style.transform = '';
        this.bindEvents();
        this.updateFabAndPopover();
        this.refreshStatus();
        
        // Note: Apply initial toggle state
        searchService.applyToggleUI(sel.searchSourceMusicBtn, sel.searchSourceYoutubeBtn);
        
        // ## Section: Typeahead support
        if (this.searchInput) {
            searchService.attach(this.searchInput, (val) => {
                if (val) this.runSearch(val);
            });
        }

        if (this.confPath) this.loadConfig();
        setInterval(() => {
            if (!isVisible()) return;
            this.refreshStatus();
        }, 5000);
        onVisibilityChange((visible) => {
            if (visible) this.refreshStatus();
        });
    }

    static bindEvents() {
        window.addEventListener('downloader_log', (e) => this.addLog(e.detail.data));
        window.addEventListener('downloader_update', (e) => {
            const d = e?.detail;
            if (d?.status === 'completed' || d?.status === 'failed') {
                this.refreshStatus();
                if (d?.status === 'completed') {
                    store.syncLibrary();
                }
                return;
            }
            if (d?.id && d?.status === 'downloading' && (d.progress_percent != null || d.phase)) {
                this.applyProgressEvent(d);
                this.syncFabProgressFromStatus();
                return;
            }
            this.refreshStatusThrottled();
        });

        if (this.searchBtn) this.searchBtn.addEventListener('click', () => this.handlePrimaryInput());
        if (this.searchInput) this.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handlePrimaryInput(); });
        if (this.clearQueueBtn) this.clearQueueBtn.addEventListener('click', () => {
            this.downloadQueue = [];
            this.renderDownloadQueueList();
            this.updateFabAndPopover();
            this.hideDownloadQueue();
            Haptics.tick();
        });
        if (this.submitDownloadBtn) this.submitDownloadBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.suppressResultClicksUntil = Date.now() + 700;
            this.submitDownloadQueue();
        });
        if (this.dlQueueFab) this.dlQueueFab.addEventListener('click', () => this.toggleDownloadQueue());
        if (this.previewClose) this.previewClose.addEventListener('click', () => this.hidePreview());
        if (this.previewAddToQueue) {
            this.previewAddToQueue.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.currentPreviewItem) {
                    this.addToDownloadQueue(this.currentPreviewItem, { source: this.currentPreviewSource });
                    this.openDownloadQueue();
                }
            });
        }

        if (this.startBtn) this.startBtn.addEventListener('click', () => this.startProcessing());

        if (this.saveConfBtn) this.saveConfBtn.addEventListener('click', () => this.saveConfig());
        if (this.optimizeBtn) this.optimizeBtn.addEventListener('click', () => this.triggerOptimize());
        if (this.syncBtn) this.syncBtn.addEventListener('click', () => this.triggerSync());

        window.Downloader = this;
    }

    static setSearchSource(value) {
        // Note: Sourcemode standardized to 'ytmusic' / 'youtube'
        searchService.sourceMode = value;
        Haptics.tick();

        const q = this.searchInput?.value?.trim();
        if (q) this.runSearch(q);
    }

    static async handlePrimaryInput() {
        const raw = this.searchInput?.value?.trim() || '';
        if (!raw) return;
        const parsed = searchService.parseUrlLines(raw);
        if (parsed.mode === 'url') {
            this.enqueueDirectUrls(parsed.accepted.map((x) => x.normalized));
            this.searchInput.value = '';
            return;
        }
        await this.runSearch(raw);
    }

    static enqueueDirectUrls(urls) {
        const existing = new Set(this.downloadQueue.map((item) => item.song_str).filter(Boolean));
        let added = 0;
        const toPeek = [];
        for (const url of urls) {
            if (existing.has(url)) continue;
            existing.add(url);
            this.downloadQueue.push({
                source_type: SourceType.YOUTUBE_URL,
                song_str: url,
                video_id: null,
                title: url,
                channel: '',
                duration: 0,
                thumbnail: '',
                metadata_evidence: {},
                _peekPending: true
            });
            toPeek.push(url);
            added += 1;
        }
        this.renderDownloadQueueList();
        this.updateFabAndPopover();
        if (added > 0) {
            this.addLog(`Added ${added} URL item(s) to pending queue.`);
            Haptics.tick();
            for (const u of toPeek) {
                void this.peekUrlMetadata(u);
            }
        }
    }

    /** Resolve pasted YouTube URL to title/thumbnail via Station Engine (peek). */
    static async peekUrlMetadata(songStr) {
        const host = (store?.state?.activeHost
            || (typeof window !== 'undefined' ? window.location.hostname : '')
            || 'localhost');
        const apiBase = stationApiUrl(host);
        if (!apiBase || !songStr) return;
        try {
            const params = new URLSearchParams({ url: songStr });
            const resp = await fetch(`${apiBase}/api/downloader/youtube/peek?${params.toString()}`);
            const data = await resp.json().catch(() => ({}));
            const p = data?.peek;
            if (!p) return;
            const item = this.downloadQueue.find((q) => q.song_str === songStr);
            if (!item) return;
            item.title = p.title || item.title;
            item.channel = p.artist || p.channel || item.channel;
            item.duration = Number(p.duration) || item.duration;
            item.thumbnail = p.thumbnail || item.thumbnail;
            item.video_id = p.id || item.video_id;
            item._peekPending = false;
            if (item.metadata_evidence && typeof item.metadata_evidence === 'object') {
                item.metadata_evidence.title = p.title || item.metadata_evidence.title;
                item.metadata_evidence.artist = p.artist || p.channel || item.metadata_evidence.artist;
                item.metadata_evidence.duration_sec = item.duration;
            }
            this.renderDownloadQueueList();
        } catch (err) {
            const item = this.downloadQueue.find((q) => q.song_str === songStr);
            if (item) item._peekPending = false;
        }
    }

    static averageProgressPercent(queue) {
        const active = (queue || []).filter((i) => i.status === 'downloading');
        if (active.length === 0) return null;
        let sum = 0;
        let n = 0;
        for (const i of active) {
            const p = i.progress_percent;
            if (p != null && !Number.isNaN(Number(p))) {
                sum += Number(p);
                n += 1;
            }
        }
        if (n === 0) return null;
        return sum / n;
    }

    /**
     * HTML for one engine-queue row (sidebar, mobile, FAB popover). Uses data-dl-id for live progress patches.
     * @param {object} item - Queue item from /api/downloader/queue/status
     */
    static buildActiveDownloadRowHtml(item) {
        const id = item.id;
        const title = item.display_title || item.title || item.song_str || 'Track';
        const artist = item.display_artist || item.channel || '';
        const thumbRaw = (item.thumbnail_url || '').trim();
        const thumbEsc = thumbRaw.replace(/"/g, '%22').replace(/'/g, '%27');
        const status = item.status || 'pending';
        const phase = item.phase || '';
        let pct = null;
        if (status === 'failed') pct = 0;
        else if (status === 'pending') pct = 0;
        else if (status === 'downloading') {
            if (item.progress_percent != null && !Number.isNaN(Number(item.progress_percent))) {
                pct = Number(item.progress_percent);
            }
        }
        const preparing = status === 'downloading' && pct == null && (phase === 'preparing' || !item.progress_percent);
        const barWidth = pct != null ? Math.min(100, Math.max(0, pct)) : 0;
        const barInner = preparing
            ? `<div class="dl-bar-indeterminate h-full w-[40%] rounded-full bg-[var(--accent)]" style="animation: dl-progress-indeterminate 1.2s ease-in-out infinite;"></div>`
            : `<div class="dl-bar-inner h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-out" style="width: ${barWidth}%"></div>`;
        const pctLabel = pct != null ? `${Math.round(pct)}%` : (preparing ? '…' : status === 'pending' ? '0%' : '');
        const phaseLabel = phase === 'preparing' ? 'Preparing'
            : phase === 'processing' ? 'Processing'
                : phase === 'downloading' || status === 'downloading' ? 'Downloading'
                    : status === 'pending' ? 'Pending' : status;
        const speed = item.speed || '';
        const eta = item.eta || '';
        const speedEta = [speed, eta].filter(Boolean).join(' · ');
        return `
            <div class="dl-active-row desktop-download-item flex flex-col gap-1.5 py-2.5 px-2 rounded-[var(--radius-omni-xs)] hover:bg-[var(--surface-overlay)] min-w-0" data-dl-id="${esc(id)}">
                <div class="flex gap-2.5 items-start min-w-0">
                    <div class="w-8 h-8 rounded-[10px] flex-shrink-0 bg-cover bg-center dl-active-cover" style="background-image:url('${thumbEsc}'); background-color: var(--input-bg);"></div>
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-semibold truncate text-[var(--text-main)] dl-active-title">${esc(title)}</div>
                        <div class="text-[10px] text-[var(--text-dim)] truncate dl-active-subtitle">${esc(artist)}</div>
                    </div>
                    <div class="text-[10px] font-mono text-[var(--text-dim)] flex-shrink-0 dl-pct-text">${esc(pctLabel)}</div>
                </div>
                <div class="h-1.5 rounded-full overflow-hidden bg-[var(--input-bg)] relative dl-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct != null ? Math.round(pct) : ''}">
                    ${barInner}
                </div>
                <div class="flex justify-between items-center gap-2 text-[9px] text-[var(--text-dim)] min-w-0">
                    <span class="dl-phase-label uppercase tracking-wider font-bold truncate">${esc(phaseLabel)}</span>
                    <span class="dl-speed-eta truncate text-right font-mono">${esc(speedEta)}</span>
                </div>
            </div>`;
    }

    static renderActiveDownloadsLists(queue) {
        const q = queue || [];
        const html = [...q].reverse().map((item) => this.buildActiveDownloadRowHtml(item)).join('');
        if (this.downloadsList) {
            this.downloadsList.innerHTML = html || '<div class="text-center text-[var(--text-dim)] py-4 italic text-xs">No active downloads</div>';
        }
        if (this.mobileDownloadsList) {
            this.mobileDownloadsList.innerHTML = html || '<div class="text-center text-[var(--text-dim)] py-3 italic text-xs">No active downloads</div>';
        }
    }

    /** Patch live progress from socket without full re-render. */
    static applyProgressEvent(detail) {
        const id = detail?.id;
        if (!id) return;
        let row = null;
        document.querySelectorAll('[data-dl-id]').forEach((el) => {
            if (el.getAttribute('data-dl-id') === id) row = el;
        });
        if (!row) return;
        const pctEl = row.querySelector('.dl-pct-text');
        const barInner = row.querySelector('.dl-bar-inner');
        const indet = row.querySelector('.dl-bar-indeterminate');
        const phaseEl = row.querySelector('.dl-phase-label');
        const metaEl = row.querySelector('.dl-speed-eta');
        const track = row.querySelector('.dl-bar-track');
        const p = detail.progress_percent;
        if (pctEl && p != null && !Number.isNaN(Number(p))) {
            pctEl.textContent = `${Math.round(Number(p))}%`;
        }
        if (indet && p != null && barInner == null) {
            indet.remove();
            const nu = document.createElement('div');
            nu.className = 'dl-bar-inner h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-out';
            nu.style.width = `${Math.min(100, Math.max(0, Number(p)))}%`;
            const tr = row.querySelector('.dl-bar-track');
            if (tr) tr.appendChild(nu);
        } else if (barInner && p != null) {
            barInner.style.width = `${Math.min(100, Math.max(0, Number(p)))}%`;
        }
        if (phaseEl && detail.phase) {
            const ph = detail.phase;
            phaseEl.textContent = ph === 'preparing' ? 'PREPARING' : ph === 'processing' ? 'PROCESSING' : ph === 'downloading' ? 'DOWNLOADING' : String(ph).toUpperCase();
        }
        if (metaEl) {
            const speed = detail.speed || '';
            const eta = detail.eta || '';
            metaEl.textContent = [speed, eta].filter(Boolean).join(' · ');
        }
        if (track && p != null && !Number.isNaN(Number(p))) {
            track.setAttribute('aria-valuenow', String(Math.round(Number(p))));
        }
    }

    static syncFabProgressFromStatus() {
        const st = this.lastDownloaderStatus;
        if (!st) return;
        const q = st.queue || [];
        const avg = this.averageProgressPercent(q);
        const backendCount = q.filter((i) => i.status === 'pending' || i.status === 'downloading').length;
        const n = this.downloadQueue.length;
        this.updateFabProgress({
            isProcessing: !!st.is_processing,
            activeCount: backendCount,
            avgPercent: avg,
            localQueueCount: n
        });
    }

    static async runSearch(queryText = null) {
        const q = (queryText || this.searchInput?.value || '').trim();
        if (!q || !this.searchResults) return;
        this.searchResults.innerHTML = '<div class="text-center py-8 text-gray-500">Searching...</div>';
        this.searchBtn?.classList.add('opacity-70');
        
        try {
            const results = await searchService.query(q, { debounce: 0 });
            this.searchBtn?.classList.remove('opacity-70');
            
            if (results === null) return; // Note: Aborted
            
            if (results.length === 0) {
                this.searchResults.innerHTML = '<div class="text-center py-8 text-gray-500">No results</div>';
                return;
            }
            this.lastSearchResults = results;
            this.searchResults.innerHTML = results.map(r => this.renderResultRow(r)).join('');
            this.bindResultRowListeners();
            Haptics.tick();
        } catch (err) {
            this.searchBtn?.classList.remove('opacity-70');
            const errMsg = err.message || 'Could not reach Station Engine.';
            this.searchResults.innerHTML = `<div class="text-center py-8 text-red-400">${esc(errMsg)}</div>`;
        }
    }

    static renderResultRow(r) {
        const thumbUrl = (r.thumbnail || '').replace(/"/g, '%22').replace(/'/g, '%27');
        const duration = formatTime(r.duration);
        return `<div class="flex items-center gap-3 p-3 rounded-xl border border-[var(--input-border)] transition-colors group cursor-pointer hover:bg-[var(--surface-overlay)]" style="background-color: var(--input-bg);" data-video-id="${esc(r.id)}">
            <div class="w-12 h-12 rounded-lg flex-shrink-0 dl-result-thumb" style="background-image:url('${thumbUrl}'); background-size:cover; background-position:center; background-color: var(--input-bg);"></div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold truncate text-[var(--text-main)]">${esc(r.title)}</div>
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-add-one w-10 h-10 rounded-full bg-[var(--surface-overlay)] hover:bg-[var(--accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" data-video-id="${esc(r.id)}" aria-label="Add to download queue"><i class="fas fa-cloud-download-alt text-sm"></i></button>
        </div>`;
    }

    static bindResultRowListeners() {
        if (!this.searchResults) return;
        this.searchResults.querySelectorAll('[data-video-id]').forEach(row => {
            const videoId = row.getAttribute('data-video-id');
            if (!videoId) return;
            const result = this.lastSearchResults.find(r => r.id === videoId) || null;
            row.addEventListener('click', (e) => {
                if (Date.now() < this.suppressResultClicksUntil) return;
                if (e.target.closest('.dl-add-one')) return;
                this.playPreview(videoId);
            });
            const addBtn = row.querySelector('.dl-add-one');
            if (addBtn && result) addBtn.addEventListener('click', (e) => { e.stopPropagation(); this.addToDownloadQueue(result); this.openDownloadQueue(); });
        });
    }

    static playPreview(videoId, context) {
        if (!this.previewModal || !this.previewIframeWrap) return;
        if (context && typeof context === 'object') {
            this.currentPreviewItem = context.item ?? null;
            this.currentPreviewSource = context.source ?? null;
        } else {
            this.currentPreviewItem = null;
            this.currentPreviewSource = null;
        }
        if (this.previewAddToQueue) {
            this.previewAddToQueue.classList.toggle('hidden', !this.currentPreviewItem);
        }
        const url = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1`;
        this.previewIframeWrap.innerHTML = `<iframe width="100%" height="100%" src="${esc(url)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen class="w-full h-full min-h-[200px]"></iframe>`;
        this.previewModal.classList.remove('hidden');
        this.previewModal.classList.add('flex');
    }

    static hidePreview() {
        if (!this.previewModal || !this.previewIframeWrap) return;
        this.previewIframeWrap.innerHTML = '';
        this.previewModal.classList.add('hidden');
        this.previewModal.classList.remove('flex');
        this.currentPreviewItem = null;
        this.currentPreviewSource = null;
    }

    /** Opens the download queue popover without toggling (so it stays open when adding from preview). */
    static openDownloadQueue() {
        const popover = this.downloadQueuePopover;
        if (!popover || !popover.classList.contains('hidden')) return;
        this._downloadQueueOpenedAt = Date.now();
        popover.classList.remove('hidden');
        setTimeout(() => {
            popover.classList.remove('pointer-events-none');
            popover.style.pointerEvents = 'auto';
            popover.classList.replace('scale-95', 'scale-100');
            popover.classList.replace('opacity-0', 'opacity-100');
        }, 10);
        this.renderDownloadQueueList();
    }

    static showCoverChoiceModal(track) {
        const modal = document.getElementById('dl-cover-choice-modal');
        if (!modal || !track) return;
        
        // Note: Store current track for handlers
        this.currentCoverChoiceTrack = track;
        
        // Note: Update modal content
        document.getElementById('dl-cover-choice-title').textContent = track.title || 'Unknown Title';
        document.getElementById('dl-cover-choice-artist').textContent = track.artist || 'Unknown Artist';
        
        // ## Section: Show modal
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        // Note: Bind handlers if not already bound
        if (!this.coverChoiceBound) {
            document.getElementById('dl-cover-choice-close').onclick = () => this.hideCoverChoiceModal();
            document.getElementById('dl-cover-choice-yt').onclick = () => this.handleCoverChoice('youtube');
            document.getElementById('dl-cover-choice-library').onclick = () => this.handleCoverChoice('library');
            document.getElementById('dl-cover-choice-upload').onclick = () => this.handleCoverChoice('upload');
            document.getElementById('dl-cover-choice-none').onclick = () => this.handleCoverChoice('none');
            this.coverChoiceBound = true;
        }
    }

    static hideCoverChoiceModal() {
        const modal = document.getElementById('dl-cover-choice-modal');
        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
        this.currentCoverChoiceTrack = null;
    }

    static async handleCoverChoice(choice) {
        const track = this.currentCoverChoiceTrack;
        if (!track) return;
        
        this.hideCoverChoiceModal();
        
        try {
            if (choice === 'youtube') {
                // ## Section: Use youtube cover
                const coverUrl = track.fallback_cover_url || track.album_art_url;
                if (coverUrl) {
                    const res = await fetch(`${searchService.getApiBase()}/api/library/tracks/${track.id}/metadata`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cover_url: coverUrl })
                    });
                    if (res.ok) {
                        await store.syncLibrary();
                        this.addLog(`✓ Applied YouTube cover for ${track.title}`);
                    }
                }
            } else if (choice === 'library') {
                // Note: Show library cover picker - for now, just show a message
                // Note: TODO implement library cover picker UI
                alert('Library cover picker coming soon. For now, use Edit Metadata → Upload Cover.');
            } else if (choice === 'upload') {
                // Note: Open metadata editor with upload focus
                if (window.UI && window.UI.showMetadataEditor) {
                    window.UI.showMetadataEditor(track.id);
                    // Note: Focus upload button after a delay
                    setTimeout(() => {
                        const uploadBtn = document.getElementById('edit-upload-btn');
                        if (uploadBtn) uploadBtn.click();
                    }, 300);
                }
            } else if (choice === 'none') {
                // ## Section: Clear cover
                const res = await fetch(`${searchService.getApiBase()}/api/library/tracks/${track.id}/cover/none`, {
                    method: 'POST'
                });
                if (res.ok) {
                    await store.syncLibrary();
                    this.addLog(`✓ Removed cover for ${track.title}`);
                }
            }
        } catch (err) {
            console.error('Cover choice error:', err);
            this.addLog(`✗ Failed to apply cover choice: ${err.message}`);
        }
    }

    /** Queue the current Discover preview stream for ODST download (same path as search “+”). */
    static addPreviewStreamToDownloadQueue(track) {
        if (!isYtdlpPreviewStreamTrack(track)) return;
        const id = track.id;
        const canonicalUrl = searchService.normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
        if (!canonicalUrl) return;
        const result = {
            id,
            title: track.title || 'Unknown',
            channel: track.artist || '',
            artist: track.artist || '',
            duration: Number(track.duration) || 0,
            thumbnail: track.thumbnail || '',
            webpage_url: canonicalUrl
        };
        this.addToDownloadQueue(result, { source: searchService.sourceMode });
        if (typeof window.showToast === 'function') window.showToast('Added to download queue');
    }

    static addToDownloadQueue(result, options = {}) {
        if (!result || !result.id) return;
        const idEnc = encodeURIComponent(result.id);
        let canonicalUrl = searchService.normalizeYouTubeUrl(result.webpage_url || '');
        if (!canonicalUrl) {
            canonicalUrl = searchService.normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${idEnc}`);
        }
        if (!canonicalUrl) return;

        // Note: Distinguish between YT music and normal YT results for backend provider routing
        const sourceMode = options.source || searchService.sourceMode;
        const sourceType = (sourceMode === 'ytmusic') ? SourceType.YTMUSIC_SEARCH : SourceType.YOUTUBE_SEARCH;

        this.downloadQueue.push({

            source_type: sourceType,
            song_str: canonicalUrl,
            video_id: result.id,
            title: result.title || canonicalUrl,
            channel: result.channel || '',
            duration: result.duration || 0,
            thumbnail: result.thumbnail || '',
            metadata_evidence: {
                title: result.title || '',
                artist: result.artist ?? result.channel ?? '',
                duration_sec: result.duration || 0,
                // Note: Source hint for backend provider (search_youtube behavior)
                source_mode: (options.source === ODST_SOURCE_YOUTUBE || options.source === ODST_SOURCE_MUSIC) 
                    ? options.source 
                    : searchService.sourceMode
            }
        });
        this.renderDownloadQueueList();
        this.updateFabAndPopover();
        Haptics.tick();
    }

    static renderDownloadQueueList() {
        if (!this.downloadQueueList) return;
        const local = this.downloadQueue;
        const st = this.lastDownloaderStatus;
        const backendQ = st?.queue || [];
        const backendActive = backendQ.some((i) => i.status === 'pending' || i.status === 'downloading');
        const showBackend = local.length === 0 && backendActive;

        if (local.length === 0 && !showBackend) {
            this.downloadQueueList.innerHTML = '<div class="text-center text-gray-500 py-10 italic text-xs">No songs in queue</div>';
            return;
        }
        if (local.length > 0) {
            this.downloadQueueList.innerHTML = local.map((r, i) => {
                const sub = r._peekPending
                    ? 'Resolving…'
                    : (r.channel || r.source_type || 'YouTube');
                return `
            <div class="queue-item flex items-center p-2 hover:bg-[var(--surface-overlay)] rounded-2xl transition-colors group">
                <div class="w-10 h-10 rounded-xl flex-shrink-0 bg-cover bg-center" style="background-image:url('${(r.thumbnail || '').replace(/"/g, '%22')}'); background-color: var(--input-bg);"></div>
                <div class="ml-3 flex-1 min-w-0 truncate">
                    <div class="font-bold text-[13px] truncate text-[var(--text-main)]">${esc(r.title || r.song_str || 'Queue item')}</div>
                    <div class="text-[10px] text-[var(--text-dim)] truncate">${esc(sub)}</div>
                </div>
                <button type="button" class="dl-remove-queue w-10 h-10 flex items-center justify-center bg-[var(--surface-overlay)] text-[var(--text-dim)] rounded-full hover:bg-red-500/10 hover:text-red-400 active:scale-90 transition-all opacity-0 group-hover:opacity-100" data-index="${i}"><i class="fas fa-times text-xs"></i></button>
            </div>`;
            }).join('');
            this.downloadQueueList.querySelectorAll('.dl-remove-queue').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const i = parseInt(btn.getAttribute('data-index'), 10);
                    this.downloadQueue.splice(i, 1);
                    this.renderDownloadQueueList();
                    this.updateFabAndPopover();
                });
            });
            return;
        }
        this.downloadQueueList.innerHTML = [...backendQ].reverse().map((item) => this.buildActiveDownloadRowHtml(item)).join('');
    }

    static updateFabAndPopover() {
        const n = this.downloadQueue.length;
        const st = this.lastDownloaderStatus;
        const q = st?.queue || [];
        const backendActive = !!(st?.is_processing
            || q.some((i) => i.status === 'pending' || i.status === 'downloading'));
        const backendCount = q.filter((i) => i.status === 'pending' || i.status === 'downloading').length;
        const showFab = n > 0 || backendActive;
        const fab = this.dlQueueFab;
        const badge = this.dlQueueBadge;
        if (fab && badge) {
            if (showFab) {
                fab.classList.replace('scale-0', 'scale-100');
                fab.classList.replace('opacity-0', 'opacity-100');
                badge.textContent = String(n > 0 ? n : Math.max(0, backendCount));
                const avg = this.averageProgressPercent(q);
                this.updateFabProgress({
                    isProcessing: !!st?.is_processing,
                    activeCount: backendCount,
                    avgPercent: avg,
                    localQueueCount: n
                });
            } else {
                fab.classList.replace('scale-100', 'scale-0');
                fab.classList.replace('opacity-100', 'opacity-0');
                badge.textContent = '0';
                this.updateFabProgress({ isProcessing: false, activeCount: 0, avgPercent: null, localQueueCount: 0 });
                this.hideDownloadQueue();
            }
        }
        if (this.queueContainer) {
            this.queueContainer.classList.toggle('hidden', !showFab);
        }
        this.renderDownloadQueueList();
    }

    /**
     * FAB ring: average percent of active downloads, or full ring when processing without parsed percent yet.
     * @param {object} opts
     */
    static updateFabProgress(opts = {}) {
        const {
            isProcessing = false,
            activeCount = 0,
            avgPercent = null,
            localQueueCount = 0
        } = opts;
        const ring = this.dlQueueProgressRing;
        const badge = this.dlQueueBadge;
        if (ring) {
            const radius = (ring.r && ring.r.baseVal && ring.r.baseVal.value) || 22;
            const circumference = 2 * Math.PI * radius;
            ring.style.strokeDasharray = String(circumference);
            let offset = circumference;
            let show = false;
            if (localQueueCount > 0) {
                offset = circumference;
                show = false;
            } else if (avgPercent != null && !Number.isNaN(Number(avgPercent))) {
                const p = Math.min(100, Math.max(0, Number(avgPercent)));
                offset = circumference * (1 - p / 100);
                show = true;
            } else if (isProcessing && activeCount > 0) {
                offset = 0;
                show = true;
            }
            ring.style.strokeDashoffset = String(offset);
            ring.style.opacity = show ? '1' : '0';
        }
        if (badge && isProcessing && activeCount > 0 && localQueueCount === 0) {
            badge.textContent = String(Math.max(0, activeCount));
        }
    }

    static toggleDownloadQueue() {
        const popover = this.downloadQueuePopover;
        if (!popover) return;
        if (popover.classList.contains('hidden')) {
            this._downloadQueueOpenedAt = Date.now();
            popover.classList.remove('hidden');
            setTimeout(() => {
                popover.classList.remove('pointer-events-none');
                popover.style.pointerEvents = 'auto';
                popover.classList.replace('scale-95', 'scale-100');
                popover.classList.replace('opacity-0', 'opacity-100');
            }, 10);
            this.renderDownloadQueueList();
        } else {
            this.hideDownloadQueue();
        }
    }

    static hideDownloadQueue() {
        if (Date.now() - this._downloadQueueOpenedAt < 300) return;
        const popover = this.downloadQueuePopover;
        if (!popover || popover.classList.contains('hidden')) return;
        popover.classList.replace('scale-100', 'scale-95');
        popover.classList.replace('opacity-100', 'opacity-0');
        popover.classList.add('pointer-events-none');
        popover.style.pointerEvents = 'none';
        setTimeout(() => popover.classList.add('hidden'), 300);
    }

    static async submitDownloadQueue() {
        if (this.downloadQueue.length === 0) {
            this.addLog('Queue is empty. Add songs first.');
            return;
        }
        const items = this.downloadQueue.map((r) => ({
            source_type: r.source_type || SourceType.YOUTUBE_URL,
            song_str: r.song_str,
            video_id: r.video_id,
            output_dir: r.output_dir,
            display_title: r.title,
            display_artist: r.channel,
            thumbnail_url: r.thumbnail,
            duration_sec: r.duration,
            metadata_evidence: r.metadata_evidence || null
        })).filter((item) => !!item.song_str);
        if (items.length === 0) {
            this.addLog('No valid items to send (missing URL).');
            return;
        }
        const apiBase = searchService.getApiBase();
        try {
            const resp = await fetch(`${apiBase}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items })
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) {
                const reason = body.rejected?.[0]?.reason || body.message || 'Failed';
                throw new Error(reason);
            }
            this.downloadQueue = [];
            this.renderDownloadQueueList();
            this.updateFabAndPopover();
            await fetch(`${apiBase}/api/downloader/start`, { method: 'POST' });
            this.startLibrarySyncFallback();
            this.refreshStatus();
            this.addLog(`Queued ${items.length} item(s).`);
            Haptics.tick();
        } catch (err) {
            this.addLog(`Submit failed: ${err.message}`);
            if (typeof window.showToast === 'function') window.showToast(`Download queue: ${err.message}`);
            Haptics.error();
        }
    }

    static addToQueue() {
        this.handlePrimaryInput();
    }

    static async startProcessing() {
        try {
            await fetch(`${searchService.getApiBase()}/api/downloader/start`, { method: 'POST' });
            this.refreshStatus();
        } catch (err) {
            console.error("Start failed:", err);
        }
    }

    /**
     * Coalesce rapid downloader_update events (e.g. per-item progress) to ~1.2s minimum gap.
     * Immediate path still used by interval, visibility, and explicit submits via refreshStatus().
     */
    static refreshStatusThrottled() {
        const minGapMs = 2500;
        const now = Date.now();
        const run = () => {
            this._refreshStatusThrottleTimer = null;
            this._refreshStatusThrottleNext = Date.now() + minGapMs;
            this.refreshStatus();
        };
        if (now >= this._refreshStatusThrottleNext) {
            if (this._refreshStatusThrottleTimer) {
                clearTimeout(this._refreshStatusThrottleTimer);
                this._refreshStatusThrottleTimer = null;
            }
            run();
            return;
        }
        if (this._refreshStatusThrottleTimer) return;
        this._refreshStatusThrottleTimer = setTimeout(run, this._refreshStatusThrottleNext - now);
    }

    static async refreshStatus() {
        if (this._refreshStatusPromise) return this._refreshStatusPromise;
        this._refreshStatusPromise = (async () => {
            const apiBase = searchService.getApiBase();
            if (!apiBase) return;
            try {
                const resp = await fetch(`${apiBase}/api/downloader/queue/status`);
                const data = await resp.json();
                this.lastDownloaderStatus = data;
                this.renderQueue(data.queue, data.is_processing);
                this.renderLogs(data.logs);
                this.updateFabAndPopover();
                this.renderDesktopDownloadsPanel(data.queue, data.is_processing);
                if (!data.is_processing && this.librarySyncFallbackTimer) {
                    store.syncLibrary();
                    this.stopLibrarySyncFallback();
                }
            } catch (err) {
                console.error("Status refresh failed:", err);
            } finally {
                this._refreshStatusPromise = null;
            }
        })();
        return this._refreshStatusPromise;
    }

    static startLibrarySyncFallback() {
        this.stopLibrarySyncFallback();
        this.librarySyncFallbackAttempts = 0;
        this.librarySyncFallbackTimer = setInterval(() => {
            if (!isVisible()) return;
            this.librarySyncFallbackAttempts += 1;
            store.syncLibrary();
            const status = this.lastDownloaderStatus;
            const isIdle = status && !status.is_processing;
            if (isIdle || this.librarySyncFallbackAttempts >= 25) {
                this.stopLibrarySyncFallback();
            }
        }, 2000);
    }

    static stopLibrarySyncFallback() {
        if (this.librarySyncFallbackTimer) {
            clearInterval(this.librarySyncFallbackTimer);
            this.librarySyncFallbackTimer = null;
        }
    }

    static renderLogs(logs) {
        if (!logs || logs.length === 0) return;
        const html = [...logs].reverse().map(log => `<div>${esc(log)}</div>`).join('');
        if (this.logs) this.logs.innerHTML = html;
    }

    static async removeItem(id) {
        try {
            await fetch(`${searchService.getApiBase()}/api/downloader/queue/${id}`, { method: 'DELETE' });
            this.refreshStatus();
        } catch (err) {
            console.error("Remove failed:", err);
        }
    }

    static async clearQueue() {
        if (!confirm("Clear all items from the queue?")) return;
        try {
            await fetch(`${searchService.getApiBase()}/api/downloader/queue`, { method: 'DELETE' });
            this.refreshStatus();
        } catch (err) {
            console.error("Clear failed:", err);
        }
    }

    static renderQueue(queue, isProcessing) {
        const emptyHtml = '<div class="text-center text-gray-500 mt-10 italic text-sm">Queue is empty</div>';
        if (!queue || queue.length === 0) {
            if (this.queueList) this.queueList.innerHTML = emptyHtml;
            return;
        }

        const startLabel = isProcessing ? "Processing..." : "Start Processing";
        const startClass = isProcessing ? "text-[10px] bg-blue-600 px-3 py-1 rounded-full text-white animate-pulse" : "text-[10px] bg-green-600 hover:bg-green-700 px-3 py-1 rounded-full text-white";
        if (this.startBtn) { this.startBtn.textContent = startLabel; this.startBtn.className = startClass; }

        const sortedQueue = [...queue].reverse();
        const html = sortedQueue.map(item => `
            <div class="bg-gray-900/50 p-3 rounded-xl border border-gray-700/50 flex items-center justify-between group">
                <div class="truncate flex-1 mr-4">
                    <div class="text-xs font-bold truncate">${esc(item.display_title || item.song_str) || 'Track'}</div>
                    <div class="text-[9px] text-gray-500 mt-0.5">${item.display_artist ? esc(item.display_artist) + ' · ' : ''}${new Date(item.added_at).toLocaleString()}</div>
                </div>
                <div class="flex items-center space-x-2">
                    ${this.getStatusBadge(item.status)}
                    <button onclick="Downloader.removeItem('${item.id}')" class="p-2 text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100">
                        <i class="fas fa-trash text-[10px]"></i>
                    </button>
                </div>
            </div>
        `).join('');

        if (this.queueList) this.queueList.innerHTML = html;
    }

    static renderDesktopDownloadsPanel(queue, isProcessing) {
        const section = this.downloadsSection;
        const mobileSec = this.mobileDownloadsSection;
        const list = this.downloadsList;
        const hasItems = queue?.length > 0 || isProcessing;
        if (section) section.classList.toggle('hidden', !hasItems);
        if (mobileSec) mobileSec.classList.toggle('hidden', !hasItems);
        if (!hasItems) return;
        if (!list && !this.mobileDownloadsList) return;
        if (!queue || queue.length === 0) {
            const empty = '<div class="text-center text-[var(--text-dim)] py-4 italic text-xs">No active downloads</div>';
            const emptyM = '<div class="text-center text-[var(--text-dim)] py-3 italic text-xs">No active downloads</div>';
            if (list) list.innerHTML = empty;
            if (this.mobileDownloadsList) this.mobileDownloadsList.innerHTML = emptyM;
            return;
        }
        this.renderActiveDownloadsLists(queue);
    }

    static getStatusBadge(status) {
        const colors = {
            'pending': 'bg-gray-700 text-gray-400',
            'downloading': 'bg-blue-900/40 text-blue-400 animate-pulse',
            'completed': 'bg-green-900/40 text-green-400',
            'failed': 'bg-red-900/40 text-red-400'
        };
        return `<span class="text-[8px] uppercase font-black px-2 py-0.5 rounded-full ${colors[status] || 'bg-gray-700'}">${status}</span>`;
    }

    static addLog(msg) {
        const text = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (this.logs) {
            const div = document.createElement('div');
            div.textContent = text;
            this.logs.prepend(div);
            if (this.logs.children.length > 100) this.logs.lastChild.remove();
        }
    }

    static async loadConfig() {
        const apiBase = searchService.getApiBase();
        if (!apiBase) return;
        try {
            const resp = await fetch(`${apiBase}/api/downloader/config`);
            const data = await resp.json();
            if (this.confPath) this.confPath.value = data.output_dir || '';
            if (this.confR2Acc) this.confR2Acc.value = data.r2_account_id || '';
            if (this.confR2Bucket) this.confR2Bucket.value = data.r2_bucket || '';
            if (this.confR2Key) this.confR2Key.value = data.r2_access_key || '';
            if (this.confR2Secret) this.confR2Secret.value = data.r2_secret_key || '';
        } catch (err) {
            console.error("Config load failed:", err);
        }
    }

    static async saveConfig() {
        const data = {};
        if (this.confPath) data.output_dir = this.confPath.value.trim();
        if (this.confR2Acc) data.r2_account_id = this.confR2Acc.value;
        if (this.confR2Bucket) data.r2_bucket = this.confR2Bucket.value;
        if (this.confR2Key) data.r2_access_key = this.confR2Key.value;
        if (this.confR2Secret) data.r2_secret_key = this.confR2Secret.value;

        try {
            const apiBase = searchService.getApiBase();
            const resp = await fetch(`${apiBase}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (resp.ok) {
                this.addLog("Settings updated on Station Engine.");
                this.loadConfig(); // Note: Refresh to see masks
            } else {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                this.addLog("Save failed: " + (err.error || resp.status));
            }
        } catch (err) {
            console.error("Config save failed:", err);
            this.addLog("Save failed: " + (err.message || "network error"));
        }
    }

    static async triggerOptimize() {
        const dryRun = confirm("Run Optimization in DRY RUN mode first? (Cancel for LIVE mode)");
        try {
            await fetch(`${searchService.getApiBase()}/api/downloader/optimize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dry_run: dryRun })
            });
            this.addLog(`Optimization started (${dryRun ? 'Dry Run' : 'LIVE'})...`);
        } catch (err) {
            console.error("Optimize failed:", err);
        }
    }

    static async triggerSync() {
        if (!confirm("Start syncing library to Cloud Storage?")) return;
        try {
            await fetch(`${searchService.getApiBase()}/api/downloader/sync`, { method: 'POST' });
            this.addLog("Cloud Sync started...");
        } catch (err) {
            console.error("Sync failed:", err);
        }
    }
}
