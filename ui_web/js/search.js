/**
 * Unified Search: Library + ODST in one bar.
 * Library: instant filter on input. ODST: debounced so internet search runs after user pauses typing.
 * Pasting a YouTube / YouTube Music watch URL resolves the video via /api/downloader/youtube/peek
 * (watch URL; independent of Music vs YouTube search mode) and shows that row first, then runs a
 * normal ODST query from the resolved title+artist so the rest of the list matches the current mode.
 */
import { store } from './store.js';
import { audioEngine } from './audio.js';
import { odstItemToPreviewTrack } from './preview_playback.js';
import * as renderers from './renderers.js';
import { esc } from './renderers.js';
import { Resolver } from './resolver.js';
import { Haptics } from './haptics.js';
import { searchService } from './search_service.js';
import { scoreLibrary, scoreArtist, mergeAndSortByScore, scoreOdst } from './search_scoring.js';
import { getApiBase } from './config.js';

const ODST_DEBOUNCE_MS = 150;

/**
 * Play one row from the merged library + ODST search list (render order). Sets audio context for autoplay.
 * @param {Array<{ source: string, track?: unknown, id?: string }>} mergedList
 * @param {number} index
 */
export function playMusicSearchAtIndex(mergedList, index) {
    if (!Array.isArray(mergedList) || index < 0 || index >= mergedList.length) return;
    const context = mergedList.map((m) => {
        if (m.source === 'library') return m.track;
        if (m.source === 'odst') return odstItemToPreviewTrack(m);
        return null;
    });
    if (context.some((c) => c == null)) return;
    const track = context[index];
    if (!track) return;
    audioEngine.setContext(context);
    store.update({ currentTrack: track });
    if (track.media_kind === 'podcast_episode') {
        store.recordPodcastPlay({
            episodeId: track.id,
            showTitle: (track.artist || track.album || '').trim(),
            author: (track.author || '').trim(),
            rssUrl: track.podcast_rss_url || ''
        });
    } else if (track.source !== 'preview' && track.source !== 'podcast-preview') {
        store.recordSongPlay(track);
    }
    audioEngine.playTrack(track);
}

/**
 * Desktop: library / ODST rows inside the download search panel use merged order instead of playTrackFromContext alone.
 * @param {HTMLElement} row
 * @returns {boolean} true if playback started
 */
export function tryPlayUnifiedMusicSearch(row) {
    const merged = typeof window !== 'undefined' ? window._musicSearchPlaybackMerged : null;
    if (!Array.isArray(merged) || !merged.length || !row) return false;
    const panel = row.closest('#desktop-dl-search-results') || row.closest('#dl-search-results');
    if (!panel) return false;
    const libId = row.getAttribute('data-id');
    const odstHost = row.closest('[data-source="odst"]') || (row.getAttribute('data-source') === 'odst' ? row : null);
    const effectiveVid =
        (odstHost || row).getAttribute('data-video-id') || row.getAttribute('data-video-id');
    let idx = -1;
    if (libId) {
        idx = merged.findIndex((m) => m && m.source === 'library' && m.track && m.track.id === libId);
    }
    if (idx < 0 && effectiveVid) {
        idx = merged.findIndex((m) => m && m.source === 'odst' && String(m.id) === String(effectiveVid));
    }
    if (idx < 0) return false;
    playMusicSearchAtIndex(merged, idx);
    return true;
}

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

let inputEl = null;
let resultsEl = null;
let lastLibraryItems = [];
let lastOdstResults = [];
let isMobile = true;
/** When false (desktop), library rows use hover-to-play style (delegation); no single-click play on row. */
let isDesktop = false;
/** When true, results are discover-only (ODST only, no library mix, no "ODST" label per row). */
let isDiscoverPage = false;
let detachTypeahead = null;
let musicBtnEl = null;
let youtubeBtnEl = null;
let onMusicSourceClick = null;
let onYoutubeSourceClick = null;

const SEARCH_EMPTY_DEFAULT = 'Search library and ODST...';

/** Resolve normalized watch URLs to ODST-shaped rows (same API as add-to-queue metadata). */
async function fetchPeekOdstRows(normalizedUrls) {
    const host = (store?.state?.activeHost
        || (typeof window !== 'undefined' ? window.location.hostname : '')
        || 'localhost');
    const base = getApiBase(host);
    const out = [];
    for (const u of normalizedUrls) {
        try {
            const params = new URLSearchParams({ url: u });
            const r = await fetch(`${base}/api/downloader/youtube/peek?${params.toString()}`);
            const data = await r.json().catch(() => ({}));
            const p = data?.peek;
            if (!p || !p.id) continue;
            out.push({
                id: p.id,
                title: p.title || 'Unknown',
                channel: p.channel || p.artist || '',
                artist: p.artist || p.channel || '',
                duration: Number(p.duration) || 0,
                thumbnail: p.thumbnail || '',
                webpage_url: p.webpage_url || u
            });
        } catch (_) {
            /* skip failed URL */
        }
    }
    return out;
}

/**
 * URL-only input: peek each link (watch URL; not tied to YTM vs YT toggle), prepend rows, then ODST search from resolved title.
 */
async function runOdstFetchWithResolvedUrls(raw, parsed) {
    if (!resultsEl || !parsed?.accepted?.length) return;
    if (isDiscoverPage) {
        resultsEl.innerHTML = '<div class="search-odst-loading text-center py-4 text-[var(--text-dim)] text-sm">Loading...</div>';
    }
    try {
        const normalizedUrls = parsed.accepted.map((x) => x.normalized);
        const prefixRows = await fetchPeekOdstRows(normalizedUrls);
        const prefixIds = new Set(prefixRows.map((r) => String(r.id)));
        const searchQuery = prefixRows.length
            ? `${prefixRows[0].title} ${prefixRows[0].channel || ''}`.trim()
            : '';
        if (!searchQuery) {
            throw new Error('Could not resolve this link');
        }
        let odstItems = [];
        try {
            const results = await searchService.query(searchQuery, { debounce: 0 });
            if (results === null) return;
            lastOdstResults = results;
            odstItems = results
                .map((r) => ({ source: 'odst', ...r }))
                .filter((item) => !prefixIds.has(String(item.id)));
        } catch (qErr) {
            lastOdstResults = [];
            if (prefixRows.length === 0) throw qErr;
        }
        const prefixItems = prefixRows.map((r) => ({ source: 'odst', ...r }));
        if (isDiscoverPage) {
            render([...prefixItems, ...odstItems]);
        } else {
            const librarySorted = [...lastLibraryItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render([...prefixItems, ...odstItems, ...librarySorted]);
        }
    } catch (err) {
        if (isDiscoverPage) {
            render([]);
        } else {
            const sorted = [...lastLibraryItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render(sorted);
        }
        const errMsg = err.message || 'Could not open this link';
        if (resultsEl) {
            const msg = document.createElement('div');
            msg.className = 'text-center py-3 text-[var(--text-dim)] text-sm';
            msg.textContent = errMsg;
            resultsEl.appendChild(msg);
        }
        if (typeof window.showToast === 'function') window.showToast(errMsg);
    }
    const loading = resultsEl?.querySelector('.search-odst-loading');
    if (loading) loading.remove();
}

function updateDiscoverPanels() {
    /* Discover is a single results panel; no SoundSnap/Browse toggle. */
}

export { scoreLibrary, scoreArtist, mergeAndSortByScore };

function buildLibraryRowHtml(track) {
    const coverUrl = Resolver.getCoverUrl(track);
    const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
    const state = store.state;
    const isActive = state.currentTrack && state.currentTrack.id === track.id;
    const playOverlay = isDesktop ? renderers.desktopPlayOverlaySmallHtml() : '';
    return `
    <div class="search-result-item mb-1">
        <div class="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)] mb-1">Library</div>
        <div class="song-row relative z-10 flex items-center py-2 pl-2 pr-2 group ${isActive ? 'bg-[var(--bg-selection)]' : 'bg-transparent'} rounded-[var(--radius-omni-xs)] border border-transparent transition-colors cursor-pointer" data-id="${esc(track.id)}" data-source="library">
            <div class="song-row-cover-wrapper relative w-11 h-11 flex-shrink-0${isDesktop ? ' group' : ''}">
                <div class="song-row-cover absolute inset-0 rounded-[var(--radius-list-cover)] overflow-hidden bg-cover bg-center" style="${coverStyle}" role="img" aria-label="Cover"></div>
                ${playOverlay}
            </div>
            <div class="ml-3 flex-1 min-w-0 truncate">
                <div class="song-title font-semibold text-[15px] leading-tight truncate text-[var(--text-main)]">${esc(track.title)}</div>
                <div class="text-xs text-[var(--text-dim)] truncate mt-0.5">${esc(track.artist)}</div>
            </div>
            <div class="flex items-center ml-2 flex-shrink-0">
                <div class="text-[10px] font-medium text-[var(--text-dim)] opacity-55 tabular-nums">${renderers.formatTime(track.duration)}</div>
            </div>
        </div>
    </div>`;
}

function isYoutubeId(id) {
    return id && typeof id === 'string' && id.length === 11 && !String(id).startsWith('raw-');
}

function buildOdstRowHtml(r, opts = {}) {
    const omitSourceLabel = opts.omitSourceLabel === true;
    const thumbUrl = (r.thumbnail || '').replace(/"/g, '%22').replace(/'/g, '%27');
    const placeholderUrl = (store.placeholderCoverUrl || '').replace(/"/g, '%22').replace(/'/g, '%27');
    const thumbStyle = thumbUrl ? `background-image:url('${thumbUrl}');` : (placeholderUrl ? `background-image:url('${placeholderUrl}');` : '');
    const duration = renderers.formatTime(r.duration);
    const ids = store.state.libraryYoutubeIds || [];
    const inLibrary = isYoutubeId(r.id) && ids.includes(r.id);
    const titleLine = inLibrary
        ? `<div class="flex items-center gap-2 min-w-0 flex-1"><span class="text-sm font-bold truncate text-[var(--text-main)]">${esc(r.title)}</span><span class="flex-shrink-0 inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-[var(--text-dim)]" title="In library"><i class="fas fa-box text-[10px]"></i></span></div>`
        : `<div class="text-sm font-bold truncate text-[var(--text-main)]">${esc(r.title)}</div>`;
    const dlIcon = inLibrary ? 'fa-sync-alt' : 'fa-cloud-download-alt';
    const dlAria = inLibrary ? 'Re-download' : 'Add to download queue';
    const tooltipAttrs = inLibrary ? ' data-hover-tooltip="Download again" data-hover-tooltip-delay="1000"' : '';
    const labelBlock = omitSourceLabel ? '' : `<div class="text-[10px] font-medium uppercase tracking-wide text-[var(--text-dim)] mb-1">ODST</div>`;
    const thumbHtml = isDesktop
        ? `<div class="song-row-cover-wrapper relative w-11 h-11 flex-shrink-0 group rounded-[var(--radius-list-cover)] overflow-hidden">
            <div class="dl-result-thumb absolute inset-0 rounded-[var(--radius-list-cover)] bg-cover bg-center" style="${thumbStyle} background-color: var(--input-bg);"></div>
            ${renderers.desktopPlayOverlaySmallHtml()}
          </div>`
        : `<div class="w-11 h-11 rounded-[var(--radius-list-cover)] flex-shrink-0 dl-result-thumb bg-cover bg-center" style="${thumbStyle} background-color: var(--input-bg);"></div>`;
    return `
    <div class="search-result-item mb-1">
        ${labelBlock}
        <div class="song-row discover-odst-row flex items-center gap-2.5 py-2 pl-2 pr-1 rounded-[var(--radius-omni-xs)] border border-transparent transition-colors group cursor-pointer" data-video-id="${esc(r.id)}" data-source="odst">
            ${thumbHtml}
            <div class="flex-1 min-w-0">
                ${titleLine}
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <div class="flex items-center gap-1 ml-1 flex-shrink-0">
                <button type="button" class="dl-playback-queue discover-secondary-action w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-[var(--input-bg)] hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 transition-colors" aria-label="Add to playback queue" title="Add to playback queue"><i class="fas fa-list-ul text-sm"></i></button>
                <button type="button" class="dl-add-one discover-primary-action w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-[var(--input-bg)] hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 transition-colors" data-video-id="${esc(r.id)}" aria-label="${esc(dlAria)}"${tooltipAttrs}><i class="fas ${dlIcon} text-sm"></i></button>
            </div>
        </div>
    </div>`;
}

function render(merged) {
    if (!resultsEl) return;
    const list = Array.isArray(merged) ? merged : [];
    if (typeof window !== 'undefined') {
        if (isDiscoverPage) {
            const o = list.filter((m) => m.source === 'odst');
            window._discoverSearchOdstItems = o.length ? o : null;
            window._musicSearchPlaybackMerged = null;
        } else {
            window._discoverSearchOdstItems = null;
            window._musicSearchPlaybackMerged = list.length ? list.slice() : null;
        }
    }
    const libraryTracks = list.filter((m) => m.source === 'library').map((m) => m.track);
    
    if (isDiscoverPage) {
        if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = [];
        window._currentSearchTracks = [];
    } else {
        if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = libraryTracks;
        window._currentSearchTracks = libraryTracks;
    }

    if (list.length === 0) {
        resultsEl.innerHTML = `<div class="text-center py-10 text-[var(--text-dim)] italic animate-in fade-in slide-in-from-bottom-2 duration-300">No results found for "${esc(inputEl.value)}"</div>`;
        return;
    }

    // ## Section: Spotify-like grouping
    const libItems = list.filter(m => m.source === 'library');
    const odstItems = list.filter(m => m.source === 'odst');

    let html = '';
    
    if (libItems.length > 0) {
        html += `<div class="search-section-header px-1 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-dim)] flex items-center gap-2">
                    <i class="fas fa-music text-[10px] opacity-80"></i> From Library
                 </div>`;
        html += libItems.map(item => {
            // Note: Build row without the inner "library" label
            const track = item.track;
            const coverUrl = Resolver.getCoverUrl(track);
            const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
            const isActive = store.state.currentTrack && store.state.currentTrack.id === track.id;
            const playOverlay = isDesktop ? renderers.desktopPlayOverlaySmallHtml() : '';
            return `
            <div class="search-result-item mb-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div class="song-row relative z-10 flex items-center py-2 pl-2 pr-2 group ${isActive ? 'bg-[var(--bg-selection)]' : 'bg-transparent'} rounded-[var(--radius-omni-xs)] border border-transparent transition-colors cursor-pointer" data-id="${esc(track.id)}" data-source="library">
                    <div class="song-row-cover-wrapper relative w-11 h-11 flex-shrink-0${isDesktop ? ' group' : ''}">
                        <div class="song-row-cover absolute inset-0 rounded-[var(--radius-list-cover)] overflow-hidden bg-cover bg-center" style="${coverStyle}" role="img" aria-label="Cover"></div>
                        ${playOverlay}
                    </div>
                    <div class="ml-3 flex-1 min-w-0 truncate">
                        <div class="song-title font-semibold text-[15px] leading-tight truncate text-[var(--text-main)]">${esc(track.title)}</div>
                        <div class="text-xs text-[var(--text-dim)] truncate mt-0.5">${esc(track.artist)}</div>
                    </div>
                    <div class="flex items-center ml-2 flex-shrink-0">
                        <div class="text-[10px] font-medium text-[var(--text-dim)] opacity-55 tabular-nums">${renderers.formatTime(track.duration)}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    if (odstItems.length > 0) {
        const sourceName = searchService.sourceMode === 'youtube' ? 'YouTube' : 'YouTube Music';
        const odstLabel = isDiscoverPage ? '' : `
            <div class="search-section-header px-1 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-dim)] flex items-center gap-2">
                <i class="fab fa-youtube text-[12px] opacity-80"></i> Results from ${sourceName}
            </div>`;
        html += odstLabel;
        html += odstItems.map(item => buildOdstRowHtml(item, { omitSourceLabel: true })).join('');
    }

    resultsEl.innerHTML = html;
    bindListeners(list);
}

function bindListeners(merged) {
    if (!resultsEl) return;
    if (!isDesktop) {
        resultsEl.querySelectorAll('[data-source="library"]').forEach((row) => {
            const id = row.getAttribute('data-id');
            if (!id) return;
            row.addEventListener('click', (e) => {
                if (e.target.closest('.dl-add-one')) return;
                if (!isDiscoverPage && Array.isArray(window._musicSearchPlaybackMerged)) {
                    const idx = window._musicSearchPlaybackMerged.findIndex(
                        (m) => m && m.source === 'library' && m.track && m.track.id === id
                    );
                    if (idx >= 0) {
                        playMusicSearchAtIndex(window._musicSearchPlaybackMerged, idx);
                        return;
                    }
                }
                if (typeof window.playTrack === 'function') window.playTrack(id);
            });
        });
    }
    const odstItems = merged.filter((m) => m.source === 'odst');
    resultsEl.querySelectorAll('[data-source="odst"]').forEach((row) => {
        const videoId = row.getAttribute('data-video-id');
        if (!videoId) return;
        const item = odstItems.find((o) => o.id === videoId) || null;
        row.addEventListener('click', (e) => {
            if (e.target.closest('.dl-add-one') || e.target.closest('.dl-playback-queue')) return;
            if (item && typeof window.playPreview === 'function') {
                if (isDiscoverPage && Array.isArray(window._discoverSearchOdstItems) && window._discoverSearchOdstItems.length) {
                    window.playPreview(item, { contextItems: window._discoverSearchOdstItems });
                } else if (!isDiscoverPage && Array.isArray(window._musicSearchPlaybackMerged)) {
                    const idx = window._musicSearchPlaybackMerged.findIndex(
                        (m) => m && m.source === 'odst' && String(m.id) === String(videoId)
                    );
                    if (idx >= 0) playMusicSearchAtIndex(window._musicSearchPlaybackMerged, idx);
                    else window.playPreview(item, { contextItems: odstItems });
                } else {
                    window.playPreview(item, { contextItems: odstItems });
                }
            }
        });
        const playbackQueueBtn = row.querySelector('.dl-playback-queue');
        if (playbackQueueBtn && item && store.addPreviewToQueue) {
            playbackQueueBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                store.addPreviewToQueue(item);
            });
        }
        const addBtn = row.querySelector('.dl-add-one');
        if (addBtn && item && typeof window.Downloader !== 'undefined' && window.Downloader.addToDownloadQueue) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.Downloader.addToDownloadQueue(item, { source: searchService.sourceMode });
                if (typeof window.Downloader.toggleDownloadQueue === 'function') {
                    window.Downloader.toggleDownloadQueue();
                }
                if (typeof window.showToast === 'function') {
                    window.showToast('Added to download queue');
                }
            });
        }
    });
}

/** Same engine as Library: shared filter, instant. Only updates library list; ODST is separate (debounced). */
function runLibraryOnly(raw) {
    if (!resultsEl) return;
    const libraryTracks = renderers.filterLibraryByQuery(store.state.library, raw);
    const libraryItems = libraryTracks.map((track) => ({
        source: 'library',
        track,
        score: scoreLibrary(track, raw),
        sortTitle: (track.title || '').toLowerCase()
    }));
    lastLibraryItems = libraryItems;
    const sorted = [...libraryItems].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.sortTitle || '').localeCompare(b.sortTitle || '');
    });
    render(sorted);
    const loading = resultsEl.querySelector('.search-odst-loading');
    if (loading) loading.remove();
    const loadingOdstEl = document.createElement('div');
    loadingOdstEl.className = 'search-odst-loading text-center py-4 text-[var(--text-dim)] text-sm';
    loadingOdstEl.textContent = 'Loading...';
    resultsEl.appendChild(loadingOdstEl);
}

/** Only ODST fetch; merges with lastLibraryItems when done. */
async function runOdstFetch(raw) {
    if (!resultsEl || !raw) {
        const loading = resultsEl?.querySelector('.search-odst-loading');
        if (loading) loading.remove();
        return;
    }
    
    try {
        const results = await searchService.query(raw, { debounce: ODST_DEBOUNCE_MS });
        if (results === null) return; // Note: Aborted
        
        lastOdstResults = results;
        const odstItems = results.map((r) => ({ source: 'odst', ...r }));
        if (isDiscoverPage) {
            render(odstItems);
        } else {
            const librarySorted = [...lastLibraryItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render([...odstItems, ...librarySorted]);
        }
        const loading = resultsEl?.querySelector('.search-odst-loading');
        if (loading) loading.remove();
    } catch (err) {
        if (isDiscoverPage) {
            render([]);
        } else {
            const sorted = [...lastLibraryItems].sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return (a.sortTitle || '').localeCompare(b.sortTitle || '');
            });
            render(sorted);
        }
        const loading = resultsEl?.querySelector('.search-odst-loading');
        if (loading) loading.remove();
        const errMsg = err.message || 'ODST search unavailable';
        if (resultsEl) {
            const msg = document.createElement('div');
            msg.className = 'text-center py-3 text-[var(--text-dim)] text-sm';
            msg.textContent = errMsg;
            resultsEl.appendChild(msg);
        }
        if (typeof window.showToast === 'function') window.showToast(errMsg);
    }
}

function onInput() {
    const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    if (!resultsEl) return;
    if (!raw) {
        clear();
        return;
    }
    updateDiscoverPanels();

    const parsed = searchService.parseUrlLines(raw);
    if (parsed.mode === 'url') {
        if (!isDiscoverPage) {
            runLibraryOnly(raw);
        }
        void runOdstFetchWithResolvedUrls(raw, parsed);
        return;
    }

    if (isDiscoverPage) {
        resultsEl.innerHTML = '<div class="search-odst-loading text-center py-4 text-[var(--text-dim)] text-sm">Loading...</div>';
        runOdstFetch(raw);
    } else {
        runLibraryOnly(raw);
        runOdstFetch(raw);
    }
}

function clear(options = {}) {
    const skipDiscoverRestore = options.skipDiscoverRestore === true;
    if (searchService.debounceTimer) {
        clearTimeout(searchService.debounceTimer);
        searchService.debounceTimer = null;
    }
    if (searchService.abortController) {
        searchService.abortController.abort();
        searchService.abortController = null;
    }
    searchService.hideSuggestions();
    updateDiscoverPanels();
    if (resultsEl) {
        if (isDiscoverPage) {
            if (skipDiscoverRestore) {
                resultsEl.innerHTML = '';
            } else {
                const rid = resultsEl.id;
                if (rid) {
                    void import('./discovery.js').then((m) => {
                        if (!m.initDiscovery) return;
                        const el = document.getElementById(rid);
                        if (!el) return;
                        const discoverActive = !!(window.DesktopUI?.currentView === 'discover' || window.UI?.currentView === 'discover');
                        if (!discoverActive) return;
                        m.initDiscovery(rid);
                    });
                } else {
                    resultsEl.innerHTML = '';
                }
            }
        } else {
            resultsEl.innerHTML = `<div class="text-center py-8 text-[var(--text-dim)]">${SEARCH_EMPTY_DEFAULT}</div>`;
        }
    }
    lastLibraryItems = [];
    lastOdstResults = [];
    if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = null;
    window._currentSearchTracks = null;
    if (typeof window !== 'undefined') {
        window._discoverSearchOdstItems = null;
        window._musicSearchPlaybackMerged = null;
    }
}

function isDiscoverViewActive() {
    const mobileDiscover = !!(window.UI && window.UI.currentView === 'discover');
    const desktopDiscover = !!(window.DesktopUI && window.DesktopUI.currentView === 'discover');
    return mobileDiscover || desktopDiscover || isDiscoverPage;
}

function destroy() {
    if (inputEl) {
        inputEl.removeEventListener('input', onInput);
    }
    if (typeof detachTypeahead === 'function') {
        detachTypeahead();
        detachTypeahead = null;
    }
    if (musicBtnEl && onMusicSourceClick) musicBtnEl.removeEventListener('click', onMusicSourceClick);
    if (youtubeBtnEl && onYoutubeSourceClick) youtubeBtnEl.removeEventListener('click', onYoutubeSourceClick);
    musicBtnEl = null;
    youtubeBtnEl = null;
    onMusicSourceClick = null;
    onYoutubeSourceClick = null;
    clear({ skipDiscoverRestore: true });
    inputEl = null;
    resultsEl = null;
}

function setSearchOdstSource(value) {
    if (value !== 'music' && value !== 'youtube' && value !== 'ytmusic') return;
    searchService.sourceMode = value;
    searchService.applyToggleUI('search-odst-music', 'search-odst-youtube');
    
    Haptics.tick();
    const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    if (raw) runOdstFetch(raw);
}

function init(opts = {}) {
    if (inputEl) {
        inputEl.removeEventListener('input', onInput);
    }
    if (typeof detachTypeahead === 'function') {
        detachTypeahead();
        detachTypeahead = null;
    }
    if (musicBtnEl && onMusicSourceClick) musicBtnEl.removeEventListener('click', onMusicSourceClick);
    if (youtubeBtnEl && onYoutubeSourceClick) youtubeBtnEl.removeEventListener('click', onYoutubeSourceClick);
    musicBtnEl = null;
    youtubeBtnEl = null;
    onMusicSourceClick = null;
    onYoutubeSourceClick = null;

    isMobile = opts.mobile !== false;
    isDesktop = !isMobile;
    const inputId = isMobile ? 'global-search-input' : 'desktop-global-search-input';
    const resultsId = opts.resultsContainerId || (isMobile ? 'discover-search-results' : 'desktop-discover-search-results');
    isDiscoverPage = (resultsId === 'discover-search-results' || resultsId === 'desktop-discover-search-results');
    inputEl = document.getElementById(inputId);
    resultsEl = document.getElementById(resultsId);
    if (!inputEl || !resultsEl) return;

    if (isDiscoverPage) {
        searchService.sourceMode = 'ytmusic';
    }

    clear();
    updateDiscoverPanels();

    musicBtnEl = document.getElementById('search-odst-music');
    youtubeBtnEl = document.getElementById('search-odst-youtube');
    if (musicBtnEl && youtubeBtnEl) {
        searchService.applyToggleUI('search-odst-music', 'search-odst-youtube');
        onMusicSourceClick = () => setSearchOdstSource('ytmusic');
        onYoutubeSourceClick = () => setSearchOdstSource('youtube');
        musicBtnEl.addEventListener('click', onMusicSourceClick);
        youtubeBtnEl.addEventListener('click', onYoutubeSourceClick);
    }

    inputEl.removeEventListener('input', onInput);
    inputEl.addEventListener('input', onInput);
    
    // ## Section: Typeahead support
    detachTypeahead = searchService.attach(inputEl, (val) => {
        if (val) runOdstFetch(val);
    }, {
        shouldSuggest: () => !isDiscoverPage && isDiscoverViewActive(),
        getLibraryMatches: (query) => {
            if (isDiscoverPage) return [];
            // Note: Use same filtering as main search
            const tracks = renderers.filterLibraryByQuery(store.state.library, query);
            return tracks.slice(0, 5);
        }
    });

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            inputEl.blur();
        }
    });
}

export const unifiedSearch = {
    init,
    clear,
    destroy,
    updateDiscoverPanels,
    playMusicSearchAtIndex,
    tryPlayUnifiedMusicSearch
};

/** Returns true if raw was treated as YouTube URL(s) and discover/search UI was updated. */
export async function runDiscoverUrlSearch(raw) {
    const parsed = searchService.parseUrlLines((raw || '').trim());
    if (parsed.mode !== 'url' || !parsed.accepted.length) return false;
    if (!resultsEl) return false;
    await runOdstFetchWithResolvedUrls(raw, parsed);
    return true;
}
