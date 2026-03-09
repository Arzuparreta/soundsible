/**
 * Unified Search: Library + ODST in one bar.
 * Library: instant filter on input. ODST: debounced so internet search runs after user pauses typing.
 * Link paste → add to download queue and clear input (only case we clear input).
 */
import { store } from './store.js';
import * as renderers from './renderers.js';
import { esc } from './renderers.js';
import { Resolver } from './resolver.js';
import { Haptics } from './haptics.js';
import { searchService } from './search_service.js';

const ODST_DEBOUNCE_MS = 150;

function escapeCssUrl(url) {
    if (!url) return '';
    return String(url).replace(/"/g, '%22').replace(/'/g, '%27');
}

let inputEl = null;
let resultsEl = null;
/** When init is called with resultsContainerId (Discover), we toggle content vs search results panels. */
let contentPanelEl = null;
let searchResultsPanelEl = null;
let lastLibraryItems = [];
let lastOdstResults = [];
let isMobile = true;
/** When false (desktop), library rows use hover-to-play style (delegation); no single-click play on row. */
let isDesktop = false;
/** When true, results are discover-only (ODST only, no library mix, no "ODST" label per row). */
let isDiscoverPage = false;

const SEARCH_EMPTY_DEFAULT = 'Search library and ODST...';
const SEARCH_EMPTY_DISCOVER = 'Search anything...';

function getEmptyMessage() {
    return isDiscoverPage ? SEARCH_EMPTY_DISCOVER : SEARCH_EMPTY_DEFAULT;
}

function updateDiscoverPanels(showSearchResults) {
    if (isDiscoverPage && isMobile) {
        const viewDiscover = document.getElementById('view-discover');
        const viewDiscoverSearch = document.getElementById('view-discover-search');
        if (!viewDiscover || !viewDiscoverSearch) return;

        const wantSearch = !!showSearchResults;
        const isSearchVisible = !viewDiscoverSearch.classList.contains('hidden');
        const isRecVisible = !viewDiscover.classList.contains('hidden');

        // If already in the right state (or both hidden during initialization), just set visibility with no animation.
        if ((wantSearch && isSearchVisible) || (!wantSearch && isRecVisible) || (!isSearchVisible && !isRecVisible)) {
            viewDiscoverSearch.classList.toggle('hidden', !wantSearch);
            viewDiscover.classList.toggle('hidden', wantSearch);
            viewDiscoverSearch.classList.remove('view-incoming', 'view-outgoing', 'view-from-right', 'view-from-left', 'view-from-top', 'view-to-top');
            viewDiscover.classList.remove('view-incoming', 'view-outgoing', 'view-from-right', 'view-from-left', 'view-from-top', 'view-to-top');
            return;
        }

        // Never run a second animation while the main view transition is active.
        const transitionEnd = (window.UI && typeof window.UI._viewTransitionEnd === 'number') ? window.UI._viewTransitionEnd : 0;
        if (transitionEnd && Date.now() < transitionEnd) {
            viewDiscoverSearch.classList.toggle('hidden', !wantSearch);
            viewDiscover.classList.toggle('hidden', wantSearch);
            return;
        }

        const outgoing = wantSearch ? viewDiscover : viewDiscoverSearch;
        const incoming = wantSearch ? viewDiscoverSearch : viewDiscover;

        if (wantSearch) {
            outgoing.classList.add('view-outgoing');
            incoming.classList.remove('hidden', 'view-warm-hidden-left', 'view-warm-hidden-right');
            incoming.classList.add('view-incoming', 'view-from-top');
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    incoming.classList.remove('view-from-top');
                });
            });
        } else {
            outgoing.classList.add('view-outgoing', 'view-to-top');
            incoming.classList.remove('hidden', 'view-warm-hidden-left', 'view-warm-hidden-right');
            incoming.classList.add('view-incoming');
        }

        setTimeout(() => {
            outgoing.classList.add('hidden');
            outgoing.classList.remove('view-outgoing', 'view-to-top');
            incoming.classList.remove('view-incoming');
        }, 500);
        return;
    }
    if (isDiscoverPage && !isMobile && contentPanelEl?.id === 'desktop-view-discover' && searchResultsPanelEl?.id === 'desktop-view-discover-search') {
        if (window.UI && window.UI.currentView !== 'discover') return;
        contentPanelEl.classList.toggle('active', !showSearchResults);
        searchResultsPanelEl.classList.toggle('active', !!showSearchResults);
        const innerResults = searchResultsPanelEl.querySelector('#desktop-discover-search-results');
        if (innerResults) innerResults.classList.toggle('hidden', !showSearchResults);
    } else {
        if (contentPanelEl) contentPanelEl.classList.toggle('hidden', !!showSearchResults);
        if (searchResultsPanelEl) searchResultsPanelEl.classList.toggle('hidden', !showSearchResults);
    }
}

function scoreLibrary(track, query) {
    const q = query.toLowerCase();
    const title = (track.title || '').toLowerCase();
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (artist.startsWith(q)) score += 80;
    else if (artist.includes(q)) score += 40;
    if (album.startsWith(q)) score += 60;
    else if (album.includes(q)) score += 30;
    return score;
}

function scoreOdst(item, query) {
    const q = query.toLowerCase();
    const title = (item.title || '').toLowerCase();
    const channel = (item.channel || '').toLowerCase();
    let score = 0;
    if (title.startsWith(q)) score += 100;
    else if (title.includes(q)) score += 50;
    if (channel.startsWith(q)) score += 80;
    else if (channel.includes(q)) score += 40;
    return score;
}

/** Same scoring idea as scoreLibrary: for artist name vs query. Used by Library mixed search. */
export function scoreArtist(artistName, query) {
    const q = (query || '').toLowerCase();
    const name = (artistName || '').toLowerCase();
    if (!q) return 0;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 40;
    return 0;
}

/** Shared comparator: score desc, then sortTitle asc. Same as Search tab merge order. */
export function mergeAndSortByScore(items) {
    return [...items].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.sortTitle || '').localeCompare(b.sortTitle || '');
    });
}

export { scoreLibrary };

function buildLibraryRowHtml(track) {
    const coverUrl = Resolver.getCoverUrl(track);
    const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
    const state = store.state;
    const isActive = state.currentTrack && state.currentTrack.id === track.id;
    const playOverlay = isDesktop ? renderers.desktopPlayOverlaySmallHtml() : '';
    return `
    <div class="search-result-item mb-2">
        <div class="text-[9px] font-black uppercase tracking-widest text-[var(--text-dim)] mb-0.5">Library</div>
        <div class="song-row relative z-10 flex items-center p-3 group ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer" data-id="${esc(track.id)}" data-source="library">
            <div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0${isDesktop ? ' group' : ''}">
                <div class="song-row-cover absolute inset-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)] shadow-lg" style="${coverStyle}" role="img" aria-label="Cover"></div>
                ${playOverlay}
            </div>
            <div class="ml-4 flex-1 truncate">
                <div class="song-title font-bold text-sm truncate text-[var(--text-main)]">${esc(track.title)}</div>
                <div class="text-[10px] text-[var(--text-dim)] font-bold truncate uppercase tracking-widest mt-0.5 font-mono">${esc(track.artist)}</div>
            </div>
            <div class="flex items-center ml-4">
                <div class="text-[9px] font-bold font-mono text-[var(--text-dim)] opacity-50 tracking-tighter">${renderers.formatTime(track.duration)}</div>
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
    const labelBlock = omitSourceLabel ? '' : `<div class="text-[9px] font-black uppercase tracking-widest text-[var(--text-dim)] mb-0.5">ODST</div>`;
    const thumbHtml = isDesktop
        ? `<div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0 group rounded-xl overflow-hidden">
            <div class="dl-result-thumb absolute inset-0 rounded-xl bg-cover bg-center border border-[var(--glass-border)]" style="${thumbStyle} background-color: var(--input-bg);"></div>
            ${renderers.desktopPlayOverlaySmallHtml()}
          </div>`
        : `<div class="w-12 h-12 rounded-lg flex-shrink-0 dl-result-thumb bg-cover bg-center" style="${thumbStyle} background-color: var(--input-bg);"></div>`;
    return `
    <div class="search-result-item mb-2">
        ${labelBlock}
        <div class="flex items-center gap-3 p-3 rounded-xl border border-[var(--input-border)] transition-colors group cursor-pointer hover:bg-[var(--surface-overlay)]" style="background-color: var(--input-bg);" data-video-id="${esc(r.id)}" data-source="odst">
            ${thumbHtml}
            <div class="flex-1 min-w-0">
                ${titleLine}
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-playback-queue w-10 h-10 rounded-full bg-[var(--surface-overlay)] hover:bg-[var(--accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" aria-label="Add to playback queue" title="Add to playback queue"><i class="fas fa-list-ul text-sm"></i></button>
            <button type="button" class="dl-add-one w-10 h-10 rounded-full bg-[var(--surface-overlay)] hover:bg-[var(--accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 opacity-100 transition-all" data-video-id="${esc(r.id)}" aria-label="${esc(dlAria)}"${tooltipAttrs}><i class="fas ${dlIcon} text-sm"></i></button>
        </div>
    </div>`;
}

function render(merged) {
    if (!resultsEl) return;
    const list = Array.isArray(merged) ? merged : [];
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

    // Spotify-like Grouping
    const libItems = list.filter(m => m.source === 'library');
    const odstItems = list.filter(m => m.source === 'odst');

    let html = '';
    
    if (libItems.length > 0) {
        html += `<div class="search-section-header px-1 pb-3 pt-2 text-xs font-black uppercase tracking-widest text-[var(--accent)] flex items-center gap-2">
                    <i class="fas fa-music text-[10px]"></i> From Library
                 </div>`;
        html += libItems.map(item => {
            // Build row without the inner "Library" label
            const track = item.track;
            const coverUrl = Resolver.getCoverUrl(track);
            const coverStyle = coverUrl ? `background-image: url(${escapeCssUrl(coverUrl)})` : '';
            const isActive = store.state.currentTrack && store.state.currentTrack.id === track.id;
            const playOverlay = isDesktop ? renderers.desktopPlayOverlaySmallHtml() : '';
            return `
            <div class="search-result-item mb-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <div class="song-row relative z-10 flex items-center p-3.5 group ${isActive ? 'bg-[var(--bg-selection)] border-[var(--glass-border)]' : 'bg-[var(--bg-card)] border-transparent'} rounded-2xl border active:scale-[0.98] transition-all cursor-pointer shadow-sm hover:shadow-md" data-id="${esc(track.id)}" data-source="library">
                    <div class="song-row-cover-wrapper relative w-12 h-12 flex-shrink-0${isDesktop ? ' group' : ''}">
                        <div class="song-row-cover absolute inset-0 rounded-xl overflow-hidden bg-cover bg-center border border-[var(--glass-border)]" style="${coverStyle}" role="img" aria-label="Cover"></div>
                        ${playOverlay}
                    </div>
                    <div class="ml-4 flex-1 truncate">
                        <div class="song-title font-bold text-sm truncate text-[var(--text-main)]">${esc(track.title)}</div>
                        <div class="text-[11px] text-[var(--text-dim)] font-medium truncate mt-0.5 opacity-80">${esc(track.artist)}</div>
                    </div>
                    <div class="flex items-center ml-4">
                        <div class="text-[10px] font-bold font-mono text-[var(--text-dim)] opacity-40">${renderers.formatTime(track.duration)}</div>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    if (odstItems.length > 0) {
        const sourceName = searchService.sourceMode === 'youtube' ? 'YouTube' : 'YouTube Music';
        const odstLabel = isDiscoverPage ? '' : `
            <div class="search-section-header px-1 pb-3 pt-6 text-xs font-black uppercase tracking-widest text-[var(--secondary)] flex items-center gap-2">
                <i class="fab fa-youtube text-[12px]"></i> Results from ${sourceName}
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
                window.playPreview(item);
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
        if (results === null) return; // Aborted
        
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
    updateDiscoverPanels(true);

    const parsed = searchService.parseUrlLines(raw);
    if (parsed.mode === 'url') {
        const Downloader = window.Downloader;
        if (Downloader && typeof Downloader.enqueueDirectUrls === 'function') {
            Downloader.enqueueDirectUrls(parsed.accepted.map((x) => x.normalized));
            if (inputEl) inputEl.value = '';
            if (typeof window.showToast === 'function') window.showToast('Link added to download queue');
            clear();
            return;
        }
    }
    
    if (isDiscoverPage) {
        resultsEl.innerHTML = '<div class="search-odst-loading text-center py-4 text-[var(--text-dim)] text-sm">Loading...</div>';
        runOdstFetch(raw);
    } else {
        runLibraryOnly(raw);
        runOdstFetch(raw);
    }
}

function onPaste() {
    setTimeout(() => {
        const raw = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
        if (!raw) return;
        const parsed = searchService.parseUrlLines(raw);
        if (parsed.mode === 'url') {
            const Downloader = window.Downloader;
            if (Downloader && typeof Downloader.enqueueDirectUrls === 'function') {
                Downloader.enqueueDirectUrls(parsed.accepted.map((x) => x.normalized));
                if (inputEl) inputEl.value = '';
                if (typeof window.showToast === 'function') window.showToast('Link added to download queue');
                clear();
            }
        }
    }, 0);
}

function clear() {
    if (searchService.debounceTimer) {
        clearTimeout(searchService.debounceTimer);
        searchService.debounceTimer = null;
    }
    if (searchService.abortController) {
        searchService.abortController.abort();
        searchService.abortController = null;
    }
    updateDiscoverPanels(false);
    if (resultsEl) resultsEl.innerHTML = `<div class="text-center py-8 text-[var(--text-dim)]">${getEmptyMessage()}</div>`;
    lastLibraryItems = [];
    lastOdstResults = [];
    if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = null;
    window._currentSearchTracks = null;
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
    isMobile = opts.mobile !== false;
    isDesktop = !isMobile;
    const inputId = isMobile ? 'global-search-input' : 'desktop-global-search-input';
    const resultsId = opts.resultsContainerId || (isMobile ? 'discover-search-results' : 'desktop-discover-search-results');
    isDiscoverPage = (resultsId === 'discover-search-results' || resultsId === 'desktop-discover-search-results');
    inputEl = document.getElementById(inputId);
    resultsEl = document.getElementById(resultsId);
    if (!inputEl || !resultsEl) return;

    if (isDiscoverPage && !isMobile) {
        contentPanelEl = document.getElementById('desktop-view-discover');
        searchResultsPanelEl = document.getElementById('desktop-view-discover-search');
    } else {
        contentPanelEl = document.getElementById(isMobile ? 'discover-content-panel' : 'desktop-discover-content-panel');
        searchResultsPanelEl = document.getElementById(resultsId);
    }

    if (isDiscoverPage && store.fetchLibraryYoutubeIds) store.fetchLibraryYoutubeIds();
    clear();
    resultsEl.innerHTML = `<div class="text-center py-8 text-[var(--text-dim)]">${getEmptyMessage()}</div>`;
    const hasInput = (inputEl.value || '').trim().length > 0;
    updateDiscoverPanels(!!hasInput);

    const musicBtn = document.getElementById('search-odst-music');
    const youtubeBtn = document.getElementById('search-odst-youtube');
    if (musicBtn && youtubeBtn) {
        searchService.applyToggleUI('search-odst-music', 'search-odst-youtube');
        musicBtn.addEventListener('click', () => setSearchOdstSource('ytmusic'));
        youtubeBtn.addEventListener('click', () => setSearchOdstSource('youtube'));
    }

    inputEl.removeEventListener('input', onInput);
    inputEl.removeEventListener('paste', onPaste);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('paste', onPaste);
    
    // Typeahead support
    searchService.attach(inputEl, (val) => {
        if (val) runOdstFetch(val);
    }, {
        getLibraryMatches: (query) => {
            if (isDiscoverPage) return [];
            // Use same filtering as main search
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
    updateDiscoverPanels
};
