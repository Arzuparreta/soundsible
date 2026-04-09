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
import { scoreLibrary, scoreArtist, mergeAndSortByScore, scoreOdst } from './search_scoring.js';

const ODST_DEBOUNCE_MS = 150;

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
        <div class="flex items-center gap-2.5 py-2 pl-2 pr-2 rounded-[var(--radius-omni-xs)] border border-[var(--glass-border)] transition-colors group cursor-pointer hover:bg-[var(--surface-overlay)] bg-[var(--surface-overlay)]" data-video-id="${esc(r.id)}" data-source="odst">
            ${thumbHtml}
            <div class="flex-1 min-w-0">
                ${titleLine}
                <div class="text-xs text-[var(--text-dim)] truncate">${esc(r.channel)} ${duration ? ' · ' + duration : ''}</div>
            </div>
            <button type="button" class="dl-playback-queue w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-[var(--input-bg)] hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 transition-colors" aria-label="Add to playback queue" title="Add to playback queue"><i class="fas fa-list-ul text-sm"></i></button>
            <button type="button" class="dl-add-one w-11 h-11 min-w-[44px] min-h-[44px] rounded-full bg-[var(--input-bg)] hover:bg-[var(--accent)] hover:text-[var(--text-on-accent)] text-[var(--text-main)] flex items-center justify-center flex-shrink-0 transition-colors" data-video-id="${esc(r.id)}" aria-label="${esc(dlAria)}"${tooltipAttrs}><i class="fas ${dlIcon} text-sm"></i></button>
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
    searchService.hideSuggestions();
    updateDiscoverPanels();
    if (resultsEl) {
        resultsEl.innerHTML = isDiscoverPage ? '' : `<div class="text-center py-8 text-[var(--text-dim)]">${SEARCH_EMPTY_DEFAULT}</div>`;
    }
    lastLibraryItems = [];
    lastOdstResults = [];
    if (typeof window.viewContext !== 'undefined') window.viewContext.searchTracks = null;
    window._currentSearchTracks = null;
}

function isDiscoverViewActive() {
    const mobileDiscover = !!(window.UI && window.UI.currentView === 'discover');
    const desktopDiscover = !!(window.DesktopUI && window.DesktopUI.currentView === 'discover');
    return mobileDiscover || desktopDiscover || isDiscoverPage;
}

function destroy() {
    if (inputEl) {
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('paste', onPaste);
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
    clear();
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
        inputEl.removeEventListener('paste', onPaste);
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
    inputEl.removeEventListener('paste', onPaste);
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('paste', onPaste);
    
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
    updateDiscoverPanels
};
