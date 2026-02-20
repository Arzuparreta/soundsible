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
    /** Search source: 'music' = YouTube Music (default), 'youtube' = normal YouTube */
    static searchSource = 'music';

    static init() {
        if (this.initialized) return;
        this.initialized = true;

        this.searchInput = document.getElementById('dl-search-input');
        this.searchBtn = document.getElementById('dl-search-btn');
        this.searchResults = document.getElementById('dl-search-results');
        this.queueContainer = document.getElementById('dl-queue-container');
        this.dlQueueFab = document.getElementById('dl-queue-fab');
        this.dlQueueBadge = document.getElementById('dl-queue-badge');
        this.downloadQueuePopover = document.getElementById('dl-download-queue-popover');
        this.downloadQueueList = document.getElementById('dl-download-queue-list');
        this.clearQueueBtn = document.getElementById('dl-clear-queue-btn');
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
        this.searchSourceMusicBtn = document.getElementById('dl-search-source-music');
        this.searchSourceYoutubeBtn = document.getElementById('dl-search-source-youtube');

        if (this.queueContainer) this.queueContainer.style.transform = '';
        this.bindEvents();
        this.updateFabAndPopover();
        this.refreshStatus();
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
                const track = e?.detail?.track;
                if (track?.download_source === 'youtube_search') return;
                if (track && (track.premium_cover_failed || (track.cover_source && !['spotify', 'musicbrainz', 'itunes', 'youtube_music'].includes(track.cover_source)))) {
                    this.showCoverChoiceModal(track);
                }
            }
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
        if (this.previewClose) this.previewClose.addEventListener('click', () => this.hidePreview());

        if (this.startBtn) this.startBtn.addEventListener('click', () => this.startProcessing());

        if (this.saveConfBtn) this.saveConfBtn.addEventListener('click', () => this.saveConfig());
        if (this.refreshSpotifyBtn) this.refreshSpotifyBtn.addEventListener('click', () => this.loadSpotifyPlaylists());
        if (this.optimizeBtn) this.optimizeBtn.addEventListener('click', () => this.triggerOptimize());
        if (this.syncBtn) this.syncBtn.addEventListener('click', () => this.triggerSync());

        // Refetch metadata button
        const refetchBtn = document.getElementById('refetch-metadata-btn');
        if (refetchBtn) {
            refetchBtn.addEventListener('click', () => this.refetchMetadata());
        }

        // Search source: Music | YouTube
        if (this.searchSourceMusicBtn) {
            this.searchSourceMusicBtn.addEventListener('click', () => this.setSearchSource('music'));
        }
        if (this.searchSourceYoutubeBtn) {
            this.searchSourceYoutubeBtn.addEventListener('click', () => this.setSearchSource('youtube'));
        }

        window.Downloader = this;
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

    static setSearchSource(value) {
        if (value !== 'music' && value !== 'youtube') return;
        this.searchSource = value;
        const musicBtn = this.searchSourceMusicBtn;
        const youtubeBtn = this.searchSourceYoutubeBtn;
        if (musicBtn && youtubeBtn) {
            if (value === 'music') {
                musicBtn.classList.add('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
                musicBtn.classList.remove('bg-[var(--surface-overlay)]', 'text-[var(--nav-icon)]');
                musicBtn.setAttribute('aria-pressed', 'true');
                youtubeBtn.classList.remove('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
                youtubeBtn.classList.add('text-[var(--nav-icon)]');
                youtubeBtn.setAttribute('aria-pressed', 'false');
            } else {
                youtubeBtn.classList.add('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
                youtubeBtn.classList.remove('bg-[var(--surface-overlay)]', 'text-[var(--nav-icon)]');
                youtubeBtn.setAttribute('aria-pressed', 'true');
                musicBtn.classList.remove('bg-[var(--accent)]', 'text-[var(--text-on-accent)]');
                musicBtn.classList.add('bg-[var(--surface-overlay)]', 'text-[var(--nav-icon)]');
                musicBtn.setAttribute('aria-pressed', 'false');
            }
        }
        Haptics.tick();
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
        const sourceParam = this.searchSource === 'youtube' ? 'youtube' : 'ytmusic';
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/youtube/search?q=${encodeURIComponent(q)}&limit=10&source=${sourceParam}`);
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
        return `<div class="flex items-center gap-3 p-3 rounded-xl border border-[var(--input-border)] transition-colors group cursor-pointer hover:bg-[var(--surface-overlay)]" style="background-color: var(--input-bg);" data-video-id="${esc(r.id)}">
            <div class="w-12 h-12 rounded-lg flex-shrink-0 dl-result-thumb" style="background-image:url('${thumbUrl}'); background-size:cover; background-position:center; background-color: var(--input-bg);"></div>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold truncate text-[var(--text-main)]">${esc(r.title)}</div>
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-add-one w-10 h-10 rounded-full bg-[var(--surface-overlay)] hover:bg-[var(--accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" data-video-id="${esc(r.id)}" aria-label="Add to download queue"><i class="fas fa-plus text-sm"></i></button>
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
        if (track?.download_source === 'youtube_search') return;
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
        const sourceType = this.searchSource === 'youtube' ? 'youtube_search' : 'ytmusic_search';
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
                artist: result.channel || '',
                duration_sec: result.duration || 0,
                source: sourceType,
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
            this.downloadQueueList.innerHTML = '<div class="text-center text-gray-500 py-10 italic text-xs">No songs in queue</div>';
            return;
        }
        this.downloadQueueList.innerHTML = this.downloadQueue.map((r, i) => `
            <div class="queue-item flex items-center p-2 hover:bg-[var(--surface-overlay)] rounded-2xl transition-colors group">
                <div class="w-10 h-10 rounded-xl flex-shrink-0 bg-cover bg-center" style="background-image:url('${(r.thumbnail || '').replace(/"/g, '%22')}'); background-color: var(--input-bg);"></div>
                <div class="ml-3 flex-1 min-w-0 truncate">
                    <div class="font-bold text-[13px] truncate text-[var(--text-main)]">${esc(r.title || r.song_str || 'Queue item')}</div>
                    <div class="text-[10px] text-[var(--text-dim)] truncate uppercase tracking-widest">${esc(r.source_type || 'manual')}</div>
                </div>
                <button type="button" class="dl-remove-queue w-10 h-10 flex items-center justify-center bg-[var(--surface-overlay)] text-[var(--text-dim)] rounded-full hover:bg-red-500/10 hover:text-red-400 active:scale-90 transition-all opacity-0 group-hover:opacity-100" data-index="${i}"><i class="fas fa-times text-xs"></i></button>
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
        const fab = this.dlQueueFab;
        const badge = this.dlQueueBadge;
        if (fab && badge) {
            if (n > 0) {
                fab.classList.replace('scale-0', 'scale-100');
                fab.classList.replace('opacity-0', 'opacity-100');
                badge.textContent = String(n);
            } else {
                fab.classList.replace('scale-100', 'scale-0');
                fab.classList.replace('opacity-100', 'opacity-0');
                badge.textContent = '0';
                this.hideDownloadQueue();
            }
        }
    }

    static toggleDownloadQueue() {
        const popover = this.downloadQueuePopover;
        if (!popover) return;
        if (popover.classList.contains('hidden')) {
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
            source_type: r.source_type || 'youtube_url',
            song_str: r.song_str || normalizeYouTubeUrl(r.webpage_url || `https://www.youtube.com/watch?v=${r.video_id || r.id || ''}`),
            output_dir: r.output_dir,
            metadata_evidence: r.metadata_evidence || null
        })).filter((item) => !!item.song_str);
        if (items.length === 0) {
            this.addLog('No valid items to send (missing URL).');
            return;
        }
        try {
            const resp = await fetch(`${store.apiBase}/api/downloader/queue`, {
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
