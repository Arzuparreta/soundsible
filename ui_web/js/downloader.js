/**
 * Soundsible Downloader Manager
 * New view: YouTube Music–style search, click result to play, "+" adds to download queue, rounded icon submits.
 * Legacy: ODST Tool section in Settings (paste URLs, queue, logs).
 */
import { store } from './store.js';
import { Haptics } from './haptics.js';

function esc(str) {
    if (!str) return "";
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatDuration(sec) {
    if (!sec || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function normalizeYouTubeUrl(url) {
    try {
        const raw = (url || "").trim();
        if (!raw) return null;
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        const isYoutubeHost = host.includes("youtube.com") || host.includes("youtu.be");
        if (!isYoutubeHost) return null;
        let videoId = "";
        if (host.includes("youtu.be")) {
            videoId = parsed.pathname.replace("/", "").trim();
        } else {
            videoId = parsed.searchParams.get("v") || "";
        }
        if (!videoId) return null;
        return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    } catch {
        return null;
    }
}

export class Downloader {
    static downloadQueue = [];
    static lastSearchResults = [];
    static librarySyncFallbackTimer = null;
    static librarySyncFallbackAttempts = 0;
    static lastDownloaderStatus = null;
    static suppressResultClicksUntil = 0;
    static queueWindowOffsetX = 0;
    static queueWindowOffsetY = 0;
    static queueWindowDragPending = null;
    static queueWindowDragTimer = null;
    static queueWindowDragBound = false;
    static QUEUE_DRAG_HOLD_MS = 220;
    static QUEUE_DRAG_ACTIVATION_STRIP_PX = 16;
    static QUEUE_DRAG_EDGE_MARGIN_PX = 10;
    static QUEUE_DRAG_STORAGE_KEY = 'soundsible_odst_queue_window_pos_v1';

    static init() {
        if (this.initialized) return;
        this.initialized = true;

        this.searchInput = document.getElementById('dl-search-input');
        this.searchBtn = document.getElementById('dl-search-btn');
        this.searchResults = document.getElementById('dl-search-results');
        this.reviewPanel = document.getElementById('dl-review-panel');
        this.reviewList = document.getElementById('dl-review-list');
        this.reviewRefreshBtn = document.getElementById('dl-review-refresh');
        this.queueContainer = document.getElementById('dl-queue-container');
        this.downloadQueuePopover = document.getElementById('dl-download-queue-popover');
        this.downloadQueueList = document.getElementById('dl-download-queue-list');
        this.submitDownloadBtn = document.getElementById('dl-submit-download-btn');
        this.previewModal = document.getElementById('dl-preview-modal');
        this.previewClose = document.getElementById('dl-preview-close');
        this.previewIframeWrap = document.getElementById('dl-preview-iframe-wrap');
        this.coverChoiceModal = document.getElementById('dl-cover-choice-modal');
        this.coverChoiceBound = false;
        this.currentCoverChoiceTrack = null;

        this.queueList = document.getElementById('dl-queue-list');
        this.logs = document.getElementById('dl-logs');
        this.startBtn = document.getElementById('dl-start-btn');

        this.confClientId = document.getElementById('dl-conf-client-id');
        this.confClientSecret = document.getElementById('dl-conf-client-secret');
        this.confPath = document.getElementById('dl-conf-path');
        this.confR2Acc = document.getElementById('dl-conf-r2-acc');
        this.confR2Bucket = document.getElementById('dl-conf-r2-bucket');
        this.confR2Key = document.getElementById('dl-conf-r2-key');
        this.confR2Secret = document.getElementById('dl-conf-r2-secret');
        this.saveConfBtn = document.getElementById('dl-save-conf-btn');
        this.optimizeBtn = document.getElementById('dl-optimize-btn');
        this.syncBtn = document.getElementById('dl-sync-btn');
        this.spotifyList = document.getElementById('dl-spotify-playlists');
        this.refreshSpotifyBtn = document.getElementById('dl-refresh-spotify-btn');

        this.bindEvents();
        this.initQueueWindowDrag();
        this.updateFabAndPopover();
        this.refreshStatus();
        this.loadMetadataReviews();
        if (this.confClientId) this.loadConfig();
        if (this.spotifyList) this.loadSpotifyPlaylists();
        setInterval(() => this.refreshStatus(), 5000);
    }

    static bindEvents() {
        window.addEventListener('downloader_log', (e) => this.addLog(e.detail.data));
        window.addEventListener('downloader_update', (e) => {
            this.refreshStatus();
            if (e?.detail?.status === 'completed') {
                store.syncLibrary();
                // Check if premium cover failed
                const track = e?.detail?.track;
                if (track && (track.premium_cover_failed || (track.cover_source && !['spotify', 'musicbrainz', 'itunes', 'youtube_music'].includes(track.cover_source)))) {
                    this.showCoverChoiceModal(track);
                }
            }
        });

        if (this.searchBtn) this.searchBtn.addEventListener('click', () => this.handlePrimaryInput());
        if (this.searchInput) this.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.handlePrimaryInput(); });
        if (this.submitDownloadBtn) this.submitDownloadBtn.addEventListener('click', (e) => {
            // Prevent ghost/click-through on underlying search results.
            e.preventDefault();
            e.stopPropagation();
            this.suppressResultClicksUntil = Date.now() + 700;
            this.submitDownloadQueue();
        });
        if (this.previewClose) this.previewClose.addEventListener('click', () => this.hidePreview());

        if (this.startBtn) this.startBtn.addEventListener('click', () => this.startProcessing());

        if (this.saveConfBtn) this.saveConfBtn.addEventListener('click', () => this.saveConfig());
        if (this.refreshSpotifyBtn) this.refreshSpotifyBtn.addEventListener('click', () => this.loadSpotifyPlaylists());
        if (this.optimizeBtn) this.optimizeBtn.addEventListener('click', () => this.triggerOptimize());
        if (this.syncBtn) this.syncBtn.addEventListener('click', () => this.triggerSync());
        if (this.reviewRefreshBtn) this.reviewRefreshBtn.addEventListener('click', () => this.loadMetadataReviews());
        
        // Refetch metadata button
        const refetchBtn = document.getElementById('refetch-metadata-btn');
        if (refetchBtn) {
            refetchBtn.addEventListener('click', () => this.refetchMetadata());
        }

        window.Downloader = this;
    }

    static initQueueWindowDrag() {
        if (!this.queueContainer || !this.downloadQueuePopover) return;
        if (!this.queueWindowDragBound) {
            this.downloadQueuePopover.addEventListener('pointerdown', (e) => this.onQueueWindowPointerDown(e));
            window.addEventListener('pointermove', (e) => this.onQueueWindowPointerMove(e));
            window.addEventListener('pointerup', (e) => this.onQueueWindowPointerUp(e));
            window.addEventListener('pointercancel', (e) => this.onQueueWindowPointerUp(e));
            window.addEventListener('resize', () => this.clampQueueWindowToViewport(true));
            this.queueWindowDragBound = true;
        }
        this.restoreQueueWindowPosition();
        this.applyQueueWindowTransform();
        this.clampQueueWindowToViewport(true);
    }

    static restoreQueueWindowPosition() {
        try {
            const raw = localStorage.getItem(this.QUEUE_DRAG_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const ox = Number(parsed?.x);
            const oy = Number(parsed?.y);
            if (Number.isFinite(ox)) this.queueWindowOffsetX = ox;
            if (Number.isFinite(oy)) this.queueWindowOffsetY = oy;
        } catch {
            // Ignore corrupt storage.
        }
    }

    static persistQueueWindowPosition() {
        try {
            localStorage.setItem(this.QUEUE_DRAG_STORAGE_KEY, JSON.stringify({
                x: this.queueWindowOffsetX,
                y: this.queueWindowOffsetY
            }));
        } catch {
            // Ignore storage errors.
        }
    }

    static applyQueueWindowTransform() {
        if (!this.queueContainer) return;
        this.queueContainer.style.transform = `translate3d(${this.queueWindowOffsetX}px, ${this.queueWindowOffsetY}px, 0)`;
    }

    static clampQueueWindowToViewport(apply = false) {
        if (!this.downloadQueuePopover || !this.queueContainer) return;
        const rect = this.downloadQueuePopover.getBoundingClientRect();
        const margin = this.QUEUE_DRAG_EDGE_MARGIN_PX;
        let nextX = this.queueWindowOffsetX;
        let nextY = this.queueWindowOffsetY;

        if (rect.left < margin) nextX += (margin - rect.left);
        if (rect.right > window.innerWidth - margin) nextX -= (rect.right - (window.innerWidth - margin));
        if (rect.top < margin) nextY += (margin - rect.top);
        if (rect.bottom > window.innerHeight - margin) nextY -= (rect.bottom - (window.innerHeight - margin));

        this.queueWindowOffsetX = nextX;
        this.queueWindowOffsetY = nextY;
        if (apply) {
            this.applyQueueWindowTransform();
            this.persistQueueWindowPosition();
        }
    }

    static popQueueWindow() {
        if (!this.downloadQueuePopover) return;
        if (typeof this.downloadQueuePopover.animate === 'function') {
            this.downloadQueuePopover.animate(
                [
                    { transform: 'scale(1)' },
                    { transform: 'scale(1.035)' },
                    { transform: 'scale(1)' }
                ],
                { duration: 170, easing: 'cubic-bezier(0.19, 1, 0.22, 1)' }
            );
        }
    }

    static onQueueWindowPointerDown(e) {
        if (!this.downloadQueuePopover || this.downloadQueue.length === 0) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const interactiveTarget = e.target?.closest?.('button, a, input, textarea, select, [data-no-drag]');
        if (interactiveTarget) return;

        const rect = this.downloadQueuePopover.getBoundingClientRect();
        const localY = e.clientY - rect.top;
        if (localY < 0 || localY > this.QUEUE_DRAG_ACTIVATION_STRIP_PX) return;

        this.queueWindowDragPending = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseOffsetX: this.queueWindowOffsetX,
            baseOffsetY: this.queueWindowOffsetY,
            baseRect: rect,
            started: false,
        };
        clearTimeout(this.queueWindowDragTimer);
        this.queueWindowDragTimer = setTimeout(() => {
            if (!this.queueWindowDragPending || this.queueWindowDragPending.pointerId !== e.pointerId) return;
            this.queueWindowDragPending.started = true;
            this.suppressResultClicksUntil = Date.now() + 600;
            this.popQueueWindow();
            Haptics.tick();
            document.body.style.userSelect = 'none';
            document.body.style.webkitUserSelect = 'none';
        }, this.QUEUE_DRAG_HOLD_MS);
    }

    static onQueueWindowPointerMove(e) {
        const pending = this.queueWindowDragPending;
        if (!pending || pending.pointerId !== e.pointerId) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;

        if (!pending.started) {
            // If user starts scrolling/moving before hold, treat it as normal interaction.
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
                clearTimeout(this.queueWindowDragTimer);
                this.queueWindowDragTimer = null;
                this.queueWindowDragPending = null;
            }
            return;
        }

        e.preventDefault();
        const margin = this.QUEUE_DRAG_EDGE_MARGIN_PX;
        const minX = margin - pending.baseRect.left + pending.baseOffsetX;
        const maxX = (window.innerWidth - margin - pending.baseRect.right) + pending.baseOffsetX;
        const minY = margin - pending.baseRect.top + pending.baseOffsetY;
        const maxY = (window.innerHeight - margin - pending.baseRect.bottom) + pending.baseOffsetY;
        const nextX = Math.min(maxX, Math.max(minX, pending.baseOffsetX + dx));
        const nextY = Math.min(maxY, Math.max(minY, pending.baseOffsetY + dy));
        this.queueWindowOffsetX = nextX;
        this.queueWindowOffsetY = nextY;
        this.applyQueueWindowTransform();
    }

    static onQueueWindowPointerUp(e) {
        const pending = this.queueWindowDragPending;
        if (!pending || pending.pointerId !== e.pointerId) return;
        clearTimeout(this.queueWindowDragTimer);
        this.queueWindowDragTimer = null;

        if (pending.started) {
            this.clampQueueWindowToViewport(true);
        }

        this.queueWindowDragPending = null;
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
    }

    static parseUrlLines(rawInput) {
        const raw = (rawInput || "").trim();
        const lines = raw
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length === 0) return { mode: 'empty', accepted: [], rejected: [] };
        const urlMatches = raw.match(/https?:\/\/[^\s]+/g) || [];
        const textWithoutUrls = raw.replace(/https?:\/\/[^\s]+/g, '').trim();
        const candidates = urlMatches.length > 0 && textWithoutUrls.length === 0 ? urlMatches : lines;
        const accepted = [];
        const rejected = [];
        for (const line of candidates) {
            const normalized = normalizeYouTubeUrl(line);
            if (!normalized) {
                rejected.push({ line, reason: 'Unsupported or invalid URL' });
                continue;
            }
            accepted.push({ line, normalized });
        }
        const isUrlMode = accepted.length > 0 && rejected.length === 0;
        return { mode: isUrlMode ? 'url' : 'search', accepted, rejected, lines };
    }

    static async handlePrimaryInput() {
        const raw = this.searchInput?.value?.trim() || '';
        if (!raw) return;
        const parsed = this.parseUrlLines(raw);
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
        for (const url of urls) {
            if (existing.has(url)) continue;
            existing.add(url);
            this.downloadQueue.push({
                source_type: 'youtube_url',
                song_str: url,
                title: url,
                channel: '',
                duration: 0
            });
            added += 1;
        }
        this.renderDownloadQueueList();
        this.updateFabAndPopover();
        if (added > 0) {
            this.addLog(`Added ${added} URL item(s) to pending queue.`);
            Haptics.tick();
        }
    }

    static async runSearch(queryText = null) {
        const q = (queryText || this.searchInput?.value || '').trim();
        if (!q || !this.searchResults) return;
        this.searchResults.innerHTML = '<div class="text-center py-8 text-gray-500">Searching...</div>';
        this.searchBtn?.classList.add('opacity-70');
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/youtube/search?q=${encodeURIComponent(q)}&limit=10`);
            const data = await resp.json();
            this.searchBtn?.classList.remove('opacity-70');
            if (!resp.ok) {
                this.searchResults.innerHTML = `<div class="text-center py-8 text-red-400">${esc(data.error || 'Search failed')}</div>`;
                return;
            }
            const results = data.results || [];
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
            this.searchResults.innerHTML = '<div class="text-center py-8 text-red-400">Could not reach Station.</div>';
        }
    }

    static renderResultRow(r) {
        const thumbUrl = (r.thumbnail || '').replace(/"/g, '%22').replace(/'/g, '%27');
        const duration = formatDuration(r.duration);
        return `<div class="flex items-center gap-3 p-3 rounded-xl border border-white/10 bg-black/20 hover:bg-white/5 transition-colors group cursor-pointer" data-video-id="${esc(r.id)}">
            <div class="w-12 h-12 rounded-lg bg-black/40 flex-shrink-0 dl-result-thumb" style="background-image:url('${thumbUrl}'); background-size:cover; background-position:center;"></div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold truncate">${esc(r.title)}</div>
                <div class="text-xs text-gray-500 truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-add-one w-10 h-10 rounded-full bg-white/10 hover:bg-[var(--accent)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" data-video-id="${esc(r.id)}" aria-label="Add to download queue"><i class="fas fa-plus text-sm"></i></button>
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
            if (addBtn && result) addBtn.addEventListener('click', (e) => { e.stopPropagation(); this.addToDownloadQueue(result); });
        });
    }

    static playPreview(videoId) {
        if (!this.previewModal || !this.previewIframeWrap) return;
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
    }

    static showCoverChoiceModal(track) {
        const modal = document.getElementById('dl-cover-choice-modal');
        if (!modal || !track) return;
        
        // Store current track for handlers
        this.currentCoverChoiceTrack = track;
        
        // Update modal content
        document.getElementById('dl-cover-choice-title').textContent = track.title || 'Unknown Title';
        document.getElementById('dl-cover-choice-artist').textContent = track.artist || 'Unknown Artist';
        
        // Show modal
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        
        // Bind handlers if not already bound
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
                // Use YouTube cover
                const coverUrl = track.fallback_cover_url || track.album_art_url;
                if (coverUrl) {
                    const res = await fetch(`${store.apiBase}/api/library/tracks/${track.id}/metadata`, {
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
                // Show library cover picker - for now, just show a message
                // TODO: Implement library cover picker UI
                alert('Library cover picker coming soon. For now, use Edit Metadata → Upload Cover.');
            } else if (choice === 'upload') {
                // Open metadata editor with upload focus
                if (window.UI && window.UI.showMetadataEditor) {
                    window.UI.showMetadataEditor(track.id);
                    // Focus upload button after a delay
                    setTimeout(() => {
                        const uploadBtn = document.getElementById('edit-upload-btn');
                        if (uploadBtn) uploadBtn.click();
                    }, 300);
                }
            } else if (choice === 'none') {
                // Clear cover
                const res = await fetch(`${store.apiBase}/api/library/tracks/${track.id}/cover/none`, {
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

    static addToDownloadQueue(result) {
        if (!result || !result.id) return;
        const canonicalUrl = normalizeYouTubeUrl(result.webpage_url || `https://www.youtube.com/watch?v=${result.id}`);
        if (!canonicalUrl) return;
        this.downloadQueue.push({
            source_type: 'ytmusic_search',
            song_str: canonicalUrl,
            video_id: result.id,
            title: result.title || canonicalUrl,
            channel: result.channel || '',
            duration: result.duration || 0,
            thumbnail: result.thumbnail || '',
            metadata_evidence: {
                title: result.title || '',
                artist: result.channel || '',
                duration_sec: result.duration || 0,
                source: 'ytmusic_search',
                video_id: result.id,
                channel: result.channel || ''
            }
        });
        this.renderDownloadQueueList();
        this.updateFabAndPopover();
        Haptics.tick();
    }

    static renderDownloadQueueList() {
        if (!this.downloadQueueList) return;
        if (this.downloadQueue.length === 0) {
            this.downloadQueueList.innerHTML = '<div class="text-center text-gray-500 py-4 text-sm">No songs in queue</div>';
            return;
        }
        this.downloadQueueList.innerHTML = this.downloadQueue.map((r, i) => `
            <div class="flex items-center gap-2 p-2 rounded-lg bg-black/20">
                <div class="w-8 h-8 rounded bg-black/40 flex-shrink-0" style="background-image:url('${(r.thumbnail || '').replace(/"/g, '%22')}'); background-size:cover;"></div>
                <div class="flex-1 min-w-0">
                    <div class="text-xs font-medium truncate">${esc(r.title || r.song_str || 'Queue item')}</div>
                    <div class="text-[10px] text-gray-500 truncate">${esc(r.source_type || 'manual')}</div>
                </div>
                <button type="button" class="dl-remove-queue text-red-400 hover:text-red-300 p-1" data-index="${i}"><i class="fas fa-times text-[10px]"></i></button>
            </div>
        `).join('');
        this.downloadQueueList.querySelectorAll('.dl-remove-queue').forEach(btn => {
            btn.addEventListener('click', () => {
                const i = parseInt(btn.getAttribute('data-index'), 10);
                this.downloadQueue.splice(i, 1);
                this.renderDownloadQueueList();
                this.updateFabAndPopover();
            });
        });
    }

    static updateFabAndPopover() {
        const n = this.downloadQueue.length;
        const popover = this.downloadQueuePopover;

        // Contract/expand behavior disabled: queue is always expanded when it has items.
        const showPopover = n > 0;
        if (popover) {
            popover.style.pointerEvents = showPopover ? 'auto' : 'none';
            popover.style.transform = showPopover ? 'scale(1)' : 'scale(0.95)';
            popover.style.opacity = showPopover ? '1' : '0';
            // Ensure draggable window is never trapped outside viewport.
            if (showPopover) this.clampQueueWindowToViewport(true);
        }
    }

    static async submitDownloadQueue() {
        if (this.downloadQueue.length === 0) return;
        const items = this.downloadQueue.map((r) => ({
            source_type: r.source_type || 'youtube_url',
            song_str: r.song_str || normalizeYouTubeUrl(r.webpage_url || `https://www.youtube.com/watch?v=${r.video_id || r.id || ''}`),
            output_dir: r.output_dir,
            metadata_evidence: r.metadata_evidence || null
        })).filter((item) => !!item.song_str);
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items })
            });
            if (!resp.ok) throw new Error((await resp.json()).message || 'Failed');
            this.downloadQueue = [];
            this.renderDownloadQueueList();
            this.updateFabAndPopover();
            await fetch(`${store.apiBase}/api/downloader/start`, { method: 'POST' });
            this.startLibrarySyncFallback();
            this.refreshStatus();
            this.addLog(`Queued ${items.length} item(s).`);
            Haptics.tick();
        } catch (err) {
            this.addLog(`Submit failed: ${err.message}`);
            Haptics.error();
        }
    }

    static addToQueue() {
        this.handlePrimaryInput();
    }

    static async startProcessing() {
        try {
            await fetch(`${store.apiBase}/api/downloader/start`, { method: 'POST' });
            this.refreshStatus();
        } catch (err) {
            console.error("Start failed:", err);
        }
    }

    static async refreshStatus() {
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue/status`);
            const data = await resp.json();
            this.lastDownloaderStatus = data;
            this.renderQueue(data.queue, data.is_processing);
            this.renderLogs(data.logs);
            this.loadMetadataReviews();
            if (!data.is_processing && this.librarySyncFallbackTimer) {
                // Final forced sync once processing is idle, then stop fallback loop.
                store.syncLibrary();
                this.stopLibrarySyncFallback();
            }
        } catch (err) {
            console.error("Status refresh failed:", err);
        }
    }

    static startLibrarySyncFallback() {
        this.stopLibrarySyncFallback();
        this.librarySyncFallbackAttempts = 0;
        this.librarySyncFallbackTimer = setInterval(() => {
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
            await fetch(`${store.apiBase}/api/downloader/queue/${id}`, { method: 'DELETE' });
            this.refreshStatus();
        } catch (err) {
            console.error("Remove failed:", err);
        }
    }

    static async clearQueue() {
        if (!confirm("Clear all items from the queue?")) return;
        try {
            await fetch(`${store.apiBase}/api/downloader/queue`, { method: 'DELETE' });
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
                    <div class="text-xs font-bold truncate">${esc(item.song_str) || 'Spotify Track'}</div>
                    <div class="text-[9px] text-gray-500 mt-0.5">${new Date(item.added_at).toLocaleString()}${item.metadata_state ? ` · ${esc(item.metadata_state)}` : ''}</div>
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

    static getStatusBadge(status) {
        const colors = {
            'pending': 'bg-gray-700 text-gray-400',
            'downloading': 'bg-blue-900/40 text-blue-400 animate-pulse',
            'completed': 'bg-green-900/40 text-green-400',
            'failed': 'bg-red-900/40 text-red-400',
            'pending_review': 'bg-amber-900/40 text-amber-300'
        };
        return `<span class="text-[8px] uppercase font-black px-2 py-0.5 rounded-full ${colors[status] || 'bg-gray-700'}">${status}</span>`;
    }

    static formatReviewSourceLabel(sourceKey) {
        const key = String(sourceKey || '').toLowerCase();
        if (key === 'spotify_web' || key === 'spotify_api' || key === 'spotify') return 'Spotify';
        if (key === 'musicbrainz') return 'MusicBrainz';
        if (key === 'itunes') return 'iTunes';
        if (key === 'youtube') return 'YouTube';
        return sourceKey || 'Unknown';
    }

    static buildReviewCandidateLine(sourceKey, candidate) {
        if (!candidate || typeof candidate !== 'object') return '';
        const label = this.formatReviewSourceLabel(sourceKey);
        const title = esc(candidate.title || 'Unknown title');
        const artist = esc(candidate.artist || 'Unknown artist');
        const album = esc(candidate.album || 'Unknown album');
        return `<div class="text-[10px] text-[var(--text-dim)] truncate">${label}: ${title} · ${artist} · ${album}</div>`;
    }

    static async loadMetadataReviews() {
        if (!store.state.activeHost || !this.reviewList || !this.reviewPanel) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/metadata-review?status=pending_review`);
            if (!resp.ok) return;
            const data = await resp.json();
            const items = data.items || [];
            if (items.length === 0) {
                this.reviewPanel.classList.add('hidden');
                return;
            }
            this.reviewPanel.classList.remove('hidden');
            this.reviewList.innerHTML = items.map((item) => `
                <div class="p-2 rounded-lg bg-black/20 border border-white/5">
                    <div class="text-[10px] font-black uppercase tracking-widest text-[var(--text-dim)]">Metadata review required</div>
                    <div class="mt-2">
                        <div class="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-wide">YouTube detected</div>
                        <div class="text-xs font-semibold truncate">${esc(item.song_str || 'Unknown YouTube item')}</div>
                    </div>
                    <div class="mt-2">
                        <div class="text-[10px] font-bold text-[var(--text-dim)] uppercase tracking-wide">Proposed canonical metadata</div>
                        <div class="text-xs font-semibold truncate">${esc((item.proposed && item.proposed.title) || 'Unknown title')}</div>
                        <div class="text-[10px] text-[var(--text-dim)] truncate">${esc((item.proposed && item.proposed.artist) || 'Unknown artist')} · ${esc((item.proposed && item.proposed.album) || 'Unknown album')}</div>
                    </div>
                    <div class="text-[10px] text-[var(--text-dim)] mt-1">confidence ${(item.confidence || 0).toFixed(3)}</div>
                    <div class="mt-1 space-y-0.5">
                        ${this.buildReviewCandidateLine('spotify_web', item.candidates?.spotify_web)}
                        ${this.buildReviewCandidateLine('spotify_api', item.candidates?.spotify_api)}
                        ${this.buildReviewCandidateLine('musicbrainz', item.candidates?.musicbrainz)}
                        ${this.buildReviewCandidateLine('itunes', item.candidates?.itunes)}
                    </div>
                    <div class="flex gap-2 mt-2">
                        <button type="button" class="dl-review-approve text-[10px] px-2 py-1 rounded bg-[var(--accent)] text-white" data-id="${esc(item.id)}">Use proposed metadata</button>
                        <button type="button" class="dl-review-reject text-[10px] px-2 py-1 rounded bg-red-500/30 text-red-200" data-id="${esc(item.id)}">Keep YouTube metadata</button>
                    </div>
                </div>
            `).join('');
            this.reviewList.querySelectorAll('.dl-review-approve').forEach((btn) => {
                btn.addEventListener('click', () => this.approveReviewItem(btn.getAttribute('data-id')));
            });
            this.reviewList.querySelectorAll('.dl-review-reject').forEach((btn) => {
                btn.addEventListener('click', () => this.rejectReviewItem(btn.getAttribute('data-id')));
            });
        } catch (_err) {
            // silent
        }
    }

    static async approveReviewItem(id) {
        if (!id) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/metadata-review/${encodeURIComponent(id)}/approve`, { method: 'POST' });
            if (!resp.ok) return;
            this.loadMetadataReviews();
            store.syncLibrary();
            this.addLog('Metadata review approved.');
        } catch (_err) {}
    }

    static async rejectReviewItem(id) {
        if (!id) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/metadata-review/${encodeURIComponent(id)}/reject`, { method: 'POST' });
            if (!resp.ok) return;
            this.loadMetadataReviews();
            this.addLog('Metadata review rejected (fallback kept).');
        } catch (_err) {}
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
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/config`);
            const data = await resp.json();
            this.confClientId.value = data.spotify_client_id || '';
            this.confClientSecret.value = data.spotify_client_secret || '';
            this.confPath.value = data.output_dir || '';
            
            this.confR2Acc.value = data.r2_account_id || '';
            this.confR2Bucket.value = data.r2_bucket || '';
            this.confR2Key.value = data.r2_access_key || '';
            this.confR2Secret.value = data.r2_secret_key || '';
        } catch (err) {
            console.error("Config load failed:", err);
        }
    }

    static async saveConfig() {
        const data = {
            spotify_client_id: this.confClientId.value,
            spotify_client_secret: this.confClientSecret.value,
            output_dir: this.confPath.value,
            r2_account_id: this.confR2Acc.value,
            r2_bucket: this.confR2Bucket.value,
            r2_access_key: this.confR2Key.value,
            r2_secret_key: this.confR2Secret.value
        };

        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            if (resp.ok) {
                this.addLog("Settings updated on Station.");
                this.loadConfig(); // Refresh to see masks
            }
        } catch (err) {
            console.error("Config save failed:", err);
        }
    }

    static async triggerOptimize() {
        const dryRun = confirm("Run Optimization in DRY RUN mode first? (Cancel for LIVE mode)");
        try {
            await fetch(`${store.apiBase}/api/downloader/optimize`, {
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
            await fetch(`${store.apiBase}/api/downloader/sync`, { method: 'POST' });
            this.addLog("Cloud Sync started...");
        } catch (err) {
            console.error("Sync failed:", err);
        }
    }

    static async loadSpotifyPlaylists() {
        if (!store.state.activeHost) return;
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/spotify/playlists`);
            if (!resp.ok) {
                if (resp.status === 401) {
                    this.spotifyList.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500 italic text-sm">Spotify not authenticated. Update settings below.</div>';
                }
                return;
            }
            const data = await resp.json();
            this.renderSpotifyPlaylists(data.playlists);
        } catch (err) {
            console.error("Spotify load failed:", err);
        }
    }

    static renderSpotifyPlaylists(playlists) {
        if (!playlists || playlists.length === 0) {
            this.spotifyList.innerHTML = '<div class="col-span-full text-center py-10 text-gray-500">No playlists found.</div>';
            return;
        }

        const html = playlists.map(p => `
            <div class="bg-gray-900 border border-gray-700 p-3 rounded-xl hover:bg-gray-700 cursor-pointer transition-colors group" onclick="Downloader.addSpotifyPlaylist('${p.id}', '${p.name.replace(/'/g, "\\'")}')">
                <div class="aspect-square bg-gray-800 rounded-lg mb-2 flex items-center justify-center overflow-hidden">
                    ${p.images && p.images[0] ? `<img src="${p.images[0].url}" class="w-full h-full object-cover">` : '<i class="fas fa-music text-gray-600"></i>'}
                </div>
                <div class="text-[10px] font-bold truncate">${esc(p.name)}</div>
                <div class="text-[8px] text-gray-500">${p.tracks.total} tracks</div>
            </div>
        `).join('');

        this.spotifyList.innerHTML = html;
        window.Downloader = Downloader; // Ensure it's globally accessible for onclick
    }

    static async addSpotifyPlaylist(id, name) {
        if (!confirm(`Add all tracks from "${name}" to download queue?`)) return;
        
        this.addLog(`Fetching tracks for playlist: ${name}...`);
        
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    items: [{ source_type: 'spotify_playlist', type: 'playlist', id: id, song_str: `Playlist: ${name}`, spotify_data: { type: 'playlist', id: id } }] 
                })
            });
            if (resp.ok) {
                this.refreshStatus();
                this.addLog(`Queued playlist: ${name}`);
            }
        } catch (err) {
            console.error("Playlist queue failed:", err);
        }
    }

    static async refetchMetadata() {
        const btn = document.getElementById('refetch-metadata-btn');
        const status = document.getElementById('refetch-metadata-status');
        if (!btn || !status) return;
        
        btn.disabled = true;
        btn.textContent = 'Refetching...';
        status.classList.remove('hidden');
        status.textContent = 'Starting metadata refetch...';
        
        try {
            const res = await fetch(`${store.apiBase}/api/library/refetch-metadata`, {
                method: 'POST'
            });
            const data = await res.json();
            
            if (res.ok) {
                status.textContent = `✓ Updated: ${data.updated || 0}, Skipped: ${data.skipped || 0}, Errors: ${data.errors || 0}`;
                status.classList.remove('text-red-400');
                status.classList.add('text-green-400');
                await store.syncLibrary();
                this.addLog(`Metadata refetch completed: ${data.updated} updated, ${data.skipped} skipped`);
            } else {
                status.textContent = `✗ Error: ${data.error || 'Unknown error'}`;
                status.classList.remove('text-green-400');
                status.classList.add('text-red-400');
            }
        } catch (err) {
            status.textContent = `✗ Failed: ${err.message}`;
            status.classList.remove('text-green-400');
            status.classList.add('text-red-400');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Re-fetch Metadata';
        }
    }
}
